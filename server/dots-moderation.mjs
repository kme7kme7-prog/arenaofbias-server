// External content moderation by dots, a bot that reaches us over the public API.
// A dots token opens exactly four abilities: list the dots queue, view a queued work
// (metadata, files, screenshots), approve, and reject with a reason. Every route
// below is the whole whitelist; the site dispatcher refuses tokens everywhere else.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { HttpError, clientIp, createRouter, fail, rateLimit, readJson, sendJson, streamFile } from './http.mjs';

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

const TOKEN = /^aobd_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const hashOf = (token) => createHash('sha256').update(String(token)).digest();
const DUMMY = Buffer.alloc(32);

export function createModerationTokens(db) {
  const q = {
    insert: db.prepare('INSERT INTO moderation_tokens (id, label, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM moderation_tokens WHERE id = ?'),
    list: db.prepare('SELECT id, label, created_at, created_by, revoked_at, last_used_at FROM moderation_tokens ORDER BY created_at'),
    revoke: db.prepare('UPDATE moderation_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    touch: db.prepare('UPDATE moderation_tokens SET last_used_at = ? WHERE id = ?'),
  };
  return {
    // The plaintext is returned once and never stored.
    create(label, createdBy) {
      const name = String(label ?? '').trim();
      if (!/^[\w.@:-]{1,60}$/.test(name)) fail(400, '标签只能用 1–60 个字母、数字或 _ . @ : -');
      const id = randomBytes(6).toString('hex');
      const token = `aobd_${id}_${randomBytes(32).toString('base64url')}`;
      q.insert.run(id, name, hashOf(token).toString('hex'), Date.now(), String(createdBy || 'cli'));
      return { id, label: name, token };
    },
    list() { return q.list.all(); },
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

export function createDotsModeration({ db, config, library, mode, tokens, onChange = () => {} }) {
  const perToken = rateLimit(60_000, config.moderation?.dotsRequestsPerMin ?? 120, '请求太频繁，请稍后再试', 'rate_limited');
  const failures = rateLimit(60_000, 20, '鉴权失败次数过多，请稍后再试', 'rate_limited');
  const q = {
    audit: db.prepare(`INSERT INTO moderation_token_audit (at, token_id, token_label, action, task_id, work_id, reason, ip, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    routed: db.prepare(`SELECT id FROM works WHERE deleted_at IS NULL
      AND json_extract(moderation, '$.route') IN ('dots', 'dots-review-only')
      AND json_extract(moderation, '$.status') IN ('pending', 'review')`),
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
  router.on('GET', '/api/dots/moderation/queue', { action: 'list', run: () => {
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
  router.on('GET', '/api/dots/moderation/works/:task/:id', { action: 'view', run: ({ params }) => {
    const work = queued(params);
    return { work: { ...summary(work, stage(work)), files: files(work),
      images: images(work).map((name) => ({ name, url: `${base(work)}/images/${encodeURIComponent(name)}` })) } };
  } });
  router.on('GET', '/api/dots/moderation/works/:task/:id/images/:name', { action: 'view-image', run: async ({ req, res, params }) => {
    const work = queued(params);
    let name = '';
    try { name = decodeURIComponent(params.name); } catch { /* rejected below */ }
    if (!IMAGE.test(name) || !images(work).includes(name)) fail(404, '截图不存在', 'not_found');
    const file = join(library.mediaDir, work.id, name);
    await streamFile(req, res, { file, size: statSync(file).size }, { 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  } });
  // Raw bytes for inspection only: never rendered on the API origin.
  router.on('GET', '/api/dots/moderation/works/:task/:id/file', { action: 'view-file', run: async ({ req, res, params, url }) => {
    const work = queued(params);
    const found = fileOf(work, url.searchParams.get('path'));
    await streamFile(req, res, found, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  } });
  router.on('POST', '/api/dots/moderation/works/:task/:id/approve', { action: 'approve', run: async ({ req, params, token, note }) => {
    const body = await readJson(req, 8 * 1024);
    const reason = note.reason = String(body.reason ?? '').trim().slice(0, 500) || 'dots 审核通过';
    return { result: decide(token, params, 'approved', reason, body.version) };
  } });
  router.on('POST', '/api/dots/moderation/works/:task/:id/reject', { action: 'reject', run: async ({ req, params, token, note }) => {
    const body = await readJson(req, 8 * 1024);
    const reason = note.reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (!reason) fail(400, '打回必须填写理由', 'reason_required');
    return { result: decide(token, params, 'rejected', reason, body.version) };
  } });

  return {
    async handle(req, res, url) {
      const ip = clientIp(req, config.trustProxy);
      let token = null, action = 'unknown', params = {}, reason = null;
      try {
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
