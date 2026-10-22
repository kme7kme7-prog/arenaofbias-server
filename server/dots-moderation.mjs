// External content moderation by dots, a bot that reaches us over the public API.
// Scope moderation: list the dots queue, view a queued work (metadata, files,
// screenshots), approve, and reject with a reason. Scope capture:read: list works
// whose screenshots failed (capture_incomplete or no first screen). Scope cover:write: replace a
// work's cover. Scope preview:write: upload a 3D card preview (.sbox).
// Scope works:read: a safe view of one work outside the queue. Scope meta:write: declaration
// fields, not the task. Scope captures:write: replace a first or mobile JPEG.
// Every route below is the whole whitelist; the site dispatcher refuses tokens everywhere else.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { HttpError, clientIp, createRouter, fail, rateLimit, readBody, readJson, sendJson, streamFile } from './http.mjs';
import { sanitizeSbox, webgpuSignals } from './preview-uploads.mjs';
import { CAPTURE_SLOTS, checkCapture } from './work-captures.mjs';
import { checkCover } from './work-covers.mjs';
import { readWorkPreview } from './work-previews.mjs';

export const MODERATION_MODES = ['machine', 'dots', 'dots-review-only'];
const validMode = (value) => MODERATION_MODES.includes(value);

// MODERATION_MODE sets the default; an admin override in moderation_settings wins
// until it is cleared. Read per call so a change made by the CLI applies at once.
export function createModerationMode(db, config) {
  const configured = config.moderation?.mode ?? 'machine';
  if (!validMode(configured)) console.warn(`MODERATION_MODE=${configured} 无效，按 machine 处理`);
  const env = validMode(configured) ? configured : 'machine';
  const timeoutMs = config.moderation?.dotsTimeoutMs ?? 30 * 60_000;
  const read = db.prepare('SELECT mode, updated_at, updated_by FROM moderation_settings WHERE id = 1');
  const write = db.prepare(`INSERT INTO moderation_settings (id, mode, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const override = () => { const mode = read.get()?.mode; return validMode(mode) ? mode : null; };
  return {
    env,
    timeoutMs,
    get current() { return override() ?? env; },
    describe() {
      const row = read.get();
      return { mode: override() ?? env, env, override: override(), timeoutMs,
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null, updatedBy: row?.updated_by ?? null };
    },
    // null clears the override and returns to MODERATION_MODE.
    set(mode, actorName) {
      if (mode !== null && !validMode(mode)) fail(400, `审核模式只能是 ${MODERATION_MODES.join('、')} 或 null`, 'invalid_mode');
      write.run(mode, Date.now(), String(actorName || 'unknown'));
      return this.describe();
    },
  };
}

// Abilities a token may hold, each granted and withdrawn on its own.
export const TOKEN_SCOPES = ['moderation', 'capture:read', 'cover:write', 'works:read', 'meta:write', 'preview:write', 'captures:write'];
const META_FIELDS = ['title', 'summary', 'note', 'modelId', 'modelName', 'vendor', 'effort', 'promptVariant', 'harnessId', 'harnessOther', 'providerId', 'generationMode', 'humanIntervention'];
export function parseScopes(value) {
  const list = [...new Set(String(value ?? '').split(/[\s,]+/).filter(Boolean))];
  const unknown = list.filter((scope) => !TOKEN_SCOPES.includes(scope));
  if (unknown.length) fail(400, `未知权限：${unknown.join('、')}；可用 ${TOKEN_SCOPES.join('、')}`, 'invalid_scope');
  return TOKEN_SCOPES.filter((scope) => list.includes(scope));
}

// Stored values are read leniently: an unknown name grants nothing instead of failing.
const storedScopes = (value) => TOKEN_SCOPES.filter((scope) => String(value ?? '').split(/\s+/).includes(scope));

const TOKEN = /^aobd_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const hashOf = (token) => createHash('sha256').update(String(token)).digest();
const DUMMY = Buffer.alloc(32);

export function createModerationTokens(db) {
  const q = {
    insert: db.prepare('INSERT INTO moderation_tokens (id, label, token_hash, created_at, created_by, scopes) VALUES (?, ?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM moderation_tokens WHERE id = ?'),
    list: db.prepare('SELECT id, label, scopes, created_at, created_by, revoked_at, last_used_at FROM moderation_tokens ORDER BY created_at'),
    scopes: db.prepare('UPDATE moderation_tokens SET scopes = ? WHERE id = ? AND revoked_at IS NULL'),
    revoke: db.prepare('UPDATE moderation_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    touch: db.prepare('UPDATE moderation_tokens SET last_used_at = ? WHERE id = ?'),
  };
  return {
    // The plaintext is returned once and never stored.
    create(label, createdBy, scopes = ['moderation']) {
      const name = String(label ?? '').trim();
      if (!/^[\w.@:-]{1,60}$/.test(name)) fail(400, '标签只能用 1–60 个字母、数字或 _ . @ : -');
      const granted = parseScopes(Array.isArray(scopes) ? scopes.join(' ') : scopes);
      if (!granted.length) fail(400, '至少要给一项权限', 'invalid_scope');
      const id = randomBytes(6).toString('hex');
      const token = `aobd_${id}_${randomBytes(32).toString('base64url')}`;
      q.insert.run(id, name, hashOf(token).toString('hex'), Date.now(), String(createdBy || 'cli'), granted.join(' '));
      return { id, label: name, scopes: granted, token };
    },
    list() { return q.list.all().map((row) => ({ ...row, scopes: storedScopes(row.scopes) })); },
    // Grant or withdraw single scopes; an empty set leaves a token that can do nothing.
    setScopes(id, scopes) {
      const granted = parseScopes(Array.isArray(scopes) ? scopes.join(' ') : scopes);
      if (!q.scopes.run(granted.join(' '), String(id)).changes) fail(404, '令牌不存在或已吊销', 'not_found');
      return granted;
    },
    grant(id, scope) {
      const row = q.byId.get(String(id));
      return this.setScopes(id, [...storedScopes(row?.scopes), ...parseScopes(scope)]);
    },
    withdraw(id, scope) {
      const row = q.byId.get(String(id));
      const drop = parseScopes(scope);
      return this.setScopes(id, storedScopes(row?.scopes).filter((item) => !drop.includes(item)));
    },
    revoke(id) { return q.revoke.run(Date.now(), String(id)).changes > 0; },
    // Constant-time comparison of SHA-256 digests; unknown ids compare against a dummy.
    verify(token) {
      const match = TOKEN.exec(String(token ?? ''));
      const row = match ? q.byId.get(match[1]) : null;
      const expected = row ? Buffer.from(row.token_hash, 'hex') : DUMMY;
      const same = expected.length === 32 && timingSafeEqual(hashOf(token), expected);
      return same && row && !row.revoked_at ? row : null;
    },
    touch(id) { q.touch.run(Date.now(), id); },
  };
}

const IMAGE = /^[\w.-]{1,120}\.(?:jpe?g|png|webp)$/i;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function createDotsModeration({ db, config, library, mode, tokens, covers = null, previews = null, captureStore = null, coverBytes = 3 * 1024 * 1024,
  categoryOf = () => '', tasksIn = () => [], onChange = () => {} }) {
  const switches = { off: Boolean(config.moderation?.dotsApiOff), scopesOff: new Set(config.moderation?.dotsDisabledScopes ?? []) };
  const perToken = rateLimit(60_000, config.moderation?.dotsRequestsPerMin ?? 120, '请求太频繁，请稍后再试', 'rate_limited');
  const writes = rateLimit(60_000, config.moderation?.dotsWritesPerMin ?? 30, '写入太频繁，请稍后再试', 'rate_limited');
  const failures = rateLimit(60_000, 20, '鉴权失败次数过多，请稍后再试', 'rate_limited');
  const q = {
    updatedAt: db.prepare('SELECT updated_at FROM works WHERE id = ? AND deleted_at IS NULL'),
    overrideStamp: db.prepare('SELECT updated_at FROM work_overrides WHERE task_id = ? AND work_id = ?'),
    audit: db.prepare(`INSERT INTO moderation_token_audit (at, token_id, token_label, action, task_id, work_id, reason, ip, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    routed: db.prepare(`SELECT id FROM works WHERE deleted_at IS NULL
      AND json_extract(moderation, '$.route') IN ('dots', 'dots-review-only')
      AND json_extract(moderation, '$.status') IN ('pending', 'review')`),
    // Works whose screenshots failed: moderation.error is capture_incomplete, or the
    // published captures JSON has no desktop first screen. works.cover (the author's own
    // optional cover) is not a criterion. Keyset paging on the primary key, so the scan
    // walks the existing id index and stops at the page size; no extra index needed.
    // Covers named cover-* only come from a manual replacement (work-covers.mjs).
    captureGaps: Object.fromEntries(Object.entries({ all: '', exclude: "AND COALESCE(cover, '') NOT LIKE 'cover-%'", only: "AND cover LIKE 'cover-%'" })
      .map(([key, manual]) => [key, db.prepare(`SELECT id FROM works WHERE id > ? AND deleted_at IS NULL
        AND (json_extract(moderation, '$.error') = 'capture_incomplete' OR COALESCE(json_extract(captures, '$.first'), '') = '')
        ${manual} ORDER BY id LIMIT ?`)])),
    // Same list limited to the tasks of one question category (task ids as a JSON array).
    captureGapsIn: Object.fromEntries(Object.entries({ all: '', exclude: "AND COALESCE(cover, '') NOT LIKE 'cover-%'", only: "AND cover LIKE 'cover-%'" })
      .map(([key, manual]) => [key, db.prepare(`SELECT id FROM works WHERE id > ? AND deleted_at IS NULL
        AND task_id IN (SELECT value FROM json_each(?))
        AND (json_extract(moderation, '$.error') = 'capture_incomplete' OR COALESCE(json_extract(captures, '$.first'), '') = '')
        ${manual} ORDER BY id LIMIT ?`)])),
  };

  // Where a work stands for dots, or null when dots has no say over it.
  // dots: a new submission held for dots; after the deadline the machine may also
  // decide, and whichever finishes first is kept. review-only: the machine sent it
  // to people and dots may decide until the deadline; afterwards only people do.
  function stage(work, now = Date.now()) {
    const moderation = work?.moderation;
    if (!moderation || work.curated) return null;
    const deadline = (moderation.at ?? 0) + mode.timeoutMs;
    if (moderation.status === 'pending' && moderation.route === 'dots') return { kind: 'dots', deadline, expired: now >= deadline };
    if (moderation.status === 'review' && moderation.route === 'dots-review-only' && now < deadline) return { kind: 'review-only', deadline, expired: false };
    return null;
  }
  // Listed: dots items while dots mode holds them, review-only items while not in machine mode.
  function listed(work, now) {
    const where = stage(work, now);
    if (!where) return null;
    if (where.kind === 'dots') return mode.current === 'dots' && !where.expired ? where : null;
    return mode.current !== 'machine' ? where : null;
  }
  const base = (work) => `/api/dots/moderation/works/${encodeURIComponent(work.taskId)}/${encodeURIComponent(work.id)}`;
  function images(work) {
    try { return readdirSync(join(library.mediaDir, work.id)).filter((name) => IMAGE.test(name)).sort(); } catch { return []; }
  }
  function summary(work, where) {
    const machine = where.kind === 'review-only'
      ? { reason: work.moderation.reason ?? '', categories: work.moderation.categories ?? [], error: work.moderation.error ?? null, signals: work.moderation.signals ?? [] }
      : null;
    return {
      task: work.taskId, id: work.id, stage: where.kind, title: work.title, summary: work.summary, note: work.note,
      model: work.modelName, vendor: work.vendor, effort: work.effort, tool: work.tool,
      generationMode: work.generationMode, humanIntervention: work.humanIntervention, author: work.ownerName,
      submittedAt: iso(work.createdAt), queuedAt: iso(work.moderation.at), deadline: iso(where.deadline), machine,
      version: versionOf(work.moderation),
      entry: work.entry, url: base(work),
    };
  }
  function files(work) {
    const out = [];
    let entries = [];
    try { entries = readdirSync(work.dir, { recursive: true }).map(String).sort(); } catch { return out; }
    for (const name of entries) {
      if (out.length >= 2000) break;
      try {
        const info = statSync(join(work.dir, name));
        if (info.isFile()) out.push({ path: name.split(sep).join('/'), bytes: info.size });
      } catch { /* vanished */ }
    }
    return out;
  }
  // A path inside the stored upload, after resolving symlinks.
  function fileOf(work, path) {
    const value = String(path ?? '');
    if (!value || value.includes('\0')) fail(400, '缺少 path 参数', 'invalid_path');
    try {
      const root = realpathSync(work.dir);
      const file = realpathSync(resolve(root, value));
      const inside = relative(root, file);
      if (!inside || inside.startsWith('..') || resolve(root, inside) !== file) fail(404, '文件不存在', 'not_found');
      const info = statSync(file);
      if (!info.isFile()) fail(404, '文件不存在', 'not_found');
      return { file, size: info.size };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(404, '文件不存在', 'not_found');
    }
  }
  // Viewable: only works dots may still decide.
  // Identifies one queued version of a work; a new author edit or machine result changes it.
  const versionOf = (moderation) => `${moderation.revision ?? ''}.${moderation.at ?? ''}`;
  function queued(params) {
    const work = library.work(params.task, params.id);
    if (!work || work.curated || !stage(work)) fail(404, '这件作品不在 dots 审核队列中', 'not_in_queue');
    return work;
  }
  function decide(token, params, status, reason, version) {
    const actor = { id: `dots:${token.id}`, name: `dots:${token.label}` };
    for (let attempt = 0; attempt < 2; attempt++) {
      const work = library.work(params.task, params.id);
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const current = work.moderation;
      // Repeating the same decision is a no-op that answers like the first time.
      if (current.source === 'dots' && current.status === status) return { applied: false, task: work.taskId, id: work.id, status };
      const where = stage(work);
      // The author changed the work after dots looked at it: look again.
      if (where && version != null && String(version) !== versionOf(current)) fail(409, '作品已更新，请重新查看后再决定', 'stale');
      if (!where) {
        const error = new HttpError(409, '这件作品已由其他途径处理或已超出 dots 审核时限', 'not_in_queue');
        error.details = { current: { status: current.status, source: current.source ?? null } };
        throw error;
      }
      const result = { status, reason, source: 'dots', reviewer: actor.name, tokenId: token.id, route: current.route,
        ...(where.kind === 'review-only' ? { machine: { reason: current.reason ?? '', categories: current.categories ?? [], error: current.error ?? null } } : {}) };
      // Conditional on the row being unchanged: a machine or human result that lands first wins.
      if (library.finishModeration(work, result, actor)) { onChange(); return { applied: true, task: work.taskId, id: work.id, status }; }
    }
    fail(409, '作品状态刚刚发生变化，请重新获取队列', 'conflict');
  }

  const router = createRouter();
  router.on('GET', '/api/dots/moderation/queue', { scope: 'moderation', action: 'list', run: () => {
    const now = Date.now();
    const items = [];
    for (const { id } of q.routed.all()) {
      const work = library.uploadById(id);
      const where = work && listed(work, now);
      if (where) items.push(summary(work, where));
    }
    items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
    return { mode: mode.current, timeoutMs: mode.timeoutMs, items };
  } });
  router.on('GET', '/api/dots/moderation/works/:task/:id', { scope: 'moderation', action: 'view', run: ({ params }) => {
    const work = queued(params);
    return { work: { ...summary(work, stage(work)), files: files(work),
      images: images(work).map((name) => ({ name, url: `${base(work)}/images/${encodeURIComponent(name)}` })) } };
  } });
  router.on('GET', '/api/dots/moderation/works/:task/:id/images/:name', { scope: 'moderation', action: 'view-image', run: async ({ req, res, params }) => {
    const work = queued(params);
    let name = '';
    try { name = decodeURIComponent(params.name); } catch { /* rejected below */ }
    if (!IMAGE.test(name) || !images(work).includes(name)) fail(404, '截图不存在', 'not_found');
    const file = join(library.mediaDir, work.id, name);
    await streamFile(req, res, { file, size: statSync(file).size }, { 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  } });
  // Raw bytes for inspection only: never rendered on the API origin.
  router.on('GET', '/api/dots/moderation/works/:task/:id/file', { scope: 'moderation', action: 'view-file', run: async ({ req, res, params, url }) => {
    const work = queued(params);
    const found = fileOf(work, url.searchParams.get('path'));
    await streamFile(req, res, found, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  } });
  router.on('POST', '/api/dots/moderation/works/:task/:id/approve', { scope: 'moderation', action: 'approve', run: async ({ req, params, token, note }) => {
    const body = await readJson(req, 8 * 1024);
    const reason = note.reason = String(body.reason ?? '').trim().slice(0, 500) || 'dots 审核通过';
    return { result: decide(token, params, 'approved', reason, body.version) };
  } });
  router.on('POST', '/api/dots/moderation/works/:task/:id/reject', { scope: 'moderation', action: 'reject', run: async ({ req, params, token, note }) => {
    const body = await readJson(req, 8 * 1024);
    const reason = note.reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (!reason) fail(400, '打回必须填写理由', 'reason_required');
    return { result: decide(token, params, 'rejected', reason, body.version) };
  } });
  // Only what is needed to pick a cover job: no author, note, contact or file data.
  router.on('GET', '/api/dots/captures/failed', { scope: 'capture:read', action: 'list-capture-gaps', run: ({ url }) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
    const manualCover = url.searchParams.get('manualCover') ?? 'all';
    if (!Object.hasOwn(q.captureGaps, manualCover)) fail(400, 'manualCover 只能是 all、exclude 或 only', 'invalid_filter');
    let after = '';
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      after = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!/^[\w-]{1,64}$/.test(after)) fail(400, 'cursor 无效', 'invalid_cursor');
    }
    // category is the question's category; 3d / modeling are aliases of 建模 (三维建模).
    const asked = url.searchParams.get('category');
    const category = asked == null || asked === '' ? null : ({ '3d': '建模', modeling: '建模', 三维建模: '建模' }[asked] ?? asked);
    const rows = category == null ? q.captureGaps[manualCover].all(after, limit + 1)
      : q.captureGapsIn[manualCover].all(after, JSON.stringify(tasksIn(category)), limit + 1);
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const work = library.uploadById(row.id);
      if (!work || work.curated) continue;
      const captures = work.captures ?? {};
      items.push({ task: work.taskId, id: work.id, title: work.title, status: work.moderation.status,
        reasons: [...(work.moderation.error === 'capture_incomplete' ? ['capture_incomplete'] : []), ...(captures.first ? [] : ['no_first_capture'])],
        screenshots: { first: Boolean(captures.first), mobile: Boolean(captures.mobile) },
        hasCover: Boolean(work.cover), hasManualCover: /^cover-/.test(work.cover ?? ''),
        submittedAt: iso(work.createdAt),
        ...(category != null ? { category: categoryOf(work.taskId) || '', ...webgpuOf(work) } : {}) });
    }
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items, nextCursor: last ? Buffer.from(last.id).toString('base64url') : null };
  } });
  // Only computed when a category is asked for, so the plain list keeps its old shape.
  function webgpuOf(work) {
    const signals = webgpuSignals(work);
    return { webgpu: signals.length > 0, webgpuSignals: signals };
  }
  // Body is the raw .sbox. Only the preview files change; the poster is the manual cover.
  router.on('PUT', '/api/dots/works/:task/:id/preview', { scope: 'preview:write', action: 'preview-replace', run: async ({ req, params, token }) => {
    if (!previews) fail(404, '接口不存在', 'not_found');
    const work = library.work(params.task, params.id);
    if (!work || work.curated || !library.uploadById(work.id)) fail(404, '作品不存在', 'not_found');
    const { buffer, stats } = sanitizeSbox(await readBody(req, 2 * 1024 * 1024));
    const result = previews.replace(work, buffer, { id: `dots:${token.id}`, name: `dots:${token.label}` }, { source: 'dots', ...stats });
    onChange();
    return { result: { task: work.taskId, id: work.id, ...result, stats } };
  } });
  // Body is the raw image. Only works.cover changes: never the files, model or labels.
  router.on('PUT', '/api/dots/works/:task/:id/cover', { scope: 'cover:write', action: 'cover-replace', run: async ({ req, params, token }) => {
    if (!covers) fail(404, '接口不存在', 'not_found');
    const work = library.work(params.task, params.id);
    if (!work || work.curated || !library.uploadById(work.id)) fail(404, '作品不存在', 'not_found');
    const buffer = await readBody(req, coverBytes);
    const image = checkCover(buffer, coverBytes);
    const result = covers.replace(work, buffer, image, { id: `dots:${token.id}`, name: `dots:${token.label}` }, 'dots');
    onChange();
    return { result: { task: work.taskId, id: work.id, ...result, type: image.mime, width: image.width, height: image.height } };
  } });
  const actorOf = (token) => ({ id: `dots:${token.id}`, name: `dots:${token.label}` });
  const stampOf = (work) => work.curated
    ? (q.overrideStamp.get(work.taskId, work.id)?.updated_at ?? null)
    : (q.updatedAt.get(work.id)?.updated_at ?? null);
  const uploadWork = (params) => {
    const work = library.work(params.task, params.id);
    if (!work || (!work.curated && !library.uploadById(work.id))) fail(404, '作品不存在', 'not_found');
    return work;
  };
  // Declaration and media pointers. No email, IP, content key, scene URL or digest.
  function safeWork(work, { files: listFiles = false } = {}) {
    const captures = work.captures ?? {};
    const media = (name) => (name ? `media/${work.id}/${name}` : null);
    return {
      task: work.taskId, id: work.id, title: work.title ?? '', summary: work.summary ?? '', note: work.note ?? '',
      modelId: work.modelId ?? null, modelName: work.modelName ?? '', vendor: work.vendor ?? '', effort: work.effort ?? '',
      harnessId: work.harnessId ?? null, harnessOther: work.harnessOther ?? '', providerId: work.providerId ?? null,
      generationMode: work.generationMode ?? '', humanIntervention: work.humanIntervention ?? '',
      promptVariant: work.promptVariant ?? '', tool: work.tool ?? '',
      status: work.status ?? null,
      moderationStatus: work.curated ? (work.moderation?.status ?? 'approved') : (work.moderation?.status ?? null),
      moderationError: work.curated ? null : (work.moderation?.error ?? null),
      cover: work.curated ? (work.cover ?? null) : media(work.cover),
      hasManualCover: /^cover-/.test(work.cover ?? ''),
      captures: work.curated ? null : { first: media(captures.first), mobile: media(captures.mobile) },
      preview: work.curated ? null : (readWorkPreview(library.mediaDir, work) ?? null),
      author: work.ownerName ?? null,
      submittedAt: work.curated ? (work.addedAt ?? null) : iso(work.createdAt),
      updatedAt: stampOf(work),
      curated: Boolean(work.curated),
      ...(work.curated ? {} : { fileCount: work.files ?? 0, bytes: work.bytes ?? 0 }),
      ...(listFiles && !work.curated ? { files: files(work) } : {}),
    };
  }
  router.on('GET', '/api/dots/works/:task/:id', { scope: 'works:read', action: 'work-get', run: ({ params, url }) => {
    const work = uploadWork(params);
    return { work: safeWork(work, { files: url.searchParams.get('files') === '1' }) };
  } });
  // Admin-style partial update. Task moves, faces and review stay closed. No re-queue
  // unless the body asks for it, and only when the moderated text actually changes.
  router.on('PATCH', '/api/dots/works/:task/:id/meta', { scope: 'meta:write', action: 'meta', run: async ({ req, params, token, note }) => {
    const body = await readJson(req, 8 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请求体须为 JSON 对象', 'invalid_body');
    if (Object.hasOwn(body, 'task')) fail(400, '不能通过这个接口改归属题目', 'task_forbidden');
    const unknown = Object.keys(body).filter((key) => !META_FIELDS.includes(key) && key !== 'resubmitModeration' && key !== 'updatedAt');
    if (unknown.length) fail(400, `不能修改：${unknown.join('、')}`, 'invalid_field');
    if (Object.hasOwn(body, 'resubmitModeration') && typeof body.resubmitModeration !== 'boolean') fail(400, 'resubmitModeration 须为布尔值', 'invalid_field');
    if (Object.hasOwn(body, 'updatedAt') && body.updatedAt !== null && !Number.isInteger(body.updatedAt)) fail(400, 'updatedAt 无效', 'invalid_field');
    const fields = Object.fromEntries(META_FIELDS.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
    if (!Object.keys(fields).length) fail(400, '没有可修改的内容', 'invalid_field');
    const work = uploadWork(params);
    const stamp = stampOf(work);
    if (Object.hasOwn(body, 'updatedAt') && body.updatedAt !== stamp) fail(409, '作品信息刚刚被修改，请重新获取后再试', 'conflict');
    if (work.curated && body.resubmitModeration) fail(409, '数据包作品不能重新送审', 'not_resubmittable');
    const before = work.moderation?.revision ?? null;
    note.reason = [...Object.keys(fields).sort(), ...(body.resubmitModeration ? ['resubmit'] : [])].join(',');
    library.setMeta(actorOf(token), work.taskId, work.id, fields, {
      asStaff: true, resubmitModeration: body.resubmitModeration === true, guard: true, expectUpdatedAt: stamp,
    });
    onChange();
    const next = library.work(work.taskId, work.id);
    return { work: safeWork(next), resubmitted: Boolean(body.resubmitModeration) && !work.curated && (next.moderation?.revision ?? null) !== before };
  } });
  // JPEG only, one slot. Does not clear capture_incomplete or any other moderation field.
  router.on('PUT', '/api/dots/works/:task/:id/captures/:slot', { scope: 'captures:write', action: 'capture-replace', run: async ({ req, params, token, note }) => {
    if (!captureStore) fail(404, '接口不存在', 'not_found');
    if (!CAPTURE_SLOTS.includes(params.slot)) fail(400, '截图位置只能是 first 或 mobile', 'invalid_slot');
    const work = library.work(params.task, params.id);
    if (!work || work.curated || !library.uploadById(work.id)) fail(404, '作品不存在', 'not_found');
    const buffer = await readBody(req, coverBytes);
    const image = checkCapture(buffer, coverBytes);
    note.reason = params.slot;
    const result = captureStore.replace(work, params.slot, buffer, image, actorOf(token));
    onChange();
    return { result: { task: work.taskId, id: work.id, ...result, type: image.mime, width: image.width, height: image.height } };
  } });

  return {
    async handle(req, res, url) {
      const ip = clientIp(req, config.trustProxy);
      let token = null, action = 'unknown', params = {}, reason = null;
      try {
        if (switches.off) fail(503, 'dots 接口已被运维临时关闭', 'dots_disabled');
        const header = String(req.headers.authorization ?? '');
        const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
        if (!bearer) { failures(ip); fail(401, '缺少审核令牌', 'unauthorized'); }
        token = tokens.verify(bearer);
        if (!token) { failures(ip); fail(401, '审核令牌无效或已吊销', 'unauthorized'); }
        perToken(token.id);
        const route = router.match(req.method, url.pathname);
        if (!route) fail(404, '接口不存在', 'not_found');
        if (route.methodNotAllowed) fail(405, '不支持这个操作', 'method_not_allowed');
        ({ action } = route.handler);
        if (switches.scopesOff.has(route.handler.scope)) fail(503, '这项能力已被运维临时关闭', 'scope_disabled');
        if (!storedScopes(token.scopes).includes(route.handler.scope)) fail(403, `令牌没有 ${route.handler.scope} 权限`, 'scope_required');
        if (req.method === 'PUT' || req.method === 'PATCH') writes(token.id);
        params = route.params;
        tokens.touch(token.id);
        const note = {};
        let outcome;
        try { outcome = await route.handler.run({ req, res, url, params, token, note }); }
        finally { reason = note.reason ?? null; }
        q.audit.run(Date.now(), token.id, token.label, action, params.task ?? null, params.id ?? null, reason, ip, 'ok');
        if (!res.headersSent) return sendJson(res, 200, outcome && Object.hasOwn(outcome, 'result') ? outcome.result : outcome);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (token) q.audit.run(Date.now(), token.id, token.label, action, params.task ?? null, params.id ?? null, reason, ip, `error:${status}:${error.code || ''}`);
        if (res.headersSent) return res.destroy();
        if (!(error instanceof HttpError)) { console.error(error); return sendJson(res, 500, { error: '服务器出错了，请稍后再试' }); }
        return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ?? {}),
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }, {
          ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
          ...(error.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
      }
    },
    stage,
  };
}
