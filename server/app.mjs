// Wires the platform together: the site (static build + API) and the content handler.
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createArena } from './arena.mjs';
import { createAuth } from './auth.mjs';
import { createEmailAuth } from './auth-email.mjs';
import { createCapturer } from './capture.mjs';
import { createCatalog } from './catalog.mjs';
import { createComments } from './comments.mjs';
import { EFFORTS, EMOJIS } from './config.mjs';
import { createContentHandler } from './content.mjs';
import { openDatabase } from './db.mjs';
import {
  HttpError, assertSameOrigin, clientIp, createRouter, fail, isTrustedOrigin, rateLimit, readBody, readJson, resolveInside, sendJson, streamFile,
} from './http.mjs';
import { createLibrary } from './library.mjs';
import { createAdmin } from './admin.mjs';
import { createInbox } from './inbox.mjs';
import { createCurator } from './curate.mjs';
import { createQuestions } from './questions.mjs';
import { createProfile } from './profile.mjs';
import { registerShow1Compat } from './show1compat.mjs';
import { registerShow1Guess } from './show1/guess.mjs';
import { turnstileEnabled, turnstileSiteKey } from './turnstile.mjs';

export function createPlatform({ config, limits }) {
  const serverVersion = process.env.SERVER_VERSION || (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* 部署目录没有 .git：读部署时写入的版本文件 */ }
    try { return readFileSync(new URL('../.server-version', import.meta.url), 'utf8').trim(); }
    catch { return 'dev'; }
  })();
  const db = openDatabase(join(config.dataDir, 'platform.db'));
  const questions = createQuestions(db);
  const profile = createProfile(db);
  const catalog = createCatalog(config.dist, questions);
  catalog.refresh();
  const auth = createAuth(db, { admins: config.admins, secureCookies: config.secureCookies, cookieSameSite: config.cookieSameSite, sessionTtl: limits.sessionTtl });
  const emailAuth = createEmailAuth(db, auth);
  const library = createLibrary({ db, catalog, config, limits });
  const adminService = createAdmin({ db, catalog, library });
  const inbox = createInbox({ library, config, limits });
  const arena = createArena({ db, catalog, library, limits });
  const curator = createCurator({ db, catalog, library, onTakeover: () => arena.invalidate() });
  catalog.onChange(curator.takeover);
  const comments = createComments(db, library);
  const capturer = createCapturer({ config, library });
  const limit = {
    auth: rateLimit(60e3, 10, '尝试次数太多，请一分钟后再试'),
    write: rateLimit(60e3, 120),
    drafts: rateLimit(10 * 60e3, 12, '上传太频繁，请稍后再试'),
    matches: rateLimit(60e3, 60),
    exportToken: rateLimit(60e3, 2000),
    exportIp: rateLimit(60e3, 10000),
  };
  const siteCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src 'self' ${config.contentTemplate.replace('{token}', '*')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  // The admin shell shares the site's CSP: it only talks to /api and frames works.
  const adminDir = resolve(config.admin ?? join(config.dist, '..', 'admin'));

  const signedIn = (ctx) => ctx.user ?? fail(401, '请先登录');
  const adminOnly = (ctx) => (signedIn(ctx).role === 'admin' ? ctx.user : fail(403, '仅管理员可以操作'));
  const publicList = (works, viewer) => works.map((work) => library.toPublic(work, viewer));
  const checkDatapack = (ctx, taskId) => {
    const snapshot = catalog.snapshot();
    if (!snapshot.task(taskId)) return snapshot; // Community questions are independent of the curated package.
    const supplied = ctx.req.headers['x-datapack-version'];
    if (supplied && supplied !== snapshot.commit) ctx.res.setHeader('X-Datapack-Stale', '1');
    return snapshot;
  };

  async function bootstrap(user) {
    const snapshot = catalog.snapshot();
    const uploads = library.uploads();
    return {
      datapack: snapshot.commit,
      catalogDigest: snapshot.catalogDigest,
      apiVersion: 1,
      serverVersion,
      user: auth.public(user),
      site: {
        content: config.contentTemplate,
        cdn: config.cdn,
        capture: capturer.available,
        efforts: EFFORTS,
        emojis: EMOJIS,
        limits: { uploadBytes: limits.uploadBytes, coverBytes: limits.coverBytes, pendingPerUser: limits.pendingPerUser, provisionalGames: limits.provisionalGames },
      },
      works: publicList(uploads.filter((work) => !work.curatedAs && library.visibleTo(work, 'show2')), user),
      questions: questions.all(),
      reactions: library.reactionSummary(user),
      arena: Object.fromEntries(catalog.tasks().map((task) => [task.id, { ...arena.poolStats(task.id), uploads: task.acceptsUploads }])),
      totals: (await arena.leaderboard()).totals,
      me: user ? { votes: arena.votesBy(user.id), pending: library.pendingCount(user.id) } : null,
      review: user?.role === 'admin' ? { unverified: uploads.filter((work) => work.status === 'unverified').length } : null,
    };
  }

  const router = createRouter();
  router.on('GET', '/api/bootstrap', (ctx) => bootstrap(ctx.user));
  router.on('GET', '/api/show1/works', (ctx) => ({
    works: publicList(library.published('show1'), ctx.user),
    reactions: library.reactionSummary(ctx.user, 'show1'),
  }));

  // Dual shape: the Show1 frontend posts `username` (alias of `name`) and reads
  // `username`/`email` back; the platform fields stay exactly as they were.
  const compatUser = (user) => ({ ...auth.public(user), username: user.name, email: user.email ?? null });
  router.on('POST', '/api/auth/register', async (ctx) => {
    limit.auth(ctx.ip);
    const body = await readJson(ctx.req);
    await emailAuth.gate(body.turnstileToken, ctx.ip);
    const user = await auth.register(body.name ?? body.username, body.password);
    auth.startSession(ctx.res, user.id);
    return { user: compatUser(user) };
  });
  router.on('POST', '/api/auth/login', async (ctx) => {
    limit.auth(ctx.ip);
    const body = await readJson(ctx.req);
    const user = await auth.login(body.name ?? body.username, body.password);
    auth.startSession(ctx.res, user.id);
    return { user: compatUser(user) };
  });
  router.on('GET', '/api/auth/me', (ctx) => ({
    user: ctx.user ? { id: ctx.user.id, username: ctx.user.name, role: ctx.user.role === 'admin' ? 'admin' : null, email: ctx.user.email ?? null } : null,
  }));
  router.on('GET', '/api/auth/turnstile', () => ({ siteKey: turnstileEnabled() ? turnstileSiteKey() : null }));
  router.on('POST', '/api/auth/email/send', async (ctx) => emailAuth.send(await readJson(ctx.req), ctx.user, ctx.ip));
  router.on('POST', '/api/auth/email/verify', async (ctx) => emailAuth.verify(await readJson(ctx.req), ctx.user));
  router.on('POST', '/api/auth/email/bind', async (ctx) => ({ user: compatUser(emailAuth.bind(await readJson(ctx.req), ctx.user)) }));
  router.on('POST', '/api/auth/password/reset', async (ctx) => emailAuth.reset(await readJson(ctx.req)));
  router.on('POST', '/api/auth/logout', (ctx) => {
    auth.endSession(ctx.req, ctx.res);
    return { ok: true };
  });

  router.on('POST', '/api/questions', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const question = questions.create(user, await readJson(ctx.req), catalog.tags());
    arena.invalidate();
    return { question };
  });

  // Upload: the raw ZIP/HTML body is inspected and staged as a draft for the trial load.
  router.on('POST', '/api/drafts', async (ctx) => {
    const user = signedIn(ctx);
    limit.drafts(user.id);
    const task = ctx.url.searchParams.get('task') ?? '';
    checkDatapack(ctx, task);
    const name = ctx.url.searchParams.get('name') ?? '';
    const buffer = await readBody(ctx.req, limits.uploadBytes);
    return { draft: library.createDraft(user, task, name, buffer, ctx.url.searchParams.get('template')) };
  });
  router.on('DELETE', '/api/drafts/:id', (ctx) => {
    library.discardDraft(signedIn(ctx), ctx.params.id);
    return { ok: true };
  });
  router.on('POST', '/api/works', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req, 6 * 1024 * 1024);
    checkDatapack(ctx, library.draftTask(String(body.draftId ?? '')));
    const work = library.submit(user, body);
    capturer.enqueue(work);
    arena.invalidate();
    return { work: library.toPublic(work, user) };
  });
  router.on('DELETE', '/api/works/:task/:id', (ctx) => {
    library.remove(signedIn(ctx), ctx.params.task, ctx.params.id);
    arena.invalidate();
    return { ok: true };
  });
  router.on('POST', '/api/works/:task/:id/review', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const work = library.review(admin, ctx.params.task, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { work: library.toPublic(work, admin) };
  });
  router.on('POST', '/api/works/:task/:id/reactions', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req);
    return library.react(user, ctx.params.task, ctx.params.id, String(body.emoji ?? ''));
  });
  router.on('GET', '/api/works/:task/:work/comments', (ctx) => ({
    comments: comments.list(ctx.user, ctx.params.task, ctx.params.work),
  }));
  router.on('POST', '/api/works/:task/:work/comments', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req);
    return { comment: comments.create(user, ctx.params.task, ctx.params.work, body.body) };
  });
  router.on('DELETE', '/api/comments/:id', (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    comments.remove(user, ctx.params.id);
    return { ok: true };
  });
  router.on('GET', '/api/works/:id/calibration', (ctx) => ({
    calibration: library.getCalibration(ctx.user, ctx.params.id),
  }));
  router.on('PATCH', '/api/works/:id/calibration', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req);
    return { calibration: library.setCalibration(user, ctx.params.id, body.calibration) };
  });

  router.on('GET', '/api/me', (ctx) => {
    const user = signedIn(ctx);
    return { questions: questions.byOwner(user.id), works: publicList(library.uploadsOf(user.id), user), votes: arena.votesBy(user.id), ...profile.summary(user) };
  });
  router.on('PATCH', '/api/me', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    return { user: auth.public(auth.updateProfile(user, await readJson(ctx.req))) };
  });
  router.on('GET', '/api/review', (ctx) => {
    const admin = adminOnly(ctx);
    // Per-face review covers both sides: uploads plus the curated collection (the
    // other site's works), each waiting on its own face's flag.
    const curated = catalog.tasks().flatMap((task) => [...task.works.values()]);
    return { works: [...library.uploads().filter((work) => !work.curatedAs), ...curated].map((work) => library.adminWork(work)), audit: library.auditLog() };
  });

  // Account administration for the admin web app (the CLI in server/cli.mjs does the same).
  router.on('GET', '/api/admin/users', (ctx) => {
    adminOnly(ctx);
    return { users: auth.list() };
  });
  router.on('POST', '/api/admin/users/:id/role', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const user = auth.setRole(admin, ctx.params.id, String(body.role ?? ''));
    library.audit(admin, 'role', null, `${user.name} → ${user.role === 'admin' ? '管理员' : '成员'}`);
    return { user };
  });

  router.on('GET', '/api/admin/works', (ctx) => {
    adminOnly(ctx);
    return adminService.works(ctx.url.searchParams);
  });
  router.on('POST', '/api/admin/works/batch-face-settings', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const { works: items, ...settings } = (await readJson(ctx.req)) ?? {};
    const works = library.batchSetFaceSettings(admin, items, settings);
    arena.invalidate();
    return { works };
  });
  router.on('POST', '/api/admin/works/:task/:id/face-settings', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const work = library.setFaceSettings(admin, ctx.params.task, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { work };
  });
  router.on('POST', '/api/admin/works/:task/:id/calibration', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const calibration = library.setFaceCalibration(admin, ctx.params.task, ctx.params.id, body.face, body.calibration);
    arena.invalidate();
    return { task: ctx.params.task, id: ctx.params.id, face: body.face, calibration };
  });
  router.on('GET', '/api/admin/tasks/:id/editorial', (ctx) => {
    adminOnly(ctx);
    return adminService.getEditorial(ctx.params.id, ctx.url.searchParams.get('face'));
  });
  router.on('POST', '/api/admin/tasks/:id/editorial', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    return adminService.saveEditorial(admin, ctx.params.id, await readJson(ctx.req));
  });
  router.on('GET', '/api/admin/traffic', (ctx) => {
    adminOnly(ctx);
    return adminService.traffic(ctx.url.searchParams.get('days'));
  });
  router.on('POST', '/api/admin/works/upload', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    limit.drafts(admin.id);
    const params = ctx.url.searchParams;
    const task = params.get('task') ?? '';
    checkDatapack(ctx, task);
    const gallery = params.get('show_gallery');
    const arenaFace = params.get('show_arena');
    if ((gallery !== null && !['0', '1'].includes(gallery)) || (arenaFace !== null && !['0', '1'].includes(arenaFace))) fail(400, '门面开关无效', 'invalid_face_settings');
    const name = params.get('name') ?? '';
    const buffer = await readBody(ctx.req, limits.uploadBytes);
    const draft = library.createDraft(admin, task, name, buffer, params.get('template'));
    let submitted;
    try {
      submitted = library.submit(admin, {
        draftId: draft.id, confirmed: true, title: params.get('title'), summary: params.get('summary'),
        modelId: params.get('modelId'), modelName: params.get('modelName'), effort: params.get('effort'), tool: params.get('tool') || '',
        ...Object.fromEntries(['harnessId', 'harnessOther', 'harnessVersion', 'providerId', 'providerOther',
          'modelVersion', 'generationMode', 'humanIntervention', 'generatedOn', 'evidenceUrl']
          .filter((key) => params.has(key)).map((key) => [key, params.get(key)])),
      });
    } catch (error) {
      library.discardDraft(admin, draft.id);
      throw error;
    }
    const work = library.review(admin, task, submitted.id, { status: 'verified',
      show_gallery: gallery === null ? true : gallery === '1', show_arena: arenaFace === null ? false : arenaFace === '1' });
    capturer.enqueue(work);
    arena.invalidate();
    return { work: library.adminWork(work) };
  });

  // Admin staging inbox: files wait here until they are previewed and registered as works.
  router.on('GET', '/api/admin/inbox', (ctx) => {
    adminOnly(ctx);
    return inbox.list();
  });
  router.on('POST', '/api/admin/inbox', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const params = ctx.url.searchParams;
    const buffer = await readBody(ctx.req, limits.uploadBytes);
    return inbox.upload(admin, params.get('name'), buffer, params.get('overwrite') === '1');
  });
  router.on('POST', '/api/admin/inbox/register', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const work = inbox.register(admin, await readJson(ctx.req));
    capturer.enqueue(work);
    arena.invalidate();
    return { work: library.adminWork(work) };
  });
  router.on('DELETE', '/api/admin/inbox', (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    return inbox.remove(admin, ctx.url.searchParams.get('id') ?? '');
  });
  router.on('POST', '/api/admin/works/:task/:id/nominate', (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const protocol = config.trustProxy ? String(ctx.req.headers['x-forwarded-proto'] ?? 'http').split(',')[0] : ctx.req.socket.encrypted ? 'https' : 'http';
    const origin = ctx.req.headers.origin ?? `${protocol}://${ctx.req.headers.host}`;
    return curator.nominate(admin, ctx.params.task, ctx.params.id, origin);
  });
  router.on('DELETE', '/api/admin/works/:task/:id/nominate', (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    return curator.withdraw(admin, ctx.params.task, ctx.params.id);
  });
  router.on('GET', '/api/curate/export/:token', (ctx) => {
    limit.exportIp(ctx.ip);
    limit.exportToken(ctx.params.token);
    return curator.metadata(ctx.params.token);
  });
  router.on('GET', '/api/curate/export/:token/file', (ctx) => {
    limit.exportIp(ctx.ip);
    limit.exportToken(ctx.params.token);
    return streamFile(ctx.req, ctx.res, curator.file(ctx.params.token, ctx.url.searchParams.get('path')),
      { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment', 'Content-Security-Policy': 'sandbox' });
  });
  // Inline edits (title/summary/model) from the works table; curated works stay repo-managed.
  router.on('POST', '/api/admin/works/:task/:id/meta', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const work = library.setMeta(admin, ctx.params.task, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { work };
  });

  router.on('POST', '/api/arena/matches', async (ctx) => {
    limit.matches(ctx.user?.id ?? ctx.ip);
    const body = await readJson(ctx.req);
    const task = String(body.task ?? '');
    const snapshot = checkDatapack(ctx, task);
    return arena.createMatch(ctx.user, task, body.previous, snapshot);
  });
  router.on('POST', '/api/arena/matches/:id/vote', async (ctx) => {
    limit.write(ctx.user?.id ?? ctx.ip);
    const body = await readJson(ctx.req);
    return arena.vote(ctx.user, ctx.params.id, String(body.choice ?? ''));
  });
  router.on('GET', '/api/leaderboard', (ctx) => {
    const task = ctx.url.searchParams.get('task') || null;
    if (task && !catalog.task(task)) fail(404, '题目不存在');
    const filters = Object.fromEntries(['harness', 'provider'].map((field) => {
      const value = ctx.url.searchParams.get(field) || null;
      if (value && value !== 'unset' && !catalog[field](value)) fail(400, `${field === 'harness' ? 'Harness' : '服务商'}筛选无效`, 'invalid_query');
      return [field, value];
    }));
    return arena.leaderboard({ task, by: ctx.url.searchParams.get('by') === 'model' ? 'model' : 'config', ...filters });
  });

  // Show1 娱乐面兼容层（fusion/show1-adapter/DESIGN.md）：快照 + live 合并的同形状端点。
  const show1Snapshot = JSON.parse(readFileSync(new URL('./show1/compat-data.json', import.meta.url), 'utf8'));
  registerShow1Compat(router, { db, snapshot: show1Snapshot, config, limit });
  registerShow1Guess(router, { db, limit });

  function serveSite(req, res, pathname) {
    const media = /^\/media\/(up-[a-z0-9]{8})\/(cover\.(?:png|jpg|webp)|first\.jpg|mobile\.jpg)$/.exec(pathname);
    if (pathname.startsWith('/media/')) {
      const found = media && resolveInside(library.mediaDir, `/${media[1]}/${media[2]}`);
      if (!found) return sendJson(res, 404, { error: '文件不存在' });
      return streamFile(req, res, found, { 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'" });
    }
    // Admin inbox previews stream straight from the staging directory; session-guarded
    // because these files are not published works yet.
    if (pathname.startsWith('/admin/inbox/')) {
      if (auth.userFrom(req)?.role !== 'admin') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const found = inbox.resolve(pathname.slice('/admin/inbox'.length));
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      return streamFile(req, res, found, { 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox allow-scripts', ...(found.type ? { 'Content-Type': found.type } : {}) });
    }
    // The admin app lives in this repository and takes precedence over the dist fallback.
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      const found = resolveInside(adminDir, pathname.slice('/admin'.length) || '/');
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const shell = found.file === join(adminDir, 'index.html');
      return streamFile(req, res, found, { 'Cache-Control': 'no-cache', ...(shell ? { 'Content-Security-Policy': siteCsp, 'Referrer-Policy': 'same-origin' } : {}) });
    }
    const found = resolveInside(config.dist, pathname);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const shell = found.file === join(config.dist, 'index.html');
    return streamFile(req, res, found, { 'Cache-Control': 'no-cache', ...(shell ? { 'Content-Security-Policy': siteCsp, 'Referrer-Policy': 'same-origin' } : {}) });
  }

  async function handleSite(req, res) {
    try {
      const url = new URL(req.url, 'http://site.invalid');
      if (req.headers.origin) {
        res.setHeader('Vary', 'Origin');
        if (isTrustedOrigin(req, config)) {
          res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          res.setHeader('Access-Control-Expose-Headers', 'X-Datapack-Stale');
        }
      }
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        assertSameOrigin(req, config);
        const method = req.headers['access-control-request-method'];
        const route = router.match(method, url.pathname);
        if (!route) fail(404, '接口不存在');
        if (route.methodNotAllowed) fail(405, '不支持这个操作');
        const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((header) => header.trim()).filter(Boolean);
        if (headers.some((header) => !['content-type', 'x-datapack-version'].includes(header))) fail(403, '请求头无效');
        res.writeHead(204, {
          'Access-Control-Allow-Methods': method,
          'Access-Control-Allow-Headers': 'Content-Type, X-Datapack-Version',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, '不支持这个操作');
        return serveSite(req, res, url.pathname);
      }
      const route = router.match(req.method, url.pathname);
      if (!route) fail(404, '接口不存在');
      if (route.methodNotAllowed) fail(405, '不支持这个操作');
      if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req, config);
      const ctx = { req, res, url, params: route.params, ip: clientIp(req, config.trustProxy), user: auth.userFrom(req) };
      const result = await route.handler(ctx);
      if (!res.headersSent) return sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      console.error(error);
      return sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
    }
  }

  return {
    db,
    auth,
    library,
    arena,
    handleSite,
    handleContent: createContentHandler({ config, library, arena, siteOrigins: config.siteOrigins }),
    async close() {
      await emailAuth.drain();
      await capturer.close();
      db.close();
    },
  };
}
