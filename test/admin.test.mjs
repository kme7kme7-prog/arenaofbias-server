import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

async function withPlatform(run) {
  const root = mkdtempSync(join(tmpdir(), 'admin-api-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'results', 'one', 'a'), { recursive: true });
  mkdirSync(join(dist, 'results', 'one', 'b'), { recursive: true });
  for (const id of ['a', 'b']) writeFileSync(join(dist, 'results', 'one', id, 'index.html'), html);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ schemaVersion: 1, title: '测试馆藏', models: [
    { id: 'ma', name: '模型甲', vendor: '甲' }, { id: 'mb', name: '模型乙', vendor: '乙' },
  ], tasks: [{ id: 'one', title: '测试题', results: [
    { id: 'a', title: '精选甲', model: 'ma', scene: 'results/one/a/' },
    { id: 'b', title: '精选乙', model: 'mb', scene: 'results/one/b/' },
  ] }] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), admin: join(process.cwd(), 'admin'),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: ['root'], cdn: [], capture: false,
    secureCookies: false, trustProxy: false }, limits });
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
  assert.equal(list.data.total, 3, 'curated works default to arena-off until approved');
  const framing = { width: 1440, height: 900, zoom: 1.2, offsetX: 0.1, offsetY: -0.2 };
  const camera = { position: [1, 2, 3], target: [0, 0, 0] };
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'gallery', calibration: { framing } })).status, 200);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'arena', calibration: { camera } })).status, 200);
  assert.equal((await call('root', 'POST', '/api/admin/works/one/a/calibration', { face: 'arena', calibration: { framing } })).status, 200);
  const rows = (await call('root', 'GET', '/api/admin/works')).data.works;
  assert.deepEqual(rows.find((w) => w.id === id).calibration_gallery.framing, framing);
  assert.deepEqual(rows.find((w) => w.id === id).calibration_arena.camera, camera);
  assert.deepEqual(rows.find((w) => w.id === 'a').calibration_arena.framing, framing);
  assert.equal((await call('root', 'POST', `/api/admin/works/one/${id}/calibration`, { face: 'arena', calibration: { framing: { ...framing, zoom: 5 } } })).status, 400);
  assert.ok(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('submit','verified','face-settings','calibration')").get().n >= 6);
}));

test('calibrating a curated work preserves its arena approval and invalidates the board', async () => withPlatform(async ({ platform, call }) => {
  let invalidations = 0;
  const invalidate = platform.arena.invalidate;
  platform.arena.invalidate = () => { invalidations++; invalidate(); };
  const framing = { width: 1440, height: 900, zoom: 1, offsetX: 0, offsetY: 0 };
  assert.equal((await call('root', 'POST', '/api/admin/works/one/a/calibration', { face: 'gallery', calibration: { framing } })).status, 200);
  assert.deepEqual({ ...platform.db.prepare('SELECT show_gallery, show_arena FROM work_overrides WHERE work_id = ?').get('a') },
    { show_gallery: 1, show_arena: 0 });
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
  // 精选馆藏默认不进正式盲测池：先逐件审批 a/b。
  await call('root', 'POST', '/api/admin/works/one/a/face-settings', { show_arena: true });
  await call('root', 'POST', '/api/admin/works/one/b/face-settings', { show_arena: true });
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
  assert.deepEqual((await call('voter', 'GET', '/api/leaderboard?task=one')).data.totals, { ...baseline.board.totals, votes: 1, voters: 1, entries: 2 });
}));
