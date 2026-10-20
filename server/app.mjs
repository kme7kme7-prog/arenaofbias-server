// Wires the platform together: the site (static build + API) and the content handler.
import { extname, join, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { createArena } from './arena.mjs';
import { createCurated } from './curated-boards.mjs';
import { createQualification } from './qualification.mjs';
import { createArenaVoters } from './arena-voter-state.mjs';
import { createVoteRisk, normalizeIp, subnetOf } from './vote-risk.mjs';
import { createFeatured } from './featured.mjs';
import { avatarOf, createAuth } from './auth.mjs';
import { createEmailAuth } from './auth-email.mjs';
import { createLoginSecurity } from './login-security.mjs';
import { createCapturer } from './capture.mjs';
import { createModerator } from './moderation.mjs';
import { createCatalog } from './catalog.mjs';
import { createActivityRevision, createCatalogResponse, createCatalogRevision, createSharedJson } from './catalog-response.mjs';
import { createSharedRead } from './shared-read.mjs';
import { createComments } from './comments.mjs';
import { createChangelog } from './changelog.mjs';
import { createAnnouncements, retiredAnnouncementStream } from './announcements.mjs';
import { createDotsModeration, createModerationMode, createModerationTokens } from './dots-moderation.mjs';
import { createCoverStore } from './work-covers.mjs';
import { createPreviewStore } from './preview-uploads.mjs';
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
import { registerGuessRooms } from './show1/guess-room-http.mjs';
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from './turnstile.mjs';
import { createReadGuard } from './read-guard.mjs';
import { isSenior, isStaff, levelOf, requireContributor } from './roles.mjs';

const foldScript = readFileSync(new URL('./fold.js', import.meta.url));

export function createPlatform({ config, limits, captureFactory = createCapturer, mailer }) {
  const serverVersion = process.env.SERVER_VERSION || (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* 部署目录没有 .git：读部署时写入的版本文件 */ }
    try { return readFileSync(new URL('../.server-version', import.meta.url), 'utf8').trim(); }
    catch { return 'dev'; }
  })();
  const db = openDatabase(join(config.dataDir, 'platform.db'));
  const changelog = createChangelog(db);
  const announcements = createAnnouncements(db);
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
  const moderationMode = createModerationMode(db, config);
  const library = createLibrary({ db, catalog, config, limits, legacyRounds: new Set(show1Snapshot.works.map((work) => work.promptId)),
    moderationRoute: () => moderationMode.current });
  const adminService = createAdmin({ db, catalog, library });
  const inbox = createInbox({ library, config, limits });
  const catalogRevision = createCatalogRevision(db);
  const curated = createCurated({ db, catalog, library, questions });
  const arena = createArena({ db, catalog, library, limits, revision: catalogRevision, curated });
  const qualification = createQualification({ db, catalog, library, auth });
  const voters = createArenaVoters({ db, config });
  const voteRisk = createVoteRisk({ db, invalidate: () => arena.invalidate() });
  voteRisk.cleanup();
  const questionEligibility = user => ({ allowed: levelOf(user) >= 1, level: levelOf(user), requiredLevel: 1,
    ...(levelOf(user) < 1 ? { reason: 'level_required' } : {}) });
  const matchCleanup = setInterval(() => { arena.cleanupExpiredMatches(); voters.cleanup(); voteRisk.cleanup(); }, 60e3);
  matchCleanup.unref();
  const featured = createFeatured({ db, catalog, library, arena });
  const comments = createComments(db, library);
  const capturer = captureFactory({ config, library });
  const moderator = createModerator({ config, library, capturer, onChange: () => arena.invalidate(), routing: moderationMode });
  const covers = createCoverStore({ db, library });
  const previews = createPreviewStore({ db, library });
  const dots = createDotsModeration({ db, config, library, mode: moderationMode, tokens: createModerationTokens(db),
    covers, previews, coverBytes: limits.coverBytes, onChange: () => arena.invalidate(),
    categoryOf: (taskId) => catalog.task(taskId)?.category ?? '', tasksIn: (category) => catalog.tasks().filter((task) => task.category === category).map((task) => task.id) });
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
    `frame-src 'self' https://challenges.cloudflare.com ${config.contentTemplate.replace('{token}', '*')} ${config.contentPathOrigin || ''}`,
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

  const versionInfo = (snapshot = catalog.snapshot()) => ({
    datapack: snapshot.commit, catalogDigest: snapshot.catalogDigest, apiVersion: 2,
  });
  const siteInfo = () => ({
    content: config.contentPathOrigin ? `${config.contentPathOrigin}/v/{token}` : config.contentTemplate,
    cdn: config.cdn,
    capture: capturer.available,
    contentModeration: moderator.enabled,
    autoModeration: moderator.enabled && Boolean(config.moderation?.apiKey) && capturer.available,
    efforts: EFFORTS,
    emojis: EMOJIS,
    avatars: AVATARS,
    limits: { uploadBytes: limits.uploadBytes, coverBytes: limits.coverBytes, referenceCount: limits.referenceCount,
      referenceBytes: limits.referenceBytes, pendingPerUser: limits.pendingPerUser, provisionalGames: limits.provisionalGames },
  });
  const galleryWorks = () => library.allWorks().filter((work) => library.visibleTo(work, 'show2'));
  async function galleryList(user, snapshot = catalog.snapshot()) {
    await yieldToRequests();
    const allWorks = catalog.withSnapshot(() => library.allWorks({ snapshot }));
    const works = [];
    for (let i = 0; i < allWorks.length; i += 32) {
      catalog.withSnapshot(() => {
        for (const work of allWorks.slice(i, i + 32)) if (library.visibleTo(work, 'show2')) works.push(library.toPublic(work, user));
      });
      await yieldToRequests();
    }
    return works;
  }
  const withoutMine = ({ mine, ...item }) => item;
  const activityRevision = () => `${catalog.snapshot().version}|${catalogRevision()}`;
  const publicCatalog = createCatalogResponse(db, catalog, async (snapshot) => ({
    ...versionInfo(snapshot), serverVersion, providers: snapshot.providers(), domains: DOMAINS, domainGroups: DOMAIN_GROUPS,
    site: siteInfo(), works: (await galleryList(null, snapshot)).map(withoutMine), questions: catalog.withSnapshot(() => questions.all().map(withoutMine)),
  }), { revision: catalogRevision });
  function session(user) {
    return {
      ...versionInfo(),
      user: user ? { ...auth.public(user), emailBound: Boolean(user.email) } : null,
      qualification: qualification.progress(user),
      me: user ? {
        votes: arena.votesBy(user.id), pending: library.pendingCount(user.id),
        questionEligibility: questionEligibility(user),
        pendingLimit: library.pendingLimit(user), updates: library.updatesCount(user.id),
      } : null,
    };
  }
  function review(user) {
    const uploads = isStaff(user) ? library.uploads() : [];
    return isStaff(user) ? {
        // Same queue as the Gallery review page: released content on a public question that the
        // gallery has not decided yet, which includes uploads already verified for the arena.
        unverified: library.reviewQueue().length,
        content: uploads.filter((work) => work.moderation.status === 'review').length,
        autoRejected: uploads.filter((work) => work.moderation.status === 'rejected' && work.moderation.source !== 'human').length,
        injected: uploads.filter((work) => work.moderation.categories?.includes('prompt-injection')).length,
        questions: isSenior(user) ? questions.pendingCount() : 0,
      } : null;
  }
  const publicPools = createSharedRead({ revision: activityRevision, read: async () => {
    const snapshot = catalog.snapshot();
    const pools = new Map(), arenaStats = {};
    for (const task of catalog.withSnapshot(() => catalog.tasks())) {
      if (isAiJudgedTask(task)) continue;
      catalog.withSnapshot(() => {
        const pool = library.eligible(task.id, snapshot);
        pools.set(task.id, pool);
        arenaStats[task.id] = arena.poolStats(task.id, pool);
      });
      await yieldToRequests();
    }
    return { snapshot, pools, arenaStats };
  } });
  async function activity(user) {
    for (;;) {
      const revision = activityRevision();
      const { snapshot, pools, arenaStats } = await publicPools();
      const totals = await arena.totals(snapshot);
      const result = catalog.withSnapshot(() => ({
        ...versionInfo(snapshot), reactions: library.reactionSummary(user), arena: arenaStats,
        ...(isSenior(user) ? { arenaModels: arena.poolModels(pools) } : {}),
        featured: featured.read(), totals,
        workAccess: user ? galleryWorks().map((work) => library.access(work, user)) : [],
        review: review(user),
      }));
      if (activityRevision() === revision) return result;
    }
  }
  // `lite` leaves out `works` (most of the body); everything else, including
  // serverVersion and datapack, stays. Older servers ignore the parameter.
  async function bootstrap(user, { lite = false } = {}) {
    const snapshot = catalog.snapshot();
    const { workAccess, ...live } = await activity(user);
    return { ...versionInfo(snapshot), serverVersion, providers: snapshot.providers(), domains: DOMAINS, domainGroups: DOMAIN_GROUPS,
      site: siteInfo(), ...(lite ? {} : { works: await galleryList(user, snapshot) }), questions: questions.all(user), ...session(user), ...live };
  }
  // Signed-out bootstrap is the same for everyone, so it is built once per generation.
  // Signed-in requests never touch it. private keeps CDNs from storing it.
  const bootstrapActivity = createActivityRevision(db);
  const anonymousBootstrap = (lite) => createSharedJson({
    strict: () => `${catalog.snapshot().version}|${catalogRevision()}|${capturer.available}|${moderator.enabled}`,
    loose: bootstrapActivity,
    read: () => bootstrap(null, { lite }),
    ttl: config.bootstrapCacheMs ?? 15_000,
    cacheControl: 'private, no-cache',
    label: 'bootstrap',
  });
  const publicBootstrap = { full: anonymousBootstrap(false), lite: anonymousBootstrap(true) };

  const router = createRouter();
  router.on('GET', '/api/announcements', ctx => sendJson(ctx.res, 200, announcements.published(), { 'Cache-Control': 'no-cache' }));
  router.on('GET', '/api/announcements/events', ctx => retiredAnnouncementStream(ctx.req, ctx.res));
  router.on('POST', '/api/admin/announcements', async ctx => {
    const actor = adminOnly(ctx);
    return announcements.create(actor, await readJson(ctx.req));
  });
  router.on('GET', '/api/changelog', ctx => sendJson(ctx.res, 200, changelog.published(ctx.url.searchParams.get('limit')), { 'Cache-Control': 'no-cache' }));
  router.on('GET', '/api/admin/changelog', ctx => { adminOnly(ctx); return changelog.all(); });
  router.on('POST', '/api/admin/changelog', async ctx => {
    const actor = adminOnly(ctx);
    return changelog.create(actor, await readJson(ctx.req));
  });
  router.on('POST', '/api/admin/changelog/:id', async ctx => {
    const actor = adminOnly(ctx);
    return changelog.update(actor, ctx.params.id, await readJson(ctx.req));
  });
  router.on('DELETE', '/api/admin/changelog/:id', ctx => { adminOnly(ctx); return changelog.remove(ctx.params.id); });
  router.on('GET', '/api/fold.js', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': foldScript.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : foldScript);
  });
  router.on('GET', '/api/bootstrap', (ctx) => {
    const lite = ctx.url.searchParams.get('lite') === '1';
    if (!ctx.user) return publicBootstrap[lite ? 'lite' : 'full'](ctx.req, ctx.res);
    return bootstrap(ctx.user, { lite });
  });
  router.on('GET', '/api/catalog', ({ req, res }) => publicCatalog(req, res));
  router.on('GET', '/api/session', (ctx) => session(ctx.user));
  router.on('GET', '/api/activity', (ctx) => activity(ctx.user));
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
    user: ctx.user ? { id: ctx.user.id, username: ctx.user.name, role: ctx.user.role === 'admin' ? 'admin' : null, email: ctx.user.email ?? null, avatar: avatarOf(ctx.user), level: levelOf(ctx.user), levelSince: auth.public(ctx.user).levelSince, levelSource: ctx.user.level_source ?? null } : null,
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
    const user = requireContributor(signedIn(ctx));
    emailBound(ctx);
    limit.write(user.id);
    const body = await readJson(ctx.req, 6 * 1024 * 1024);
    requireCategory(body.category);
    if (!Object.hasOwn(body, 'draftId') && !Object.hasOwn(body, 'work') && !Object.hasOwn(body, 'confirmed')) {
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
    const user = requireContributor(signedIn(ctx));
    emailBound(ctx);
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
    const user = requireContributor(signedIn(ctx));
    emailBound(ctx);
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
  // Who decides new submissions: machine, dots or dots-review-only (null returns to MODERATION_MODE).
  router.on('GET', '/api/admin/moderation-mode', (ctx) => { adminOnly(ctx); return moderationMode.describe(); });
  router.on('POST', '/api/admin/moderation-mode', async (ctx) => {
    const admin = adminOnly(ctx);
    const body = await readJson(ctx.req);
    const result = moderationMode.set(body.mode === 'env' ? null : body.mode ?? null, admin.name);
    db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, NULL, NULL, ?)')
      .run(Date.now(), admin.id, admin.name, 'moderation-mode', JSON.stringify({ mode: body.mode ?? null }));
    moderator.sweep();
    return result;
  });
  // Cover history and rollback (covers replaced by dots); old files are never deleted.
  router.on('GET', '/api/works/:task/:id/cover-history', (ctx) => {
    adminOnly(ctx);
    const work = library.work(ctx.params.task, ctx.params.id);
    if (!work || work.curated) fail(404, '作品不存在');
    return { cover: work.cover ? `media/${work.id}/${work.cover}` : null, entries: covers.history(work) };
  });
  // Previews uploaded by dots: history and rollback; baked previews are never touched.
  router.on('GET', '/api/works/:task/:id/preview-history', (ctx) => {
    adminOnly(ctx);
    const work = library.work(ctx.params.task, ctx.params.id);
    if (!work || work.curated) fail(404, '作品不存在');
    return { current: previews.current(work).version, entries: previews.history(work) };
  });
  router.on('POST', '/api/works/:task/:id/preview/rollback', async (ctx) => {
    const admin = adminOnly(ctx);
    const body = await readJson(ctx.req);
    const result = previews.rollback(library.work(ctx.params.task, ctx.params.id), body.historyId ?? null, { id: admin.id, name: admin.name });
    arena.invalidate();
    return result;
  });
  router.on('POST', '/api/works/:task/:id/cover/rollback', async (ctx) => {
    const admin = adminOnly(ctx);
    const body = await readJson(ctx.req);
    const result = covers.rollback(library.work(ctx.params.task, ctx.params.id), body.historyId ?? null, { id: admin.id, name: admin.name });
    arena.invalidate();
    return result;
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
    // Reuse question lookups within this response only; the next request reads current decisions.
    return catalog.withSnapshot(() => ({
      works: library.allWorks().map((work) => library.adminWork(work, admin)), audit: library.auditLog(),
      questions: isSenior(admin) ? questions.adminAll(admin) : [],
    }));
  });

  // Account administration for Gallery's member list and the admin web app (the CLI in server/cli.mjs does the same).
  router.on('GET', '/api/admin/users', (ctx) => {
    adminOnly(ctx);
    const summaries = qualification.summaries();
    return { users: adminService.members(auth.list()).map(user => ({ ...user, exam: summaries.get(user.id) ?? { passedAt: null, attempts: 0, bestCorrect: null, questionCount: null } })) };
  });
  router.on('POST', '/api/admin/users/:id/role', async (ctx) => {
    const admin = adminOnly(ctx);
    limit.write(admin.id);
    const body = await readJson(ctx.req);
    const user = auth.setRole(admin, ctx.params.id, body.level ?? String(body.role ?? ''));
    library.audit(admin, 'role', null, `${user.name} → Lv${user.level}`);
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

  router.on('GET', '/api/arena/policy', ctx => voters.policy(voters.actor(ctx)));
  router.on('POST', '/api/arena/matches', async ctx => {
    limit.matches(ctx.user?.id ?? ctx.ip);
    const body = await readJson(ctx.req), actor = voters.actor(ctx);
    return voters.serial(actor, async () => {
      await voters.beforeMatch(actor, body.turnstileToken, ctx.ip);
      const task = String(body.task ?? '');
      const match = await arena.createMatch(ctx.user, task, body.previous, checkDatapack(ctx, task), body.avoidCooling === true,
        body.pin ? String(body.pin) : null, actor.visitorHash);
      db.prepare('UPDATE matches SET draw_ip=?,draw_subnet=? WHERE id=?').run(normalizeIp(ctx.ip),subnetOf(ctx.ip),match.id);
      return { ...match, challenge: voters.challenge(actor) };
    });
  });
  router.on('POST', '/api/arena/matches/:id/ready', async ctx => {
    limit.write(ctx.user?.id ?? ctx.ip);
    const actor = voters.actor(ctx);
    return voters.serial(actor, () => arena.ready(ctx.user, ctx.params.id, actor.visitorHash));
  });
  router.on('POST', '/api/arena/matches/:id/vote', async ctx => {
    limit.write(ctx.user?.id ?? ctx.ip);
    const body = await readJson(ctx.req), actor = voters.actor(ctx), choice = String(body.choice ?? '');
    return voters.serial(actor, async () => {
      if (ctx.user) actor.user = auth.byId(ctx.user.id);
      const evidence = voteRisk.capture(actor,ctx.params.id,choice,ctx);
      let proof;
      try {
        const match = arena.checkVote(actor.user, ctx.params.id, choice, actor.visitorHash);
        proof = await voters.beforeVote(actor, match, choice, body.turnstileToken, ctx.ip, ctx.receivedAt);
        if (ctx.user) actor.user = auth.byId(ctx.user.id);
        const result = arena.vote(actor.user, ctx.params.id, choice, { visitorHash: actor.visitorHash,
          accept: current => voters.accept(actor, current, choice, proof),
          recordDecision: () => voteRisk.record(evidence,{accepted:true,verified:proof.verified,lastVerifiedAt:voters.lastVerifiedAt(actor)}) });
        return { ...result, challenge: voters.challenge(actor) };
      } catch (error) {
        voteRisk.record(evidence,{errorCode:error.code||`http_${error.status??500}`,verified:proof?.verified,lastVerifiedAt:voters.lastVerifiedAt(actor)});
        throw error;
      }
    });
  });
  router.on('GET','/api/admin/vote-risk/summary',ctx=>voteRisk.summary(adminOnly(ctx),ctx.url.searchParams));
  router.on('GET','/api/admin/vote-risk/choices',ctx=>voteRisk.choices(adminOnly(ctx),ctx.url.searchParams));
  router.on('GET','/api/admin/vote-risk/model-voters',ctx=>voteRisk.modelVoters(adminOnly(ctx),ctx.url.searchParams));
  router.on('POST','/api/admin/vote-risk/votes/void',async ctx=>{const actor=adminOnly(ctx);limit.write(actor.id);return voteRisk.voidVotes(actor,await readJson(ctx.req));});
  router.on('POST','/api/admin/vote-risk/votes/restore',async ctx=>{const actor=adminOnly(ctx);limit.write(actor.id);return voteRisk.restoreVotes(actor,await readJson(ctx.req));});
  router.on('GET', '/api/curated', () => curated.info());
  router.on('GET', '/api/admin/curated', ctx => curated.adminInfo(adminOnly(ctx)));
  router.on('POST', '/api/admin/curated/sections', async ctx => curated.createSection(adminOnly(ctx), await readJson(ctx.req)));
  router.on('PATCH', '/api/admin/curated/sections/:id', async ctx => curated.editSection(adminOnly(ctx), ctx.params.id, await readJson(ctx.req)));
  router.on('PUT', '/api/admin/curated/sections/order', async ctx => curated.orderSections(adminOnly(ctx), await readJson(ctx.req)));
  router.on('DELETE', '/api/admin/curated/sections/:id', async ctx => curated.deleteSection(adminOnly(ctx), ctx.params.id, await readJson(ctx.req)));
  router.on('PUT', '/api/admin/curated/questions', async ctx => curated.saveQuestions(adminOnly(ctx), await readJson(ctx.req)));
  router.on('GET', '/api/qualification', ctx => qualification.overview(signedIn(ctx)));
  router.on('POST', '/api/qualification/attempts', async ctx => { const user = signedIn(ctx); limit.write(user.id); return qualification.start(user, await readJson(ctx.req)); });
  router.on('GET', '/api/qualification/attempts/:id', ctx => qualification.get(signedIn(ctx), ctx.params.id));
  router.on('POST', '/api/qualification/attempts/:id/items/:itemId/ready', ctx => { const user = signedIn(ctx); limit.write(user.id); return qualification.ready(user, ctx.params.id, ctx.params.itemId); });
  router.on('PUT', '/api/qualification/attempts/:id/items/:itemId/answer', async ctx => { const user = signedIn(ctx); limit.write(user.id); return qualification.answer(user, ctx.params.id, ctx.params.itemId, (await readJson(ctx.req)).choice); });
  router.on('POST', '/api/qualification/attempts/:id/submit', ctx => { const user = signedIn(ctx); limit.write(user.id); return qualification.submit(user, ctx.params.id); });
  router.on('GET', '/api/admin/qualification', ctx => qualification.adminInfo(adminOnly(ctx)));
  router.on('GET', '/api/admin/qualification/works', ctx => qualification.works(adminOnly(ctx), ctx.url.searchParams.get('taskId')));
  router.on('PUT', '/api/admin/qualification/settings', async ctx => qualification.saveSettings(adminOnly(ctx), await readJson(ctx.req)));
  router.on('POST', '/api/admin/qualification/pairs', async ctx => qualification.savePair(adminOnly(ctx), await readJson(ctx.req)));
  router.on('PATCH', '/api/admin/qualification/pairs/:id', async ctx => qualification.savePair(adminOnly(ctx), await readJson(ctx.req), ctx.params.id));
  router.on('DELETE', '/api/admin/qualification/pairs/:id', async ctx => qualification.deletePair(adminOnly(ctx), ctx.params.id, await readJson(ctx.req)));
  router.on('GET', '/api/leaderboard', (ctx) => {
    const board = ctx.url.searchParams.get('board') || null;
    const audience = ctx.url.searchParams.get('audience') || null, sectionId = ctx.url.searchParams.get('sectionId') || null;
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
    return arena.leaderboardSnapshot({ task, category, domain, board, audience, sectionId, by: ctx.url.searchParams.get('by') === 'model' ? 'model' : 'config', ...filters });
  });

  registerShow1Compat(router, { db, catalog, library, snapshot: show1Snapshot, config, limit });
  registerShow1Guess(router, { db, limit, config, adminOnly });
  const guessRooms = registerGuessRooms(router, { db, auth, config });

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
      // Packaged references only change with the data package and the gallery
      // version stamps the URL (?v=), so browsers may keep them indefinitely.
      // Private: question visibility is re-checked per request, a shared cache
      // must not answer for a viewer the gate would reject.
      return streamFile(req, res, found, { 'Cache-Control': 'private, max-age=31536000, immutable', 'Vary': 'Origin, Cookie',
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
    const media = /^\/media\/(up-[a-z0-9]{8})\/(cover(?:-[a-z0-9]{8,24})?\.(?:png|jpg|webp)|first\.jpg|mobile\.jpg|preview\.(?:sbox|webp|jpg)|preview-[a-z0-9]{8,24}\.sbox)$/.exec(pathname);
    if (pathname.startsWith('/media/')) {
      const work = media && library.uploadById(media[1]);
      if (!library.canRead(work, auth.userFrom(req))) return sendJson(res, 404, { error: '文件不存在' });
      const found = media && resolveInside(library.mediaDir, `/${media[1]}/${media[2]}`);
      if (!found) return sendJson(res, 404, { error: '文件不存在' });
      // Covers and screenshots keep their file names while re-bakes overwrite
      // them, so published works get a short private cache instead of immutable;
      // legacy media is frozen and stays shareable.
      return streamFile(req, res, found, { 'Cache-Control': work.moderation.status === 'legacy' ? 'public, max-age=300' : 'private, max-age=600', 'Content-Security-Policy': "default-src 'none'" });
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
          res.setHeader('Access-Control-Expose-Headers', ['/api/catalog', '/api/bootstrap'].includes(url.pathname) ? 'X-Datapack-Stale, ETag, Server-Timing' : 'X-Datapack-Stale');
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
        if (headers.some((header) => !['content-type', 'x-datapack-version', 'if-none-match'].includes(header))) fail(403, '请求头无效');
        res.writeHead(204, {
          'Access-Control-Allow-Methods': method,
          'Access-Control-Allow-Headers': 'Content-Type, X-Datapack-Version, If-None-Match',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, '不支持这个操作');
        return serveSite(req, res, url.pathname);
      }
      // Moderation tokens open only the dots whitelist; every other API refuses them.
      if (url.pathname.startsWith('/api/dots/')) return dots.handle(req, res, url);
      if (/^bearer\s/i.test(String(req.headers.authorization ?? ''))) fail(403, '审核令牌不能访问此接口', 'token_forbidden');
      if (req.method === 'GET' || req.method === 'HEAD') readGuard.api(req, url.pathname);
      if (['GET', 'HEAD'].includes(req.method)
        && ['/api/bootstrap', '/api/catalog', '/api/show1/works', '/api/works', '/api/prompts', '/api/votes', '/api/ratings'].includes(url.pathname)
        && ['limit', 'offset', 'page'].some((key) => url.searchParams.has(key))) fail(400, '此接口返回完整目录，不支持分页参数', 'unsupported_pagination');
      const route = router.match(req.method, url.pathname);
      if (!route) fail(404, '接口不存在');
      if (route.methodNotAllowed) fail(405, '不支持这个操作');
      if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req, config);
      const ctx = { req, res, url, params: route.params, receivedAt: Date.now(), ip: clientIp(req, config.trustProxy),
        user: url.pathname === '/api/catalog' ? null : auth.userFrom(req) };
      const result = await route.handler(ctx);
      if (!res.headersSent) return sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}),
        ...(error.details ?? {}), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) },
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      console.error(error);
      return sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
    }
  }

  return {
    db,
    auth,
    curated, qualification, voters, voteRisk,
    library,
    references,
    arena,
    featured,
    capturer,
    moderator,
    warmLeaderboards() { if (config.leaderboardWarmup !== false) arena.startWarmup(); },
    handleSite,
    // Long-lived responses end first so draining the HTTP servers does not wait on them.
    closeStreams() { guessRooms.closeStreams(); },
    handleContent: createContentHandler({ config, library, arena, qualification, catalog, siteOrigins: config.siteOrigins, readGuard }),
    async close() {
      guessRooms.close();
      clearInterval(matchCleanup);
      clearInterval(referenceCleanup);
      await emailAuth.drain();
      await Promise.all([moderator.close(), capturer.close()]);
      await featured.close();
      await arena.close();
      db.close();
    },
  };
}
