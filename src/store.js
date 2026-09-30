'use strict';
// 业务核心：导入、提议、采纳/驳回、冲突标记、发布合版、版本视图、异议引用、过期提议续提
const crypto = require('crypto');
const {
  codeLength,
  sliceCP,
  validateRange,
  overlaps,
  applyEdits,
  transformRange,
  transformRangeStrict,
} = require('./text');

// ---------- 解析 ----------
// 行首段号格式： 12. 文字 / 12、文字 / 12 制表符或空格 + 文字；单独一行 "12" 视为空文段。
function parseTranscript(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw badRequest('逐字稿内容为空（须为 UTF-8 文本）');
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const segments = [];
  const used = new Set();
  let auto = 1;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let m = raw.match(/^(\d+)[.、．]\s?(.*)$/) || raw.match(/^(\d+)[\t 　]+(.*)$/) || raw.match(/^(\d+)$/);
    if (m) {
      const seg = parseInt(m[1], 10);
      if (used.has(seg)) throw badRequest(`第 ${lineNo} 行：段号 ${seg} 重复，无法导入`);
      used.add(seg);
      segments.push({ seg, text: (m[2] || '').trim() });
    } else {
      const body = raw.trim();
      if (body === '') return; // 无段号空行：跳过
      while (used.has(auto)) auto++;
      used.add(auto);
      segments.push({ seg: auto, text: body });
      auto++;
    }
  });
  if (segments.length === 0) throw badRequest('未解析出任何段落：请使用“段号. 正文”格式或直接粘贴正文');
  return segments;
}

function badRequest(msg, code = 'BAD_REQUEST') {
  return Object.assign(new Error(msg), { status: 400, code });
}
function conflict(msg, code = 'CONFLICT') {
  return Object.assign(new Error(msg), { status: 409, code });
}
function forbidden(msg, code = 'FORBIDDEN') {
  return Object.assign(new Error(msg), { status: 403, code });
}
function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404, code: 'NOT_FOUND' });
}

// ---------- 读取辅助 ----------
function getDoc(db) {
  return db.prepare('SELECT * FROM doc_meta WHERE id = 1').get() || null;
}
function latestVersion(db) {
  return db.prepare('SELECT * FROM versions ORDER BY id DESC LIMIT 1').get() || null;
}
function segmentsOf(version) {
  return JSON.parse(version.segments_json);
}
function segIndex(segments, seg) {
  return segments.findIndex((s) => s.seg === seg);
}
function userLabel(u) {
  return u ? `${u.display_name}(${u.username})` : '';
}

function addDecision(db, { type, proposalId = null, versionId = null, actorId, reason = '', detail = {} }) {
  db.prepare(
    `INSERT INTO decisions (type, proposal_id, version_id, actor_id, reason, detail_json)
     VALUES (?,?,?,?,?,?)`
  ).run(type, proposalId, versionId, actorId, reason, JSON.stringify(detail));
}

// ---------- 导入 ----------
function importTranscript(db, actor, title, text) {
  if (getDoc(db)) throw conflict('逐字稿已导入并已发布初始版本，不能重复导入', 'ALREADY_INITIALIZED');
  const segments = parseTranscript(text);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO doc_meta (id, title, initialized) VALUES (1,?,1)').run(title || '未命名听证会');
    const r = db.prepare(
      'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
    ).run('初始导入', JSON.stringify(segments), actor.id);
    return r.lastInsertRowid;
  });
  return tx();
}

// ---------- 提议 ----------
// 替换文字禁止换行/分段符（CR、LF、U+2028、U+2029），段结构只能按既有段号修订
function replacementHasNewline(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

function createProposal(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法提交提议', 'NO_DOCUMENT');
  const base = latestVersion(db);
  const segments = segmentsOf(base);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const replacement = typeof body.replacement === 'string' ? body.replacement : null;
  const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (replacement === null) throw badRequest('替换文字必须为字符串（空串表示删除该范围）');
  if (replacementHasNewline(replacement)) throw badRequest('替换文字不能包含换行，段结构只能按既有段号修订');
  if (!basis) throw badRequest('修订依据不能为空');

  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：基版 v${base.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);

  const insert = db.transaction(() => {
    let status = 'pending';
    let conflictKind = 'stale_base';
    let conflictReason = '';
    // 与同一基版上已采纳（暂存待发布）的修订范围交叠 → 直接标记冲突，绝不覆盖
    const clash = db
      .prepare(
        `SELECT * FROM proposals
         WHERE status = 'adopted' AND base_version_id = ? AND seg = ?
           AND start_cp < ? AND ? < end_cp`
      )
      .get(base.id, seg, vr.end, vr.start);
    if (clash) {
      status = 'conflicted';
      conflictKind = 'range_overlap';
      conflictReason = `与已采纳提议 #${clash.id} 的范围 [${clash.start_cp},${clash.end_cp}) 交叠；不能覆盖其他修订，请改提互不重叠的范围`;
    }
    const r = db.prepare(
      `INSERT INTO proposals
        (seg, start_cp, end_cp, replacement, basis, original_excerpt, base_version_id,
         status, conflict_kind, conflict_reason, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(seg, start, end, replacement, basis, vr.excerpt, base.id, status, conflictKind, conflictReason, actor.id);
    const id = r.lastInsertRowid;
    if (status === 'conflicted') {
      addDecision(db, {
        type: 'conflict',
        proposalId: id,
        versionId: base.id,
        actorId: actor.id,
        reason: conflictReason,
      });
    }
    return id;
  });
  return insert();
}

// 复核：采纳。基版过期 / 与暂存区交叠 → 不改既有修订，将本提议标记为冲突并写明原因。
function adoptProposal(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已随 v${p.published_version_id} 发布，无需再采纳`, 'ALREADY_PUBLISHED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，不能采纳；如需修订请重新提交`, 'ALREADY_REJECTED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，不能采纳；请基于最新版本重新提交`, 'ALREADY_CONFLICTED');
  if (p.status === 'adopted') throw conflict(`提议 #${id} 已在暂存区，请勿重复采纳`, 'ALREADY_ADOPTED');

  const cur = latestVersion(db);
  const markConflict = db.transaction((reason, kind) => {
    db.prepare(`UPDATE proposals SET status='conflicted', conflict_kind=?, conflict_reason=? WHERE id=?`)
      .run(kind, reason, id);
    addDecision(db, { type: 'conflict', proposalId: id, versionId: cur.id, actorId: actor.id, reason });
  });

  if (p.base_version_id !== cur.id) {
    const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，当前已发布版本为 v${cur.id}；请基于 v${cur.id} 重新提交`;
    markConflict(reason, 'stale_base');
    return { markedConflict: true, reason };
  }
  const clash = db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=? AND id<>?
         AND start_cp < ? AND ? < end_cp`
    )
    .get(cur.id, p.seg, id, p.end_cp, p.start_cp);
  if (clash) {
    const reason = `范围交叠：提议 #${id} [${p.start_cp},${p.end_cp}) 与已采纳提议 #${clash.id} [${clash.start_cp},${clash.end_cp}) 冲突；不能覆盖其他修订`;
    markConflict(reason, 'range_overlap');
    return { markedConflict: true, reason };
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='adopted', decided_by=?, decided_at=datetime('now'), conflict_reason='' WHERE id=?`
    ).run(actor.id, id);
    addDecision(db, { type: 'adopt', proposalId: id, versionId: cur.id, actorId: actor.id });
  })();
  return { markedConflict: false };
}

function rejectProposal(db, actor, id, reason) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已发布，不能驳回`, 'ALREADY_PUBLISHED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，无需驳回`, 'ALREADY_CONFLICTED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，请勿重复操作`, 'ALREADY_REJECTED');
  const from = p.status; // pending | adopted
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='rejected', decided_by=?, decided_at=datetime('now'), conflict_reason=? WHERE id=?`
    ).run(actor.id, reason || '', id);
    addDecision(db, {
      type: 'reject',
      proposalId: id,
      versionId: latestVersion(db).id,
      actorId: actor.id,
      reason: reason || '',
      detail: { previousStatus: from },
    });
  })();
}

// ---------- 基版过期提议的续提 ----------
const RENEW_TOKEN_SECRET =
  process.env.RENEW_TOKEN_SECRET || 'hearing-revision-console.renew-preview.v1';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64urlJson(s) {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
}
function signRenewToken(payload) {
  const body = b64urlJson(payload);
  const sig = crypto.createHmac('sha256', RENEW_TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyRenewToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw badRequest('续提确认凭证无效，请重新预览', 'BAD_RENEW_TOKEN');
  }
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', RENEW_TOKEN_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig || '', 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw badRequest('续提确认凭证无效，请重新预览', 'BAD_RENEW_TOKEN');
  }
  try {
    return fromB64urlJson(body);
  } catch (_e) {
    throw badRequest('续提确认凭证无效，请重新预览', 'BAD_RENEW_TOKEN');
  }
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function stageFingerprint(db, versionId) {
  const stage = stageProposals(db, versionId);
  const material = stage
    .map((p) => `${p.id}:${p.seg}:${p.start_cp}:${p.end_cp}:${p.replacement}`)
    .join('\n');
  return sha256(`${versionId}\n${material}`);
}
function stageDecisionVersion(db) {
  // 任一采纳/驳回都会改变暂存区；即使之后又回到相同内容，也要求旧预览重新确认。
  return db.prepare(`SELECT COALESCE(MAX(id),0) AS v FROM decisions WHERE type IN ('adopt','reject')`).get().v;
}
function assertRenewableProposal(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.created_by !== actor.id) {
    throw forbidden(`无权续提：只有提议 #${id} 的提交者本人可以发起续提`, 'NOT_OWN_PROPOSAL');
  }
  if (p.status !== 'conflicted' || p.conflict_kind !== 'stale_base') {
    throw conflict(
      `提议 #${id} 不是“因发布导致基版已过期”的冲突提议，不能续提；请在当前正文手工选区提交`,
      'NOT_STALE_BASE'
    );
  }
  const already = db
    .prepare('SELECT id FROM proposals WHERE renewed_from_proposal_id=? ORDER BY id DESC LIMIT 1')
    .get(id);
  if (already) {
    throw conflict(`提议 #${id} 已生成续提提议 #${already.id}，请在新提议上继续处理`, 'ALREADY_RENEWED');
  }
  return p;
}
function publishedEdits(db, baseVersionId, publishedVersionId, seg) {
  return db
    .prepare(
      `SELECT id, seg, start_cp, end_cp, replacement
       FROM proposals
       WHERE status='published'
         AND base_version_id=? AND published_version_id=? AND seg=?
       ORDER BY start_cp, id`
    )
    .all(baseVersionId, publishedVersionId, seg)
    .map((e) => ({ id: e.id, start: e.start_cp, end: e.end_cp, replace: e.replacement }));
}

// 按从原基版到当前版的每一次发布逐步换算，绝不通过同文搜索猜测选区。
function mapStaleProposalRange(db, p) {
  const cur = latestVersion(db);
  if (!cur || cur.id <= p.base_version_id) {
    throw conflict(`提议 #${p.id} 当前没有可续提的新版本，请刷新后重试`, 'NOT_STALE_BASE');
  }
  const baseVersion = db.prepare('SELECT * FROM versions WHERE id=?').get(p.base_version_id);
  if (!baseVersion) throw conflict(`原基版 v${p.base_version_id} 不存在，无法续提`, 'PREVIEW_STALE');

  let baseSegments = segmentsOf(baseVersion);
  let idx = segIndex(baseSegments, p.seg);
  if (idx === -1) throw conflict('原选区所在段落缺失，无法自动续提；请在当前正文手工选区提交', 'PREVIEW_STALE');
  const baseExcerpt = sliceCP(baseSegments[idx].text, p.start_cp, p.end_cp);
  if (baseExcerpt !== p.original_excerpt) {
    throw conflict('原摘录与历史版本不一致，无法自动续提；请在当前正文手工选区提交', 'PREVIEW_STALE');
  }

  let start = p.start_cp;
  let end = p.end_cp;
  const path = [];
  for (let fromId = p.base_version_id; fromId < cur.id; fromId++) {
    const toId = fromId + 1;
    const toVersion = db.prepare('SELECT * FROM versions WHERE id=?').get(toId);
    if (!toVersion) throw conflict('原基版之后的发布历史不完整，无法自动续提', 'PREVIEW_STALE');
    const edits = publishedEdits(db, fromId, toId, p.seg);
    path.push({
      fromVersion: fromId,
      toVersion: toId,
      edits: edits.map((e) => ({
        id: e.id,
        seg: p.seg,
        start: e.start,
        end: e.end,
        replacement: e.replace,
      })),
    });
    const t = transformRangeStrict({ start, end }, edits);
    if (t.touched) {
      const at = t.touch;
      const reason = start === end
        ? `零长度选区的插入点 [${start},${start}) 已被 v${toId} 中提议 #${at.id} 的修订触及；请在当前正文手工定位插入点后提交`
        : `原选区 [${p.start_cp},${p.end_cp}) 已被 v${toId} 中提议 #${at.id} 的修订触及，不能自动续提；请在当前正文重新手工选区提交`;
      throw conflict(reason, 'SELECTION_TOUCHED');
    }
    start = t.start;
    end = t.end;
    const toSegments = segmentsOf(toVersion);
    const toIdx = segIndex(toSegments, p.seg);
    if (toIdx === -1) {
      throw conflict('目标段在后续版本中缺失，不能自动续提；请在当前正文手工选区提交', 'TARGET_SEG_MISSING');
    }
    try {
      validateRange(toSegments[toIdx].text, start, end);
    } catch (_e) {
      throw conflict('换算后的目标选区超出当前段长度，请在当前正文手工选区提交', 'PREVIEW_STALE');
    }
    baseSegments = toSegments;
    idx = toIdx;
  }

  const currentSegments = segmentsOf(cur);
  const curIdx = segIndex(currentSegments, p.seg);
  if (curIdx === -1) {
    throw conflict('目标段在当前正文中缺失，不能自动续提；请在当前正文手工选区提交', 'TARGET_SEG_MISSING');
  }
  validateRange(currentSegments[curIdx].text, start, end);
  const targetExcerpt = sliceCP(currentSegments[curIdx].text, start, end);
  if (targetExcerpt !== p.original_excerpt) {
    throw conflict('中途修订已改变原选区文字，不能自动续提；请在当前正文手工选区提交', 'SELECTION_TOUCHED');
  }
  return { currentVersion: cur, start, end, targetExcerpt, path };
}
function currentStageOverlap(db, versionId, seg, start, end) {
  return db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=?
         AND start_cp < ? AND ? < end_cp
       ORDER BY id LIMIT 1`
    )
    .get(versionId, seg, end, start);
}
function renewProposalPreview(db, actor, id) {
  const p = assertRenewableProposal(db, actor, id);
  const mapped = mapStaleProposalRange(db, p);
  const clash = currentStageOverlap(db, mapped.currentVersion.id, p.seg, mapped.start, mapped.end);
  const eligible = !clash;
  const blockedReason = clash
    ? `目标选区与当前暂存区中已采纳提议 #${clash.id} [${clash.start_cp},${clash.end_cp}) 交叠；请等待发布/驳回后重新预览，或手工选择不重叠范围`
    : '';
  const token = signRenewToken({
    pid: p.id,
    vid: mapped.currentVersion.id,
    seg: p.seg,
    start: mapped.start,
    end: mapped.end,
    excerptHash: sha256(mapped.targetExcerpt),
    sf: stageFingerprint(db, mapped.currentVersion.id),
    sv: stageDecisionVersion(db),
  });
  return {
    originalProposal: {
      id: p.id,
      seg: p.seg,
      start: p.start_cp,
      end: p.end_cp,
      replacement: p.replacement,
      basis: p.basis,
      excerpt: p.original_excerpt,
      baseVersionId: p.base_version_id,
      conflictReason: p.conflict_reason,
    },
    currentVersionId: mapped.currentVersion.id,
    target: {
      seg: p.seg,
      start: mapped.start,
      end: mapped.end,
      excerpt: mapped.targetExcerpt,
      length: codeLength(mapped.targetExcerpt),
    },
    eligible,
    blockedReason,
    path: mapped.path,
    token,
  };
}
function confirmRenewProposal(db, actor, token) {
  const payload = verifyRenewToken(token);
  const p = assertRenewableProposal(db, actor, payload.pid);
  const already = db
    .prepare('SELECT id FROM proposals WHERE renewed_from_proposal_id=? ORDER BY id DESC LIMIT 1')
    .get(p.id);
  if (already) {
    throw conflict(`原提议 #${p.id} 已生成续提提议 #${already.id}，请在新提议上继续处理`, 'ALREADY_RENEWED');
  }
  const cur = latestVersion(db);
  if (!cur || cur.id !== payload.vid) {
    throw conflict('预览后已发布新版本，凭证已失效；请重新预览', 'PREVIEW_STALE');
  }
  if (payload.sf !== stageFingerprint(db, cur.id) || payload.sv !== stageDecisionVersion(db)) {
    throw conflict('预览后发布暂存区已变化，凭证已失效；请重新预览', 'PREVIEW_STALE');
  }
  const mapped = mapStaleProposalRange(db, p);
  if (mapped.currentVersion.id !== payload.vid || p.seg !== payload.seg ||
      mapped.start !== payload.start || mapped.end !== payload.end ||
      sha256(mapped.targetExcerpt) !== payload.excerptHash) {
    throw conflict('预览内容与当前正文不一致，请重新预览', 'PREVIEW_STALE');
  }
  if (replacementHasNewline(p.replacement)) {
    throw badRequest('原替换文字包含换行，不能沿用，请在当前正文手工选区提交', 'BAD_RENEWAL');
  }
  if (!p.basis || !p.basis.trim()) {
    throw badRequest('原修订依据为空，不能沿用，请在当前正文手工选区提交', 'BAD_RENEWAL');
  }
  const clash = currentStageOverlap(db, cur.id, p.seg, mapped.start, mapped.end);
  if (clash) {
    throw conflict(
      `目标选区与当前已采纳提议 #${clash.id} [${clash.start_cp},${clash.end_cp}) 交叠；请重新预览或手工选择不重叠范围`,
      'TARGET_OVERLAPS_STAGE'
    );
  }

  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO proposals
        (seg, start_cp, end_cp, replacement, basis, original_excerpt, base_version_id,
         status, conflict_kind, conflict_reason, created_by, renewed_from_proposal_id)
       VALUES (?,?,?,?,?,?,?, 'pending', 'stale_base', '', ?, ?)`
    ).run(
      p.seg, mapped.start, mapped.end, p.replacement, p.basis, mapped.targetExcerpt,
      cur.id, actor.id, p.id
    );
    const newId = r.lastInsertRowid;
    addDecision(db, {
      type: 'renew',
      proposalId: p.id,
      versionId: cur.id,
      actorId: actor.id,
      reason: `续提为新提议 #${newId}（原提议 #${p.id} 基版 v${p.base_version_id}）`,
      detail: {
        newProposalId: newId,
        originalProposalId: p.id,
        seg: p.seg,
        originalStart: p.start_cp,
        originalEnd: p.end_cp,
        targetStart: mapped.start,
        targetEnd: mapped.end,
      },
    });
    return { id: newId, originalProposalId: p.id, target: { seg: p.seg, start: mapped.start, end: mapped.end } };
  })();
}

// ---------- 暂存预览 ----------
function stageProposals(db, versionId) {
  return db
    .prepare(`SELECT * FROM proposals WHERE status='adopted' AND base_version_id=? ORDER BY seg, start_cp`)
    .all(versionId);
}

function previewSegments(segments, stage) {
  const bySeg = new Map();
  for (const p of stage) {
    if (!bySeg.has(p.seg)) bySeg.set(p.seg, []);
    bySeg.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, id: p.id });
  }
  return segments.map((s) => {
    const edits = bySeg.get(s.seg);
    return edits ? { seg: s.seg, text: applyEdits(s.text, edits) } : s;
  });
}

// ---------- 发布 ----------
function publish(db, actor, note) {
  const cur = latestVersion(db);
  if (!cur) throw conflict('尚未导入逐字稿，无可发布内容', 'NO_DOCUMENT');
  const stage = stageProposals(db, cur.id);
  if (stage.length === 0) {
    throw conflict('重复发布被拒绝：暂存区中没有已采纳修订，发布必须包含修订并形成新版本', 'EMPTY_PUBLISH');
  }
  const segments = segmentsOf(cur);

  return db.transaction(() => {
    // 1) 合版：同一基版上互不重叠的采纳结果按段合并
    const newSegments = previewSegments(segments, stage);

    const vr = db.prepare(
      'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
    ).run((note || '').trim() || '发布修订', JSON.stringify(newSegments), actor.id);
    const newId = vr.lastInsertRowid;

    // 2) 已采纳提议落版
    const markPublished = db.prepare(
      `UPDATE proposals SET status='published', published_version_id=? WHERE id=?`
    );
    for (const p of stage) {
      markPublished.run(newId, p.id);
      addDecision(db, {
        type: 'publish',
        proposalId: p.id,
        versionId: newId,
        actorId: actor.id,
        reason: `随 v${newId} 发布`,
        detail: { seg: p.seg, start: p.start_cp, end: p.end_cp },
      });
    }

    // 3) 新版本形成后，所有仍待复核的提议基版均已过期 → 标记冲突
    //    （不能悄悄失效，也不能覆盖新修订；须由记录员基于新版本重新提交）
    const stale = db.prepare(`SELECT * FROM proposals WHERE status='pending'`).all();
    for (const p of stale) {
      const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，发布后当前版本为 v${newId}；请基于新版本重新提交`;
      db.prepare(`UPDATE proposals SET status='conflicted', conflict_kind='stale_base', conflict_reason=? WHERE id=?`)
        .run(reason, p.id);
      addDecision(db, { type: 'conflict', proposalId: p.id, versionId: newId, actorId: null, reason });
    }

    // 4) 异议锚点映射：相交即需重新定位，保留原文快照
    mapObjectionAnchors(db, newId, stage);

    // 5) 决议水位线：包含本次发布产生的全部决议
    const watermark = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM decisions').get().m;
    db.prepare('UPDATE versions SET decision_watermark=? WHERE id=?').run(watermark, newId);

    return newId;
  })();
}

function editsBySegment(stage) {
  const map = new Map();
  for (const p of stage) {
    if (!map.has(p.seg)) map.set(p.seg, []);
    map.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, proposalId: p.id });
  }
  return map;
}

function mapObjectionAnchors(db, newVersionId, stage) {
  const editsMap = editsBySegment(stage);
  // 以“当前最新锚点”为映射基准（异议可能已在当前版本被重新定位，旧版本锚点已过时），
  // 并以主表当前状态为准：已手动重新定位（active）的异议不得因复制旧锚点而回退为待重定位。
  const anchors = db
    .prepare(
      `SELECT a.objection_id, a.seg, a.start_cp, a.end_cp, o.status AS master_status
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       WHERE a.version_id = (
         SELECT MAX(version_id) FROM objection_anchors WHERE objection_id = a.objection_id
       )`
    )
    .all();
  const newSegments = segmentsOf(db.prepare('SELECT * FROM versions WHERE id=?').get(newVersionId));
  const lenOf = new Map(newSegments.map((s) => [s.seg, codeLength(s.text)]));

  const ins = db.prepare(
    `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
     VALUES (?,?,?,?,?,?)`
  );
  const updMaster = db.prepare(
    `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='needs_relocation' WHERE id=?`
  );
  for (const a of anchors) {
    const edits = editsMap.get(a.seg) || [];
    const t = transformRange({ start: a.start_cp, end: a.end_cp }, edits);
    // 主表 active 说明此前已人工确认过位置：只有本次修订再次相交才重新置为待重定位
    let status = a.master_status === 'active' ? 'active' : 'needs_relocation';
    if (t.affected) status = 'needs_relocation';
    const maxEnd = lenOf.get(a.seg) ?? t.end;
    t.start = Math.max(0, Math.min(t.start, maxEnd));
    t.end = Math.max(t.start, Math.min(t.end, maxEnd));
    ins.run(a.objection_id, newVersionId, a.seg, t.start, t.end, status);
    if (t.affected) updMaster.run(a.seg, t.start, t.end, a.objection_id);
  }
}

// ---------- 异议 ----------
function createObjection(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法添加异议', 'NO_DOCUMENT');
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (!note) throw badRequest('异议说明不能为空');
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('异议必须引用非空的原文范围');

  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO objections (seg, start_cp, end_cp, quoted_text, note, status, created_by, created_in_version)
       VALUES (?,?,?,?,?,'active',?,?)`
    ).run(seg, start, end, vr.excerpt, note, actor.id, ver.id);
    const id = r.lastInsertRowid;
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'create', '{}')`
    ).run(id, actor.id);
    return id;
  })();
}

function relocateObjection(db, actor, id, body) {
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  if (actor.role !== 'reviewer' && o.created_by !== actor.id) {
    const err = new Error('无权操作：只有异议提出者或复核员可以重新定位该异议');
    err.status = 403; err.code = 'FORBIDDEN'; throw err;
  }
  if (o.status !== 'needs_relocation') {
    throw conflict(`异议 #${id} 当前仍有效，无需重新定位`, 'NOT_DANGLING');
  }
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);
  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('重新定位必须选择非空范围');

  db.transaction(() => {
    db.prepare(
      `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='active' WHERE id=?`
    ).run(seg, start, end, id);
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')
       ON CONFLICT(objection_id, version_id) DO UPDATE SET
         seg=excluded.seg, start_cp=excluded.start_cp, end_cp=excluded.end_cp, status='active'`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json)
       VALUES (?,?, 'relocate', ?)`
    ).run(id, actor.id, JSON.stringify({ seg, start, end, version: ver.id, newExcerpt: vr.excerpt }));
  })();
}

// ---------- 视图组装 ----------
function listProposals(db) {
  return db
    .prepare(
      `SELECT p.*, u.display_name AS creator_name, u.username AS creator_user,
              b.id AS base_ver,
              rp.id AS renewed_from_id, rp.start_cp AS renewed_from_start,
              rp.end_cp AS renewed_from_end, rp.base_version_id AS renewed_from_base
       FROM proposals p
       JOIN users u ON u.id = p.created_by
       JOIN versions b ON b.id = p.base_version_id
       LEFT JOIN proposals rp ON rp.id = p.renewed_from_proposal_id
       ORDER BY p.id DESC`
    )
    .all();
}

function listObjections(db) {
  const ver = latestVersion(db);
  if (!ver) return [];
  return db
    .prepare(
      `SELECT o.id, o.seg, o.start_cp, o.end_cp, o.quoted_text, o.note, o.status,
              o.created_in_version, o.created_at,
              u.display_name AS creator_name, u.username AS creator_user,
              a.status AS anchor_status
       FROM objections o
       JOIN users u ON u.id = o.created_by
       JOIN objection_anchors a ON a.objection_id = o.id AND a.version_id = ?
       ORDER BY o.id DESC`
    )
    .all(ver.id);
}

function boothView(db) {
  const doc = getDoc(db);
  if (!doc) return { initialized: false };
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);
  const stage = stageProposals(db, ver.id);
  return {
    initialized: true,
    title: doc.title,
    currentVersion: { id: ver.id, note: ver.note, createdAt: ver.created_at },
    segments,
    stage: stage.map((p) => ({ id: p.id, seg: p.seg, start: p.start_cp, end: p.end_cp, replacement: p.replacement })),
    previewSegments: previewSegments(segments, stage),
    proposals: listProposals(db),
    objections: listObjections(db),
    versions: db
      .prepare(
        `SELECT v.id, v.note, v.created_at, u.display_name AS creator_name
         FROM versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.id`
      )
      .all(),
  };
}

function versionView(db, id) {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(id);
  if (!v) throw notFound(`版本 v${id} 不存在`);
  const decisions = db
    .prepare(
      `SELECT d.id, d.type, d.reason, d.created_at, d.proposal_id, d.version_id,
              u.display_name AS actor_name,
              p.seg, p.start_cp, p.end_cp, p.replacement, p.basis, p.original_excerpt,
              pu.display_name AS proposal_creator
       FROM decisions d
       LEFT JOIN users u ON u.id = d.actor_id
       LEFT JOIN proposals p ON p.id = d.proposal_id
       LEFT JOIN users pu ON pu.id = p.created_by
       WHERE d.id <= ?
       ORDER BY d.id`
    )
    .all(v.decision_watermark);
  const objections = db
    .prepare(
      `SELECT a.objection_id AS id, a.seg, a.start_cp, a.end_cp, a.status,
              o.quoted_text, o.note, o.created_in_version, o.created_at,
              u.display_name AS creator_name
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       JOIN users u ON u.id = o.created_by
       WHERE a.version_id = ?
       ORDER BY a.objection_id`
    )
    .all(v.id);
  return {
    id: v.id,
    note: v.note,
    createdAt: v.created_at,
    immutable: true,
    segments: segmentsOf(v),
    decisions,
    objections,
  };
}

module.exports = {
  parseTranscript,
  importTranscript,
  createProposal,
  renewProposalPreview,
  confirmRenewProposal,
  adoptProposal,
  rejectProposal,
  publish,
  createObjection,
  relocateObjection,
  boothView,
  versionView,
  stageProposals,
  previewSegments,
  getDoc,
  latestVersion,
  segmentsOf,
};
