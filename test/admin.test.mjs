import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

const html = '<!doctype html><html><head><title>作品</title></head><body><h1>作品</h1></body></html>';

test('v9 backfills both switches from every v8 audience and reopens without data loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-migration-'));
  const file = join(root, 'platform.db');
  try {
    const old = new DatabaseSync(file);
    for (let i = 0; i < 8; i++) old.exec(MIGRATIONS[i]);
    old.exec('PRAGMA user_version = 8');
    const insert = old.prepare(`INSERT INTO works
      (id, task_id, title, model_name, content_key, source_name, root, entry, file_count, bytes, digest, checks, trial, created_at, updated_at, audience)
      VALUES (?, 'one', '作品', '模型', ?, 'a.html', '', 'index.html', 1, 100, ?, '[]', '{}', 1, 1, ?)`);
    for (const audience of ['both', 'show1', 'show2', 'hidden']) insert.run(audience, `key-${audience}`, `digest-${audience}`, audience);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDatabase(file);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
      // v9 按 v8 受众回填两面；v10（分面审核新规）再把存量作品的展览馆面重置为待审。
      assert.deepEqual(db.prepare('SELECT id, show_gallery, show_arena FROM works ORDER BY id').all().map(({ id, show_gallery, show_arena }) => [id, show_gallery, show_arena]), [
        ['both', 0, 1], ['hidden', 0, 0], ['show1', 0, 1], ['show2', 0, 0],
      ]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 4);
      db.close();
    }
  } finally {
    // Windows 上 node:sqlite 做过 ALTER TABLE 后目录句柄偶尔迟放，清不掉就留给系统清。
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'EPERM' || attempt === 4) { if (error.code !== 'EPERM') throw error; } else await new Promise((done) => setTimeout(done, 400)); }
    }
  }
});

async function withPlatform(run, configOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'admin-api-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'results', 'one', 'a'), { recursive: true });
  mkdirSync(join(dist, 'results', 'one', 'b'), { recursive: true });
  for (const id of ['a', 'b']) writeFileSync(join(dist, 'results', 'one', id, 'index.html'), html);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ schemaVersion: 1, title: '测试馆藏', models: [
    { id: 'ma', name: '模型甲', vendor: '甲' }, { id: 'mb', name: '模型乙', vendor: '乙' },
  ], tasks: [{ id: 'one', title: '测试题', arenaId: '901', results: [
    { id: 'a', title: '精选甲', model: 'ma', scene: 'results/one/a/', generationMode: 'single-turn', humanIntervention: 'none' },
    { id: 'b', title: '精选乙', model: 'mb', scene: 'results/one/b/', generationMode: 'single-turn', humanIntervention: 'none' },
  ] }, { id: 'two', title: '第二题', results: [] }] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), admin: join(process.cwd(), 'admin'),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: ['root'], cdn: [], capture: false,
    secureCookies: false, trustProxy: false, ...configOptions }, limits });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  async function call(who, method, path, body = undefined, raw = false) {
    const headers = { ...(method !== 'GET' ? { Origin: base } : {}), ...(cookies.get(who) ? { Cookie: cookies.get(who) } : {}) };
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) cookies.set(who, cookie.split(';')[0]);
    return { status: response.status, data: await response.json() };
  }
  try {
    platform.auth.createAdmin('root', 'correct horse');
    const voter = await platform.auth.register('voter', 'correct horse');
    platform.auth.bindEmail(voter.id, 'voter@example.test');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
    assert.equal((await call('voter', 'POST', '/api/auth/login', { name: 'voter', password: 'correct horse' })).status, 200);
    await run({ platform, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('face review migration preserves old decisions and leaves unverified uploads pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-face-review-'));
  const file = join(root, 'platform.db');
  try {
    const old = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 29)) {
      if (typeof migration === 'function') migration(old);
      else old.exec(migration);
    }
    old.exec('PRAGMA user_version = 29');
    const insert = old.prepare(`INSERT INTO works
      (id, task_id, title, model_other, content_key, source_name, root, entry, file_count, bytes, digest, checks, trial, created_at, updated_at, status, reviewed_at)
      VALUES (?, 'one', '作品', '模型', ?, 'a.html', '', 'index.html', 1, 100, ?, '[]', '{}', 1, 2000, ?, ?)`);
    for (const [status, reviewedAt] of [['verified', 1000], ['questioned', null], ['unverified', null]]) {
      insert.run(status, `key-${status}`, `digest-${status}`, status, reviewedAt);
    }
    old.close();
    const db = openDatabase(file);
    try {
      const decisions = () => db.prepare('SELECT id, reviewed_gallery_at, reviewed_arena_at FROM works ORDER BY id').all()
        .map(({ id, reviewed_gallery_at, reviewed_arena_at }) => [id, reviewed_gallery_at, reviewed_arena_at]);
      assert.deepEqual(decisions(), [['questioned', 2000, 2000], ['unverified', null, null], ['verified', 1000, 1000]]);
      MIGRATIONS[29](db);
      assert.deepEqual(decisions(), [['questioned', 2000, 2000], ['unverified', null, null], ['verified', 1000, 1000]]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v34 fills a missing arena stamp on verified works and leaves unverified rows alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-stamp-backfill-'));
  const file = join(root, 'platform.db');
  const db = openDatabase(file);
  try {
    db.exec(`INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES ('u', 'reader', 'reader', 'member', 's', 'h', 1)`);
    const insert = db.prepare(`INSERT INTO works (id, task_id, title, model_other, content_key, source_name, root, entry,
      file_count, bytes, digest, checks, trial, created_at, updated_at, status, reviewed_gallery_at, reviewed_arena_at)
      VALUES (?, 'one', '作品', '模型', ?, 'a.html', '', 'index.html', 1, 10, ?, '[]', '{}', 1, 80, ?, ?, ?)`);
    insert.run('stamped', 'k1', 'd1', 'verified', 40, null);
    insert.run('open', 'k2', 'd2', 'unverified', null, null);
    MIGRATIONS[33](db); // v34 fills missing verification stamps.
    const row = (id) => db.prepare('SELECT status, reviewed_gallery_at, reviewed_arena_at FROM works WHERE id = ?').get(id);
    assert.deepEqual({ ...row('stamped') }, { status: 'verified', reviewed_gallery_at: 40, reviewed_arena_at: 40 });
    assert.deepEqual({ ...row('open') }, { status: 'unverified', reviewed_gallery_at: null, reviewed_arena_at: null });
    MIGRATIONS[33](db);
    assert.deepEqual({ ...row('stamped') }, { status: 'verified', reviewed_gallery_at: 40, reviewed_arena_at: 40 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a first verification decides both faces and face settings preserve status', async () => withPlatform(async ({ call }) => {
  const draft = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const submitted = await call('voter', 'POST', '/api/works', {
    draftId: draft.data.draft.id, confirmed: true, title: '分面核验作品', modelName: '模型丙', effort: 'Default', providerId: 'official', harnessOther: '测试工具',
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const id = submitted.data.work.id;
  const uploaded = async () => (await call('root', 'GET', '/api/admin/works?source=upload')).data.works.find((work) => work.id === id);
  assert.deepEqual((await uploaded()).reviewed, { gallery: null, arena: null });
  const review = await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', show_gallery: true });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  const galleryReviewed = await uploaded();
  assert.ok(galleryReviewed.reviewed.gallery);
  assert.ok(galleryReviewed.reviewed.arena, 'verification stamps both faces even when the request names one');
  assert.equal(galleryReviewed.show_arena, true);
  assert.equal(galleryReviewed.show_entertainment, true, 'a first verification opens entertainment unless the request says otherwise');
  assert.equal(galleryReviewed.entertainment_route, 0);
  assert.deepEqual(galleryReviewed.arena, { state: 'not_qualified', reason: '生成方式未填写' });
  const entertainment = await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_entertainment: true });
  assert.deepEqual(entertainment.data.work.reviewed, galleryReviewed.reviewed);
  const settings = await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_arena: false });
  assert.equal(settings.status, 200);
  assert.ok(settings.data.work.reviewed.arena);
  assert.equal(settings.data.work.reviewed.gallery, galleryReviewed.reviewed.gallery);
  assert.equal(settings.data.work.status, 'verified');
  assert.deepEqual(settings.data.work.arena, { state: 'off' });
  const again = await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified' });
  assert.deepEqual(again.data.work.arena, { state: 'off' }, 'a repeated verification keeps an admin opt-out');
  const restamped = await uploaded();
  assert.equal(restamped.reviewed.gallery, galleryReviewed.reviewed.gallery);
  assert.equal(restamped.reviewed.arena, settings.data.work.reviewed.arena);
  const curated = (await call('root', 'GET', '/api/admin/works?source=curated')).data.works;
  assert.ok(curated.every((work) => !Object.hasOwn(work, 'reviewed')));
}));

test('verification clears the gallery review count whichever face the request names', async () => withPlatform(async ({ call }) => {
  const pending = async () => (await call('root', 'GET', '/api/bootstrap')).data.review.unverified;
  const before = await pending();
  const draft = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
  const submitted = await call('voter', 'POST', '/api/works', {
    draftId: draft.data.draft.id, confirmed: true, title: '竞技场先核验', modelName: '模型丙', effort: 'Default', providerId: 'official', harnessOther: '测试工具',
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const id = submitted.data.work.id;
  assert.equal(await pending(), before + 1);
  assert.equal((await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', show_arena: true })).status, 200);
  assert.equal(await pending(), before);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_gallery: false })).status, 200);
  assert.equal(await pending(), before);
}));

async function withModeratedUpload(run) {
  return withPlatform(async ({ platform, call }) => {
    const queued = [];
    platform.moderator.enqueue = (work) => queued.push(work);
    const draft = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
    const submitted = await call('voter', 'POST', '/api/works', {
      draftId: draft.data.draft.id, confirmed: true, title: '待核验作品', modelName: '模型丙',
      effort: 'Default', providerId: 'official', harnessOther: '测试工具',
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    const id = submitted.data.work.id;
    assert.equal((await call('root', 'POST', `/api/works/one/${id}/moderation`, {
      status: 'approved', reason: '人工检查通过',
    })).status, 200);
    const work = () => platform.library.work('one', id);
    const moderation = work().moderation;
    queued.length = 0;
    await run({ platform, call, id, work, moderation, queued });
  }, { moderation: { enabled: true } });
}

test('admin metadata corrections preserve approved content and allow verification', async () => withModeratedUpload(async ({ call, id, work, moderation }) => {
  const edited = await call('root', 'POST', `/api/admin/works/one/${id}/meta`, { effort: 'High', modelId: 'ma' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.deepEqual(work().moderation, moderation);
  assert.equal(work().status, 'unverified');
  assert.equal((await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', show_gallery: true })).status, 200);
}));

test('admin title and summary edits retain the complete moderation result', async () => withModeratedUpload(async ({ call, id, work, moderation }) => {
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/meta`, { title: '修正标题', summary: '修正摘要' })).status, 200);
  assert.deepEqual(work().moderation, moderation);
}));

test('author summary edits reset approved content and enqueue another review', async () => withModeratedUpload(async ({ call, id, work, queued }) => {
  assert.equal((await call('voter', 'PATCH', `/api/works/one/${id}`, { summary: '作者新摘要' })).status, 200);
  assert.equal(work().moderation.status, 'pending');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, id);
  assert.equal(queued[0].moderation.status, 'pending');
}));

test('admin verification with an effort correction preserves approved content', async () => withModeratedUpload(async ({ call, id, work, moderation }) => {
  const reviewed = await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', effort: 'High', show_gallery: true });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(work().effort, 'High');
  assert.equal(work().status, 'verified');
  assert.deepEqual(work().moderation, moderation);
}));

test('batch content review returns ordered partial results and rejects invalid requests before writing', async () => withModeratedUpload(async ({ platform, call, id, work }) => {
  const items = [{ task: 'one', id }, { task: 'one', id: 'missing' }];
  const count = () => platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'content-review'").get().n;
  const before = count();
  const reviewed = await call('root', 'POST', '/api/admin/works/batch-moderation', { works: items, status: 'approved' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.deepEqual(reviewed.data.results.map(({ task, id: workId, ok }) => ({ task, id: workId, ok })), items.map((item, i) => ({ ...item, ok: i === 0 })));
  assert.equal(reviewed.data.results[0].work.moderation.reason, '人工复核通过');
  assert.deepEqual(reviewed.data.results[1].error, { status: 404, code: 'not_found', message: '作品不存在' });
  assert.equal(count(), before + 1);
  const row = platform.db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  for (const body of [
    { works: items, status: 'rejected' }, { works: 'wrong', status: 'approved' },
    { works: [...items, {}], status: 'approved' }, { works: Array(101).fill(items[0]), status: 'approved' },
    { works: items, status: 'pending' },
  ]) assert.equal((await call('root', 'POST', '/api/admin/works/batch-moderation', body)).status, 400);
  assert.equal(count(), before + 1);
  assert.deepEqual(platform.db.prepare('SELECT * FROM works WHERE id = ?').get(id), row);
  assert.equal(work().moderation.status, 'approved');
  assert.equal((await call('voter', 'POST', '/api/admin/works/batch-moderation', { works: items, status: 'approved' })).status, 403);
}));

test('batch verification supplements metadata and rolls back only failed items', async () => withModeratedUpload(async ({ platform, call, id, work, moderation, queued }) => {
  const create = async () => {
    const draft = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
    const response = await call('voter', 'POST', '/api/works', {
      draftId: draft.data.draft.id, confirmed: true, title: '批量作品', modelId: 'mb', harnessOther: '测试工具',
      effort: 'Default', providerId: 'official',
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.work.id;
  };
  const pending = await create();
  const incomplete = await create();
  await call('root', 'POST', `/api/works/one/${incomplete}/moderation`, { status: 'approved' });
  // Old registrations can lack the fields now required at submission.
  platform.db.prepare("UPDATE works SET effort = '', provider_id = NULL WHERE id IN (?, ?)").run(pending, incomplete);
  const auditCount = () => platform.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  const row = (workId) => platform.db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  const pendingBefore = row(pending), incompleteBefore = row(incomplete);
  let before = auditCount();
  queued.length = 0;
  const first = await call('root', 'POST', '/api/admin/works/batch-review', {
    works: [{ task: 'one', id: pending }, { task: 'one', id }, { task: 'one', id: incomplete }],
    status: 'verified', meta: { effort: 'High' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.results.map((result) => result.ok), [false, true, false]);
  assert.equal(first.data.results[0].error.status, 409);
  assert.equal(first.data.results[0].error.message, '请先完成内容审核');
  assert.equal(first.data.results[2].error.status, 400);
  assert.equal(first.data.results[2].error.message, '请选择服务商');
  assert.deepEqual(row(pending), pendingBefore);
  assert.deepEqual(row(incomplete), incompleteBefore);
  assert.equal(auditCount(), before + 2, 'only the successful meta and verified audits survive');
  assert.equal(first.data.results[1].work.show_gallery, true);
  assert.equal(work().effort, 'High');
  assert.deepEqual(work().moderation, moderation);
  assert.equal(queued.length, 0, 'administrator decisions do not enqueue moderation');
  before = auditCount();
  for (const body of [
    { works: [{ task: 'one', id: incomplete }], status: 'questioned', meta: { effort: 'Max' } },
    { works: [{ task: 'one', id: incomplete }], status: 'verified', meta: { title: '不允许的字段' } },
    { works: [{ task: 'one', id: incomplete }], status: 'verified', show_arena: 'yes' },
  ]) assert.equal((await call('root', 'POST', '/api/admin/works/batch-review', body)).status, 400);
  assert.equal(auditCount(), before);
  assert.deepEqual(row(incomplete), incompleteBefore);
  const second = await call('root', 'POST', '/api/admin/works/batch-review', {
    works: [{ task: 'one', id: incomplete }], status: 'verified', meta: { effort: 'High', providerId: 'official' }, show_arena: true,
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.results[0].ok, true, JSON.stringify(second.data));
  assert.equal(second.data.results[0].work.status, 'verified');
  assert.equal(second.data.results[0].work.provider, 'official');
  assert.equal(second.data.results[0].work.show_gallery, true);
  assert.equal(second.data.results[0].work.show_arena, true, 'batch verification can open the arena face');
  assert.equal(second.data.results[0].work.moderation.status, 'approved');
  assert.equal(auditCount(), before + 2);
  const questioned = await call('root', 'POST', '/api/admin/works/batch-review', {
    works: [{ task: 'one', id: pending }], status: 'questioned', reason: '声明待核对',
  });
  assert.equal(questioned.data.results[0].ok, true);
  assert.equal(questioned.data.results[0].work.status, 'questioned');
}));

test('admin API merges curated and upload works, applies face settings, calibration and audit', async () => withPlatform(async ({ platform, call }) => {
  const upload = await call('root', 'POST', '/api/admin/works/upload?effort=Default&providerId=official&task=one&name=work.html&title=代传作品&modelName=模型丙&show_gallery=1&show_arena=1', html, true);
  assert.equal(upload.status, 200, JSON.stringify(upload.data));
  const id = upload.data.work.id;
  assert.equal(upload.data.work.status, 'verified');
  assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
  assert.equal((await call('voter', 'GET', '/api/admin/works')).status, 403);
  let list = await call('root', 'GET', '/api/admin/works?task=one&pageSize=2&page=1');
  assert.equal(list.data.total, 3);
  assert.equal(list.data.works.length, 2);
  assert.equal((await call('root', 'GET', '/api/admin/works?source=upload')).data.works.length, 1);
  const uploadSettings = await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_arena: false });
  assert.equal(uploadSettings.status, 200);
  assert.equal(platform.db.prepare('SELECT show_gallery, show_arena FROM works WHERE id = ?').get(id).show_arena, 0);
  const curatedSettings = await call('root', 'POST', '/api/admin/works/one/a/face-settings', { show_gallery: false, show_arena: false });
  assert.equal(curatedSettings.status, 200);
  assert.deepEqual({ ...platform.db.prepare('SELECT show_gallery, show_arena FROM work_overrides WHERE work_id = ?').get('a') }, { show_gallery: 0, show_arena: 0 });
  list = await call('root', 'GET', '/api/admin/works?face=arena&show=off');
  assert.equal(list.data.total, 2, 'curated works default to arena-on unless switched off');
  const framing = { width: 1440, height: 900, zoom: 1.2, offsetX: 0.1, offsetY: -0.2 };
  const camera = { position: [1, 2, 3], target: [0, 0, 0] };
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'gallery', calibration: { framing } })).status, 200);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'arena', calibration: { camera } })).status, 200);
  assert.equal((await call('root', 'POST', '/api/admin/works/one/a/calibration', { face: 'arena', calibration: { framing } })).status, 200);
  const rows = (await call('root', 'GET', '/api/admin/works')).data.works;
  assert.deepEqual(rows.find((w) => w.id === id).calibration_gallery.framing, framing);
  assert.deepEqual(rows.find((w) => w.id === id).calibration_arena.camera, camera);
  assert.deepEqual(rows.find((w) => w.id === 'a').calibration_arena.framing, framing);
  assert.ok(rows.every((row) => Number.isInteger(row.votes)), 'every row carries a ballot count');
  assert.equal(rows.find((w) => w.id === id).votes, 0);
  platform.db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at)
    VALUES ('v1', 'm1', NULL, 'one', 'a', 'b', 'one:a|b', 'a', 1)`).run();
  const counted = (await call('root', 'GET', '/api/admin/works')).data.works;
  assert.equal(counted.find((w) => w.id === 'a').votes, 1, 'appearances are counted per work');
  assert.equal(counted.find((w) => w.id === 'b').votes, 1);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'arena', calibration: { framing: { ...framing, zoom: 5 } } })).status, 400);
  assert.ok(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('submit','verified','face-settings','calibration')").get().n >= 6);
}));

test('admin preview keys serve curated works on the content origin with the capture bridge', async () => withPlatform(async ({ platform, call }) => {
  const content = createServer(platform.handleContent).listen(0, '127.0.0.1');
  await new Promise((resolve) => content.once('listening', resolve));
  const fetchPreview = (path, host) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: content.address().port, path, headers: { host } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal((await call('voter', 'POST', '/api/admin/works/one/a/preview')).status, 403);
    assert.equal((await call('root', 'POST', '/api/admin/works/one/zz/preview')).status, 404);
    const preview = await call('root', 'POST', '/api/admin/works/one/a/preview');
    assert.equal(preview.status, 200);
    assert.match(preview.data.url, /^http:\/\/p[0-9a-f]{32}\.localhost\/$/, 'a short-lived p key is issued');
    const host = new URL(preview.data.url).host;
    const page = await fetchPreview('/?aob=bridge&face=gallery', host);
    assert.equal(page.status, 200, 'the curated work itself is reachable through the key');
    assert.match(page.text, /__AOB_CAPTURE__=true/, 'the capture handshake is armed for the admin panel');
    const plain = await fetchPreview('/', host);
    assert.ok(!plain.text.includes('__AOB_CAPTURE__'), 'without aob=bridge the page stays untouched');
  } finally {
    await new Promise((resolve) => content.close(resolve));
  }
}));

test('admin meta re-homes an upload to another task and moves its history along', async () => withPlatform(async ({ platform, call }) => {
  const upload = await call('root', 'POST', '/api/admin/works/upload?effort=Default&providerId=official&task=one&name=work.html&title=搬家作品&modelName=模型丙&show_gallery=1', html, true);
  const id = upload.data.work.id;
  platform.db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at)
    VALUES ('mv1', 'mm1', NULL, 'one', ?, 'a', 'one:|a', 'a', 1)`).run(id);
  platform.db.prepare(`INSERT INTO comments (id, task_id, work_id, user_id, body, created_at)
    VALUES ('mc1', 'one', ?, NULL, '搬家前的评论', 1)`).run(id);
  const reactor = platform.db.prepare("SELECT id FROM users WHERE name = 'voter'").get().id;
  platform.db.prepare(`INSERT INTO reactions (task_id, work_id, user_id, emoji, created_at)
    VALUES ('one', ?, ?, '👏', 1)`).run(id, reactor);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/meta`, { task: 'nope' })).status, 400);
  const moved = await call('root', 'POST', `/api/admin/works/one/${id}/meta`, { task: 'two' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.work.task, 'two', 'the work itself is re-homed');
  const db = platform.db;
  assert.equal(db.prepare('SELECT task_id AS t FROM works WHERE id = ?').get(id).t, 'two');
  assert.equal(db.prepare('SELECT task_id AS t FROM votes WHERE id = ?').get('mv1').t, 'two', 'ballots move with the work');
  assert.equal(db.prepare('SELECT task_id AS t FROM comments WHERE id = ?').get('mc1').t, 'two', 'comments move with the work');
  assert.equal(db.prepare('SELECT task_id AS t FROM reactions WHERE work_id = ?').get(id).t, 'two', 'reactions move with the work');
  assert.match(db.prepare('SELECT detail AS d FROM audit WHERE action = ? AND work_id = ? ORDER BY id DESC LIMIT 1').get('meta', id).d, /one → two/);
}));

test('calibrating a curated work preserves its arena approval and invalidates the board', async () => withPlatform(async ({ platform, call }) => {
  let invalidations = 0;
  const invalidate = platform.arena.invalidate;
  platform.arena.invalidate = () => { invalidations++; invalidate(); };
  const framing = { width: 1440, height: 900, zoom: 1, offsetX: 0, offsetY: 0 };
  assert.equal((await call('root', 'POST', '/api/admin/works/one/a/calibration', { face: 'gallery', calibration: { framing } })).status, 200);
  assert.deepEqual({ ...platform.db.prepare('SELECT show_gallery, show_arena FROM work_overrides WHERE work_id = ?').get('a') },
    { show_gallery: 1, show_arena: 1 });
  assert.equal(invalidations, 1);
}));

test('admin batch face settings update curated and uploaded works atomically with one audit per work', async () => withPlatform(async ({ platform, call }) => {
  const upload = await call('root', 'POST', '/api/admin/works/upload?effort=Default&providerId=official&task=one&name=work.html&title=代传作品&modelName=模型丙', html, true);
  const id = upload.data.work.id;
  const path = '/api/admin/works/batch-face-settings';
  const works = [{ task: 'one', id: 'a' }, { task: 'one', id }];
  const auditCount = () => platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'face-settings'").get().n;
  assert.equal((await call('voter', 'POST', path, { works, show_gallery: false })).status, 403);
  const before = auditCount();
  const changed = await call('root', 'POST', path, { works, show_gallery: false, show_arena: true });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data.works.map((work) => [work.id, work.show_gallery, work.show_arena]), [
    ['a', false, true], [id, false, true],
  ]);
  assert.equal(auditCount(), before + 2);
  assert.equal(platform.db.prepare('SELECT show_gallery FROM work_overrides WHERE work_id = ?').get('a').show_gallery, 0);
  assert.equal(platform.db.prepare('SELECT show_gallery FROM works WHERE id = ?').get(id).show_gallery, 0);
  const failed = await call('root', 'POST', path, { works: [works[0], { task: 'one', id: 'missing' }], show_gallery: true });
  assert.equal(failed.status, 404);
  assert.equal(platform.db.prepare('SELECT show_gallery FROM work_overrides WHERE work_id = ?').get('a').show_gallery, 0);
  assert.equal(auditCount(), before + 2, 'the failed batch rolls back its audit too');
  const tooMany = await call('root', 'POST', path, { works: Array.from({ length: 201 }, () => works[0]), show_gallery: true });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.code, 'invalid_work_list');
}));

test('editorial validates weights, traffic aggregates, and arena switches remove matches and counted votes', async () => withPlatform(async ({ platform, call }) => {
  const baseline = {
    prompts: (await call('voter', 'GET', '/api/prompts')).data,
    works: (await call('voter', 'GET', '/api/works')).data,
    bootstrap: (await call('voter', 'GET', '/api/bootstrap')).data,
    board: (await call('voter', 'GET', '/api/leaderboard?task=one')).data,
  };
  assert.equal((await call('root', 'POST', '/api/admin/tasks/one/editorial', { face: 'arena', commentary: '这题重视视觉', weights: [0.5, 0.5, 0, 0, 0, 0] })).status, 200);
  // 兼容面 prompts 会带上刚存的点评与权重；基线重抓后再对比开关切换的影响。
  baseline.prompts = (await call('voter', 'GET', '/api/prompts')).data;
  const invalid = await call('root', 'POST', '/api/admin/tasks/one/editorial', { face: 'arena', commentary: '错', weights: [1, 0, 0, 0, 0, 0.1] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'invalid_weights');
  assert.equal((await call('root', 'POST', '/api/admin/tasks/one/editorial', { face: 'arena', commentary: '缺少权重' })).status, 400);
  assert.deepEqual((await call('root', 'GET', '/api/admin/tasks/one/editorial?face=arena')).data.weights, [0.5, 0.5, 0, 0, 0, 0]);
  assert.equal((await call('root', 'POST', '/api/admin/tasks/one/editorial', { face: 'gallery', commentary: '展览文案' })).status, 200);
  assert.equal((await call('root', 'GET', '/api/admin/tasks/one/editorial?face=gallery')).data.commentary, '展览文案');
  const today = new Date().toISOString().slice(0, 10);
  platform.db.prepare('INSERT INTO page_views (day, path, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(today, '/a', 'ip1', Date.now());
  platform.db.prepare('INSERT INTO page_views (day, path, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(today, '/a', 'ip1', Date.now());
  platform.db.prepare('INSERT INTO page_views (day, path, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(today, '/b', 'ip2', Date.now());
  const traffic = (await call('root', 'GET', '/api/admin/traffic?days=2')).data;
  assert.deepEqual(traffic.daily.at(-1), { day: today, pv: 3, uniqueIps: 2 });
  assert.deepEqual(traffic.paths[0], { path: '/a', pv: 2 });
  assert.equal(traffic.users.total, 2);
  assert.equal(traffic.users.new, 2);
  assert.equal((await call('root', 'GET', '/api/admin/traffic?days=91')).status, 400);
  const match = await call('voter', 'POST', '/api/arena/matches', { task: 'one' });
  assert.equal(match.status, 200);
  assert.ok(!JSON.stringify(match.data).includes('模型甲'));
  assert.equal((await call('voter', 'POST', `/api/arena/matches/${match.data.id}/vote`, { choice: 'a' })).data.counted, true);
  assert.equal((await call('voter', 'GET', '/api/leaderboard?task=one')).data.totals.votes, 1);
  await call('root', 'POST', '/api/admin/works/one/a/face-settings', { show_arena: false });
  assert.equal((await call('voter', 'GET', '/api/leaderboard?task=one')).data.totals.votes, 0);
  assert.equal((await call('voter', 'POST', '/api/arena/matches', { task: 'one' })).status, 409);
  await call('root', 'POST', '/api/admin/works/one/a/face-settings', { show_arena: true });
  assert.equal((await call('voter', 'GET', '/api/leaderboard?task=one')).data.totals.votes, 1);
  assert.deepEqual((await call('voter', 'GET', '/api/prompts')).data, baseline.prompts);
  assert.deepEqual((await call('voter', 'GET', '/api/works')).data, baseline.works);
  assert.equal((await call('voter', 'GET', '/api/bootstrap')).data.apiVersion, baseline.bootstrap.apiVersion);
  assert.deepEqual((await call('voter', 'GET', '/api/leaderboard?task=one')).data.totals, { ...baseline.board.totals, votes: 1, voters: 1, entries: 2, tasks: 1 });
}));

test('the entertainment switch opts uploads and curated works into the Show1 pool', async () => withPlatform(async ({ platform, call }) => {
  const upload = await call('root', 'POST', '/api/admin/works/upload?effort=Default&providerId=official&task=one&name=work.html&title=娱乐作品&modelName=模型丙&show_gallery=1', html, true);
  const id = upload.data.work.id;
  assert.equal(upload.data.work.show_entertainment, true, 'admin upload is a first verification, so entertainment opens with both faces');
  const on = await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_entertainment: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.work.show_entertainment, true);
  assert.equal(platform.db.prepare('SELECT show_entertainment AS s FROM works WHERE id = ?').get(id).s, 1);
  const compatWorks = (await call('root', 'GET', '/api/works')).data.works;
  assert.ok(compatWorks.some((work) => work.id === id), 'the opted-in upload joins the Show1 roster');
  // Datapack works are in by default under a round-qualified game id; the switch lives in
  // their override row and leaves the formal faces untouched.
  const datapack = (works, id) => works.some((work) => work.id.startsWith('dp-') && work.id.endsWith(`-${id}`));
  assert.ok(datapack(compatWorks, 'a'), 'datapack works join the Show1 roster by default');
  const curated = await call('root', 'POST', '/api/admin/works/one/a/face-settings', { show_entertainment: false });
  assert.equal(curated.status, 200, 'datapack works can leave the entertainment face');
  assert.equal(curated.data.work.show_entertainment, false);
  assert.deepEqual({ ...platform.db.prepare('SELECT show_gallery, show_arena, show_entertainment FROM work_overrides WHERE work_id = ?').get('a') },
    { show_gallery: 1, show_arena: 1, show_entertainment: 0 });
  const withoutCurated = (await call('root', 'GET', '/api/works')).data.works;
  assert.equal(datapack(withoutCurated, 'a'), false, 'the switched-off datapack work leaves the Show1 roster');
  assert.ok(datapack(withoutCurated, 'b'));
  const off = await call('root', 'POST', `/api/admin/works/one/${id}/face-settings`, { show_entertainment: false });
  assert.equal(off.data.work.show_entertainment, false);
  assert.equal((await call('root', 'GET', '/api/works')).data.works.some((work) => work.id === id), false, 'opting out removes it again');
}));

test('entertainment follows publish-on-verify and the inbox checkbox hides a passing work', async () => withPlatform(async ({ call }) => {
  const draft = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
  const submitted = await call('voter', 'POST', '/api/works', {
    draftId: draft.data.draft.id, confirmed: true, title: '收件箱作品', modelName: '模型丙', effort: 'Default', providerId: 'official', harnessOther: '测试工具',
  });
  const id = submitted.data.work.id;
  const held = await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', entertainment: true });
  assert.equal(held.status, 200, JSON.stringify(held.data));
  const row = (await call('root', 'GET', '/api/admin/works?source=upload')).data.works.find((work) => work.id === id);
  assert.equal(row.entertainment_route, 1);
  assert.equal(row.show_gallery, false);
  assert.equal(row.show_arena, false);
  assert.equal(row.show_entertainment, false);
  assert.equal(row.status, 'verified');
  const visible = (await call('voter', 'GET', '/api/bootstrap')).data.works ?? [];
  assert.equal(visible.some((work) => work.id === id), false);
  assert.equal((await call('voter', 'GET', '/api/works')).data.works.some((work) => work.id === id), false);
  assert.notEqual(row.arena.state, 'in_pool');
  const inbox = await call('root', 'GET', '/api/admin/inbox/works');
  assert.equal(inbox.data.works.some((work) => work.id === id), true);
  const question = await call('root', 'POST', '/api/admin/questions', {
    title: '娱乐新题', summary: '给收件箱归属', prompt: '做一件小事', category: '静态网页', templates: ['static'], domains: ['游戏娱乐'],
  });
  assert.equal(question.status, 200, JSON.stringify(question.data));
  assert.equal(question.data.question.moderation.status, 'approved');
  const assigned = await call('root', 'POST', '/api/admin/works/batch-inbox', {
    works: [{ task: 'one', id }], task: question.data.question.id, entertainment: true,
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.works[0].entertainment_route, 2);
  assert.equal(assigned.data.works[0].task, question.data.question.id);
  assert.equal(assigned.data.works[0].show_entertainment, true);
  assert.equal((await call('root', 'GET', '/api/admin/inbox/works')).data.works.some((work) => work.id === id), false);
  const roster = (await call('voter', 'GET', '/api/works')).data.works.find((work) => work.id === id);
  assert.equal(roster.promptId, question.data.question.id);
  const again = await call('voter', 'POST', '/api/drafts?task=one&name=work.html', html, true);
  const second = await call('voter', 'POST', '/api/works', {
    draftId: again.data.draft.id, confirmed: true, title: '保持原状', modelName: '模型丁', effort: 'Default', providerId: 'official', harnessOther: '测试工具',
  });
  const secondId = second.data.work.id;
  assert.equal((await call('root', 'POST', `/api/works/one/${secondId}/review`, { status: 'verified', entertainment: false })).status, 200);
  await call('root', 'POST', `/api/admin/works/one/${secondId}/face-settings`, { show_entertainment: false, show_arena: false });
  const repeated = await call('root', 'POST', `/api/works/one/${secondId}/review`, { status: 'verified' });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  const kept = (await call('root', 'GET', '/api/admin/works?source=upload')).data.works.find((work) => work.id === secondId);
  assert.equal(kept.show_entertainment, false);
  assert.equal(kept.show_arena, false);
  assert.equal(kept.entertainment_route, 0);
}));

test('a curated display override changes the admin title and leaves the datapack model id', async () => withPlatform(async ({ call }) => {
  const saved = await call('root', 'POST', '/api/admin/works/one/a/display', { title: '改名后的馆藏', modelName: '展签名' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.work.title, '改名后的馆藏');
  assert.equal(saved.data.work.modelName, '展签名');
  assert.equal(saved.data.work.model, 'ma');
  const listed = (await call('root', 'GET', '/api/admin/works?source=curated')).data.works.find((work) => work.id === 'a');
  assert.equal(listed.title, '改名后的馆藏');
}));
