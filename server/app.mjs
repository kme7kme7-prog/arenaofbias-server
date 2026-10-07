// Wires the platform together: the site (static build + API) and the content handler.
import { extname, join, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createArena } from './arena.mjs';
import { createFeatured } from './featured.mjs';
import { avatarOf, createAuth } from './auth.mjs';
import { createEmailAuth } from './auth-email.mjs';
import { createLoginSecurity } from './login-security.mjs';
import { createCapturer } from './capture.mjs';
import { createModerator } from './moderation.mjs';
import { createCatalog } from './catalog.mjs';
import { createComments } from './comments.mjs';
import { AVATARS, EFFORTS, EMOJIS } from './config.mjs';
import { createContentHandler } from './content.mjs';
import { openDatabase, transaction } from './db.mjs';
import {
  HttpError, assertSameOrigin, clientIp, createRouter, fail, isTrustedOrigin, rateLimit, readBody, readJson, resolveInside, sendJson, streamFile,
} from './http.mjs';
import { createLibrary } from './library.mjs';
import { createAdmin } from './admin.mjs';
import { createInbox } from './inbox.mjs';
import { createQuestions } from './questions.mjs';
import { createReferences } from './references.mjs';
import { DOMAIN_GROUPS, DOMAINS, AI_JUDGED, isAiJudgedTask, requireCategory, requireDomains } from './categories.mjs';
import { createProfile } from './profile.mjs';
import { registerShow1Compat } from './show1compat.mjs';
import { registerShow1Guess } from './show1/guess.mjs';
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from './turnstile.mjs';
import { createReadGuard } from './read-guard.mjs';
import { isSenior, isStaff } from './roles.mjs';

const foldScript = readFileSync(new URL('./fold.js', import.meta.url));

export function createPlatform({ config, limits, captureFactory = createCapturer, mailer }) {
  const serverVersion = process.env.SERVER_VERSION || (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* 部署目录没有 .git：读部署时写入的版本文件 */ }
    try { return readFileSync(new URL('../.server-version', import.meta.url), 'utf8').trim(); }
    catch { return 'dev'; }
  })();
  const db = openDatabase(join(config.dataDir, 'platform.db'));
  const references = createReferences({ db, config, limits });
  const questions = createQuestions(db, { references });
  references.bindQuestions(questions);
  references.cleanup();
  const referenceCleanup = setInterval(() => references.cleanup(), 60e3);
  referenceCleanup.unref();
  const profile = createProfile(db);
  const catalog = createCatalog(config.dist, questions);
  catalog.refresh();
  const auth = createAuth(db, { admins: config.admins, secureCookies: config.secureCookies, cookieSameSite: config.cookieSameSite, sessionTtl: limits.sessionTtl });
  const loginSecurity = createLoginSecurity(db, { isAdminName: auth.isAdminName });
  const emailAuth = createEmailAuth(db, auth, { mailer });
  // Show1 娱乐面兼容层（fusion/show1-adapter/DESIGN.md）：快照 + live 合并的同形状端点。
  const show1Snapshot = JSON.parse(readFileSync(new URL('./show1/compat-data.json', import.meta.url), 'utf8'));
  const library = createLibrary({ db, catalog, config, limits, legacyRounds: new Set(show1Snapshot.works.map((work) => work.promptId)) });
  const adminService = createAdmin({ db, catalog, library });
  const inbox = createInbox({ library, config, limits });
  const arena = createArena({ db, catalog, library, limits });
  const uploadedCount = db.prepare('SELECT COUNT(*) AS n FROM works WHERE owner_id = ? AND deleted_at IS NULL');
  const questionEligibility = (user) => {
    const votes = arena.votesBy(user.id), uploads = uploadedCount.get(user.id).n;
    const exempt = isStaff(user);
    return { allowed: exempt || votes >= 100 || uploads >= 10, exempt, votes, uploads, requiredVotes: 100, requiredUploads: 10 };
  };
  const matchCleanup = setInterval(() => arena.cleanupExpiredMatches(), 60e3);
  matchCleanup.unref();
  const featured = createFeatured({ db, catalog, library, arena });
  const comments = createComments(db, library);
  const capturer = captureFactory({ config, library });
  const moderator = createModerator({ config, library, capturer, onChange: () => arena.invalidate() });
  const queueWork = (work) => {
    if (work.moderation.status === 'pending') moderator.enqueue(work);
    else void capturer.enqueue(work);
  };
  const readGuard = createReadGuard(config);
  const limit = {
    auth: rateLimit(60e3, 10, '尝试次数太多，请一分钟后再试'),
    codes: rateLimit(60e3, 30, '验证码尝试过多，请一分钟后再试'),
    write: rateLimit(60e3, 120),
    drafts: rateLimit(10 * 60e3, 12, '上传太频繁，请稍后再试'),
    matches: rateLimit(60e3, 60),
  };
  const siteCsp = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    `frame-src 'self' https://challenges.cloudflare.com ${config.contentTemplate.replace('{token}', '*')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  // The admin shell shares the site's CSP: it only talks to /api and frames works.
  const adminDir = resolve(config.admin ?? join(config.dist, '..', 'admin'));

  const signedIn = (ctx) => ctx.user ?? fail(401, '请先登录');
  const emailBound = (ctx) => {
    const user = signedIn(ctx);
    if (!user.email) fail(403, '请先绑定邮箱', 'email_required');
    return user;
  };
  const adminOnly = (ctx) => (isSenior(signedIn(ctx)) ? ctx.user : fail(403, '仅高级管理员可以操作'));
  const staffOnly = (ctx) => (isStaff(signedIn(ctx)) ? ctx.user : fail(403, '仅管理员可以操作'));
  const publicList = (works, viewer) => works.map((work) => library.toPublic(work, viewer));
  const batchDecision = (body, statuses, reasonRequired) => {
    if (!body || typeof body !== 'object' || !statuses.includes(body.status)) fail(400, '审核结果无效');
    if (body.reason != null && typeof body.reason !== 'string') fail(400, '审核理由格式不正确');
    const reason = (body.reason ?? '').trim();
    if (reason.length > 500) fail(400, '审核理由最多 500 字');
    if (body.status === reasonRequired && !reason) fail(400, reasonRequired === 'questioned' ? '标记存疑时请写明原因，作者和访客都会看到' : '请填写拒绝理由');
  };
  const batchItems = (items, max, questionsOnly = false) => {
    const validId = (id) => typeof id === 'string' && Boolean(id.trim());
    if (!Array.isArray(items) || items.length < 1 || items.length > max
      || items.some((item) => questionsOnly ? !validId(item) : !item || !validId(item.task) || !validId(item.id))) {
      fail(400, `请选择 1–${max} ${questionsOnly ? '道题目' : '件作品'}`, questionsOnly ? 'invalid_question_list' : 'invalid_work_list');
    }
  };
  const batchResult = (identity, run) => {
    try { return { ...identity, ok: true, ...run() }; }
    catch (error) {
      if (!(error instanceof HttpError)) {
        console.error(error);
        return { ...identity, ok: false, error: { status: 500, code: 'internal_error', message: '服务器出错了，请稍后再试' } };
      }
      return { ...identity, ok: false, error: { status: error.status,
        code: error.code || ({ 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict' }[error.status] ?? 'request_failed'),
        message: error.message } };
    }
  };
  const checkDatapack = (ctx, taskId) => {
    const snapshot = catalog.snapshot();
    if (!snapshot.task(taskId)) return snapshot; // Database questions are independent of the package.
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
      apiVersion: 2,
      serverVersion,
      providers: snapshot.providers(),
      domains: DOMAINS,
      domainGroups: DOMAIN_GROUPS,
      user: user ? { ...auth.public(user), emailBound: Boolean(user.email) } : null,
      site: {
        content: config.contentTemplate,
        cdn: config.cdn,
        capture: capturer.available,
        contentModeration: moderator.enabled,
        autoModeration: moderator.enabled && Boolean(config.moderation?.apiKey) && capturer.available,
        efforts: EFFORTS,
        emojis: EMOJIS,
        avatars: AVATARS,
        limits: { uploadBytes: limits.uploadBytes, coverBytes: limits.coverBytes, referenceCount: limits.referenceCount,
          referenceBytes: limits.referenceBytes, pendingPerUser: limits.pendingPerUser, provisionalGames: limits.provisionalGames },
      },
      works: publicList(library.allWorks().filter((work) => library.visibleTo(work, 'show2')), user),
      questions: questions.all(user),
      reactions: library.reactionSummary(user),
      arena: Object.fromEntries(catalog.tasks().filter((task) => !isAiJudgedTask(task)).map((task) => [task.id, arena.poolStats(task.id)])),
      featured: featured.read(),
      totals: (await arena.leaderboard()).totals,
      me: user ? {
        votes: arena.votesBy(user.id), pending: library.pendingCount(user.id),
        questionEligibility: questionEligibility(user),
        pendingLimit: library.pendingLimit(user), updates: library.updatesCount(user.id),
      } : null,
      review: isStaff(user) ? {
        // Same queue as the Gallery review page: released content on a public question that the
        // gallery has not decided yet, which includes uploads already verified for the arena.
        unverified: library.reviewQueue().length,
        content: uploads.filter((work) => work.moderation.status === 'review').length,
        autoRejected: uploads.filter((work) => work.moderation.status === 'rejected' && work.moderation.source !== 'human').length,
        injected: uploads.filter((work) => work.moderation.categories?.includes('prompt-injection')).length,
        questions: isSenior(user) ? questions.pendingCount() : 0,
      } : null,
    };
  }

  const router = createRouter();
  router.on('GET', '/api/fold.js', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': foldScript.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : foldScript);
  });
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
    const user = await emailAuth.register(body);
    auth.startSession(ctx.res, user.id, ctx.req);
    return { user: compatUser(user) };
  });
  router.on('POST', '/api/auth/login', async (ctx) => {
    limit.auth(ctx.ip);
    const body = await readJson(ctx.req);
    const name = body.name ?? body.username;
    // Challenge requests must not occupy the shared password-hashing budget.
    const verdict = await verifyTurnstile(body.turnstileToken, ctx.ip);
    if (verdict === 'fail') fail(400, '人机验证未通过，请重试。');
    if (verdict === 'down') fail(503, '人机验证服务暂时不可用，请稍后重试。');
    const attempt = loginSecurity.begin(name, ctx.ip);
    try {
      let user;
      try { user = await auth.login(name, body.password); }
      catch (error) {
        if (error instanceof HttpError && error.status === 401) loginSecurity.failure(attempt);
        throw error;
      }
      loginSecurity.success(attempt);
      auth.startSession(ctx.res, user.id, ctx.req);
      return { user: compatUser(user) };
    } finally { loginSecurity.finish(attempt); }
  });
  router.on('GET', '/api/auth/me', (ctx) => ({
    user: ctx.user ? { id: ctx.user.id, username: ctx.user.name, role: ctx.user.role === 'admin' ? 'admin' : null, email: ctx.user.email ?? null, avatar: avatarOf(ctx.user) } : null,
  }));
  router.on('GET', '/api/auth/turnstile', () => ({ siteKey: turnstileEnabled() ? turnstileSiteKey() : null }));
  router.on('POST', '/api/auth/email/send', async (ctx) => emailAuth.send(await readJson(ctx.req), ctx.user, ctx.ip));
  router.on('POST', '/api/auth/email/verify', async (ctx) => {
    limit.codes(ctx.ip);
    return emailAuth.verify(await readJson(ctx.req), ctx.user);
  });
  router.on('POST', '/api/auth/email/bind', async (ctx) => {
    limit.codes(ctx.ip);
    return { user: compatUser(emailAuth.bind(await readJson(ctx.req), ctx.user)) };
  });
  router.on('POST', '/api/auth/password/reset', async (ctx) => {
    limit.codes(ctx.ip);
    return emailAuth.reset(await readJson(ctx.req));
  });
  router.on('POST', '/api/auth/logout', (ctx) => {
    auth.endSession(ctx.req, ctx.res);
    return { ok: true };
  });

  router.on('GET', '/api/questions/eligibility', (ctx) => ({ eligibility: questionEligibility(signedIn(ctx)) }));
  router.on('POST', '/api/questions', async (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req, 6 * 1024 * 1024);
    requireCategory(body.category);
    if (!Object.hasOwn(body, 'draftId') && !Object.hasOwn(body, 'work') && !Object.hasOwn(body, 'confirmed')) {
      if (!questionEligibility(user).allowed) fail(403, '单独提交题目需要完成 100 次有效盲评或上传 10 件作品；附带示例结果可直接发起。', 'question_ineligible');
      const question = transaction(db, () => questions.create(user, body, catalog.tags()));
      return { question };
    }
    if (!body.draftId || !body.work || typeof body.work !== 'object' || Array.isArray(body.work)) fail(400, '请附上一份模型结果');
    let question;
    const work = library.submit(user, { ...body.work, draftId: body.draftId, confirmed: body.confirmed }, {
      createQuestion: () => (question = questions.create(user, body, catalog.tags())),
    });
    queueWork(work);
    arena.invalidate();
    return { question, work: library.toPublic(work, user) };
  });

  router.on('POST', '/api/admin/questions', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const question = questions.createByAdmin(admin, await readJson(ctx.req), catalog.tags());
    arena.invalidate();
    return { question };
  });
  router.on('GET', '/api/admin/questions', (ctx) => {
    const admin = adminOnly(ctx);
    return { questions: questions.adminAll(admin).map(({ ownerId, ...question }) => ({
      ...question,
      samples: ownerId ? library.uploadsOf(ownerId).filter((work) => work.taskId === question.id).map((work) => {
        const { id, task, title, modelName, effort, status, moderation, scene } = library.adminWork(work, admin);
        return { id, task, title, modelName, effort, status, moderation, scene };
      }) : [],
    })) };
  });
  router.on('POST', '/api/questions/:id/moderation', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const question = questions.review(admin, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { question };
  });
  router.on('POST', '/api/admin/questions/batch-moderation', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    batchDecision(body, ['approved', 'rejected'], 'rejected');
    batchItems(body.ids, 50, true);
    const results = body.ids.map((id) => batchResult({ id }, () => {
      if (body.status === 'approved') {
        const question = questions.get(id, admin);
        if (!question) fail(404, '题目不存在');
        requireCategory(question.category);
        requireDomains(question.domains);
      }
      return { question: questions.review(admin, id, { status: body.status, reason: body.reason }) };
    }));
    arena.invalidate();
    return { results };
  });
  router.on('POST', '/api/admin/questions/:id/meta', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const question = questions.edit(admin, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { question };
  });
  router.on('POST', '/api/questions/:id/resubmit', async (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    const question = questions.resubmit(user, ctx.params.id, await readJson(ctx.req, 6 * 1024 * 1024));
    arena.invalidate();
    return { question };
  });
  router.on('DELETE', '/api/questions/:id', (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    questions.remove(user, ctx.params.id);
    arena.invalidate();
    return { ok: true };
  });

  // Upload: the raw ZIP/HTML/text body is inspected and staged for the trial load.
  router.on('POST', '/api/references', async (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    limit.drafts(user.id);
    const supplied = ctx.req.headers['x-datapack-version'];
    if (supplied && supplied !== catalog.snapshot().commit) ctx.res.setHeader('X-Datapack-Stale', '1');
    const buffer = await readBody(ctx.req, limits.referenceBytes);
    return { reference: references.upload(user, ctx.url.searchParams.get('name') ?? '', buffer) };
  });

  router.on('POST', '/api/drafts', async (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    limit.drafts(user.id);
    const task = ctx.url.searchParams.get('task') ?? '';
    checkDatapack(ctx, task);
    const name = ctx.url.searchParams.get('name') ?? '';
    const buffer = await readBody(ctx.req, limits.uploadBytes);
    return { draft: library.createDraft(user, task, name, buffer, ctx.url.searchParams.get('template')) };
  });
  router.on('GET', '/api/drafts', (ctx) =>
    ({ draft: library.latestDraft(emailBound(ctx), ctx.url.searchParams.get('task') ?? '') }));
  router.on('DELETE', '/api/drafts/:id', (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    library.discardDraft(user, ctx.params.id);
    return { ok: true };
  });
  router.on('POST', '/api/works', async (ctx) => {
    const user = emailBound(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req, 6 * 1024 * 1024);
    checkDatapack(ctx, library.draftTask(String(body.draftId ?? '')));
    const work = library.submit(user, body);
    queueWork(work);
    arena.invalidate();
    return { work: library.toPublic(work, user) };
  });
  router.on('DELETE', '/api/works/:task/:id', async (ctx) => {
    const user = signedIn(ctx);
    const body = ctx.req.headers['content-type'] ? await readJson(ctx.req) : {};
    library.remove(user, ctx.params.task, ctx.params.id, body);
    arena.invalidate();
    return { ok: true };
  });
  router.on('POST', '/api/works/:task/:id/review', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const work = library.review(admin, ctx.params.task, ctx.params.id, body);
    arena.invalidate();
    return { work: library.adminWork(work, admin) };
  });
  router.on('POST', '/api/works/:task/:id/moderation', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const work = library.reviewContent(admin, ctx.params.task, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { work: library.adminWork(work, admin) };
  });
  router.on('POST', '/api/works/:task/:id/moderation/retry', (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const work = library.retryModeration(admin, ctx.params.task, ctx.params.id);
    moderator.enqueue(work);
    arena.invalidate();
    return { work: library.adminWork(work, admin) };
  });
  router.on('POST', '/api/works/:task/:id/reactions', async (ctx) => {
    const user = emailBound(ctx);
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
    return {
      questions: questions.byOwner(user.id, user), works: library.authorWorks(user),
      reviewStats: library.reviewStats(), votes: arena.votesBy(user.id), ...profile.summary(user),
    };
  });
  router.on('POST', '/api/me/works/seen', (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    library.markWorksSeen(user.id);
    return { ok: true };
  });
  // Registered after the calibration route, whose path has the same shape.
  router.on('PATCH', '/api/works/:task/:id', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    const work = library.setMeta(user, ctx.params.task, ctx.params.id, await readJson(ctx.req), { author: !isStaff(user) });
    if (!isStaff(user)) moderator.enqueue(library.work(ctx.params.task, ctx.params.id));
    arena.invalidate();
    return { work: library.toPublic(library.work(work.task, work.id), user) };
  });
  router.on('PATCH', '/api/me', async (ctx) => {
    const user = signedIn(ctx);
    limit.write(user.id);
    return { user: auth.public(auth.updateProfile(user, await readJson(ctx.req))) };
  });
  router.on('GET', '/api/review', (ctx) => {
    const admin = staffOnly(ctx);
    return { works: library.allWorks().map((work) => library.adminWork(work, admin)), audit: library.auditLog(),
      questions: isSenior(admin) ? questions.adminAll(admin) : [] };
  });

  // Account administration for Gallery's member list and the admin web app (the CLI in server/cli.mjs does the same).
  router.on('GET', '/api/admin/users', (ctx) => {
    adminOnly(ctx);
    return { users: adminService.members(auth.list()) };
  });
  router.on('POST', '/api/admin/users/:id/role', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const user = auth.setRole(admin, ctx.params.id, String(body.role ?? ''));
    library.audit(admin, 'role', null, `${user.name} → ${{ admin: '高级管理员', moderator: '普通管理员', user: '普通用户' }[user.role]}`);
    return { user };
  });

  router.on('GET', '/api/admin/works', (ctx) => {
    const admin = staffOnly(ctx);
    return adminService.works(ctx.url.searchParams, admin);
  });
  router.on('GET', '/api/admin/inbox/works', (ctx) => {
    const admin = staffOnly(ctx);
    return { works: library.inboxWorks(admin) };
  });
  router.on('POST', '/api/admin/works/batch-inbox', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const works = library.assignInbox(admin, body.works, { task: body.task ?? null, entertainment: body.entertainment ?? false });
    arena.invalidate();
    return { works };
  });
  router.on('POST', '/api/admin/works/batch-face-settings', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const { works: items, ...settings } = (await readJson(ctx.req)) ?? {};
    const works = library.batchSetFaceSettings(admin, items, settings);
    arena.invalidate();
    return { works };
  });
  router.on('POST', '/api/admin/works/batch-moderation', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    batchDecision(body, ['approved', 'rejected'], 'rejected');
    batchItems(body.works, 100);
    const results = body.works.map(({ task, id }) => batchResult({ task, id }, () => ({
      work: library.adminWork(library.reviewContent(admin, task, id, { status: body.status, reason: body.reason }), admin),
    })));
    arena.invalidate();
    return { results };
  });
  router.on('POST', '/api/admin/works/batch-review', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    batchDecision(body, ['verified', 'questioned'], 'questioned');
    batchItems(body.works, 100);
    if (body.meta !== undefined && (!body.meta || typeof body.meta !== 'object' || Array.isArray(body.meta)
      || Object.keys(body.meta).some((key) => !['effort', 'providerId', 'harnessId', 'harnessOther'].includes(key)))) fail(400, '批量核验信息无效');
    if (body.show_arena !== undefined && typeof body.show_arena !== 'boolean') fail(400, '门面开关无效', 'invalid_face_settings');
    const results = body.works.map(({ task, id }) => batchResult({ task, id }, () => ({
      work: library.adminWork(library.reviewWithMeta(admin, task, id, {
        status: body.status, reason: body.reason, meta: body.meta,
        ...(body.status === 'verified' ? { show_gallery: true, ...(body.show_arena !== undefined ? { show_arena: body.show_arena } : {}) } : {}),
      }), admin),
    })));
    arena.invalidate();
    return { results };
  });
  router.on('POST', '/api/admin/works/:task/:id/face-settings', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const work = library.setFaceSettings(admin, ctx.params.task, ctx.params.id, await readJson(ctx.req));
    arena.invalidate();
    return { work };
  });
  router.on('POST', '/api/admin/works/:task/:id/calibration', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const calibration = library.setFaceCalibration(admin, ctx.params.task, ctx.params.id, body.face, body.calibration);
    arena.invalidate();
    return { task: ctx.params.task, id: ctx.params.id, face: body.face, calibration };
  });
  // Short-lived preview host for the admin calibration panel: all works become
  // viewable on the content origin, where the
  // camera bridge answers the capture handshake. The key itself is the permission.
  router.on('POST', '/api/admin/works/:task/:id/preview', (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const work = library.work(ctx.params.task, ctx.params.id);
    if (!work) fail(404, '作品不存在', 'not_found');
    return { url: `${library.previewOrigin(work)}/` };
  });
  router.on('GET', '/api/admin/tasks/:id/editorial', (ctx) => {
    const admin = adminOnly(ctx);
    return adminService.getEditorial(ctx.params.id, ctx.url.searchParams.get('face'), admin);
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
        ...Object.fromEntries(['harnessId', 'harnessOther', 'providerId',
          'generationMode', 'humanIntervention', 'promptVariant']
          .filter((key) => params.has(key)).map((key) => [key, params.get(key)])),
      });
    } catch (error) {
      library.discardDraft(admin, draft.id);
      throw error;
    }
    queueWork(submitted);
    arena.invalidate();
    return { work: library.adminWork(submitted, admin) };
  });

  // Admin staging inbox: files wait here until they are previewed and registered as works.
  router.on('GET', '/api/admin/inbox', (ctx) => {
    staffOnly(ctx);
    return inbox.list();
  });
  router.on('POST', '/api/admin/inbox', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const params = ctx.url.searchParams;
    const buffer = await readBody(ctx.req, limits.uploadBytes);
    return inbox.upload(admin, params.get('name'), buffer, params.get('overwrite') === '1');
  });
  router.on('POST', '/api/admin/inbox/register', async (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    const work = inbox.register(admin, await readJson(ctx.req));
    queueWork(work);
    arena.invalidate();
    return { work: library.adminWork(work, admin) };
  });
  router.on('DELETE', '/api/admin/inbox', (ctx) => {
    const admin = staffOnly(ctx);
    limit.write(admin.id);
    return inbox.remove(admin, ctx.url.searchParams.get('id') ?? '');
  });
  // Work metadata edits share one endpoint for package and database entries.
  router.on('POST', '/api/admin/works/:task/:id/meta', async (ctx) => {
    const admin = staffOnly(ctx);
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
    return arena.createMatch(ctx.user, task, body.previous, snapshot, body.avoidCooling === true);
  });
  router.on('POST', '/api/arena/matches/:id/vote', async (ctx) => {
    limit.write(ctx.user?.id ?? ctx.ip);
    const body = await readJson(ctx.req);
    return arena.vote(ctx.user, ctx.params.id, String(body.choice ?? ''));
  });
  router.on('GET', '/api/leaderboard', (ctx) => {
    const task = ctx.url.searchParams.get('task') || null;
    if (task && !catalog.task(task)) fail(404, '题目不存在');
    const category = ctx.url.searchParams.get('category') || null;
    if (category && (task || (!AI_JUDGED.has(category) && !catalog.tasks().some((t) => t.category === category)))) fail(400, '题型筛选无效', 'invalid_query');
    const domain = ctx.url.searchParams.get('domain') || null;
    if (domain && (task || !catalog.tasks().some((t) => t.domains?.includes(domain)))) fail(400, '领域筛选无效', 'invalid_query');
    const filters = Object.fromEntries(['harness', 'provider'].map((field) => {
      const value = ctx.url.searchParams.get(field) || null;
      if (value && value !== 'unset' && !catalog[field](value)) fail(400, `${field === 'harness' ? 'Harness' : '服务商'}筛选无效`, 'invalid_query');
      return [field, value];
    }));
    return arena.leaderboard({ task, category, domain, by: ctx.url.searchParams.get('by') === 'model' ? 'model' : 'config', ...filters });
  });

  registerShow1Compat(router, { db, catalog, library, snapshot: show1Snapshot, config, limit });
  registerShow1Guess(router, { db, limit });

  function serveSite(req, res, pathname) {
    readGuard.file(req);
    const packagedReference = /^\/media\/pack-references\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (pathname.startsWith('/media/pack-references/')) {
      const taskId = packagedReference && decodeURIComponent(packagedReference[1]);
      const name = packagedReference && decodeURIComponent(packagedReference[2]);
      const snapshot = catalog.snapshot();
      const image = taskId && questions.get(taskId, auth.userFrom(req))
        && snapshot.task(taskId)?.references.find((ref) => ref.name === name);
      const found = image && resolveInside(snapshot.root, `/${image.src}`);
      if (!found) return sendJson(res, 404, { error: '文件不存在' });
      return streamFile(req, res, found, { 'Cache-Control': 'no-cache', 'Vary': 'Origin, Cookie',
        'Content-Security-Policy': "default-src 'none'" });
    }
    const reference = /^\/media\/references\/([a-z0-9-]+)\.(png|jpg|webp)$/.exec(pathname);
    if (reference) {
      const image = references.file(reference[1], auth.userFrom(req));
      if (!image || extname(image.path) !== `.${reference[2]}`) return sendJson(res, 404, { error: '文件不存在' });
      const found = resolveInside(config.dataDir, `/references/${reference[1]}.${reference[2]}`);
      if (!found) return sendJson(res, 404, { error: '文件不存在' });
      return streamFile(req, res, found, {
        'Content-Type': image.type,
        'Cache-Control': `${image.public ? 'public' : 'private'}, max-age=31536000, immutable`,
        'Vary': 'Origin, Cookie',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'Content-Security-Policy': "default-src 'none'",
      });
    }
    const media = /^\/media\/(up-[a-z0-9]{8})\/(cover\.(?:png|jpg|webp)|first\.jpg|mobile\.jpg|preview\.(?:sbox|webp|jpg))$/.exec(pathname);
    if (pathname.startsWith('/media/')) {
      const work = media && library.uploadById(media[1]);
      if (!library.canRead(work, auth.userFrom(req))) return sendJson(res, 404, { error: '文件不存在' });
      const found = media && resolveInside(library.mediaDir, `/${media[1]}/${media[2]}`);
      if (!found) return sendJson(res, 404, { error: '文件不存在' });
      return streamFile(req, res, found, { 'Cache-Control': work.moderation.status === 'legacy' ? 'public, max-age=300' : 'no-store', 'Content-Security-Policy': "default-src 'none'" });
    }
    // Admin inbox previews stream straight from the staging directory; session-guarded
    // because these files are not published works yet.
    if (pathname.startsWith('/admin/inbox/')) {
      if (!isStaff(auth.userFrom(req))) {
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
    const packagePath = found && relative(config.dist, found.file).replaceAll('\\', '/').toLowerCase();
    // Only the admin UI needs the complete registry. Public frontends carry their
    // own display catalog; never expose package origin metadata on this host.
    if (packagePath === '.datapack-source.json'
      || (packagePath === 'data.json' && !isStaff(auth.userFrom(req)))) {
      return sendJson(res, 404, { error: '文件不存在' });
    }
    // The package contains executable works, not a trusted site shell. HTML may
    // only run on the content origin; SVG/XML remain usable as inert resources.
    if (!found || ['.html', '.htm'].includes(extname(found.file).toLowerCase())) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    return streamFile(req, res, found, { 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' });
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
      const referenceMedia = url.pathname.startsWith('/media/references/') || url.pathname.startsWith('/media/pack-references/');
      if (req.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || referenceMedia)) {
        assertSameOrigin(req, config);
        const method = req.headers['access-control-request-method'];
        const route = referenceMedia && ['GET', 'HEAD'].includes(method)
          ? { handler: true } : router.match(method, url.pathname);
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
      if (req.method === 'GET' || req.method === 'HEAD') readGuard.api(req, url.pathname);
      if (['GET', 'HEAD'].includes(req.method)
        && ['/api/bootstrap', '/api/show1/works', '/api/works', '/api/prompts', '/api/votes', '/api/ratings'].includes(url.pathname)
        && ['limit', 'offset', 'page'].some((key) => url.searchParams.has(key))) fail(400, '此接口返回完整目录，不支持分页参数', 'unsupported_pagination');
      const route = router.match(req.method, url.pathname);
      if (!route) fail(404, '接口不存在');
      if (route.methodNotAllowed) fail(405, '不支持这个操作');
      if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req, config);
      const ctx = { req, res, url, params: route.params, ip: clientIp(req, config.trustProxy), user: auth.userFrom(req) };
      const result = await route.handler(ctx);
      if (!res.headersSent) return sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}),
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) },
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      console.error(error);
      return sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
    }
  }

  return {
    db,
    auth,
    library,
    references,
    arena,
    featured,
    capturer,
    moderator,
    handleSite,
    handleContent: createContentHandler({ config, library, arena, siteOrigins: config.siteOrigins, readGuard }),
    async close() {
      clearInterval(matchCleanup);
      clearInterval(referenceCleanup);
      await emailAuth.drain();
      await Promise.all([moderator.close(), capturer.close()]);
      await featured.close();
      db.close();
    },
  };
}
