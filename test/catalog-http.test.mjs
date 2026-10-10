import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { verifiedUser } from './helpers/email.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-http-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const data = { title: 'Synthetic catalog', models: [{ id: 'model', name: 'Model', vendor: 'Test' }], tasks: [
    { id: 'one', title: 'One', summary: 'Summary', prompt: 'Prompt', category: '静态网页', templates: ['static'], domains: [],
      results: [{ id: 'pack', title: 'Pack work', model: 'model', scene: './' }] },
  ] };
  writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><h1>Synthetic work</h1>');
  const origin = 'https://gallery.example.test';
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [origin], admins: [], cdn: [], capture: false, secureCookies: false,
    moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 } }, limits });
  const site = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise(resolve => site.once('listening', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const member = await verifiedUser(platform.auth, 'member');
  const admin = platform.auth.createAdmin('root', 'correct horse');
  platform.auth.bindEmail(admin.id, 'root@example.test');
  const cookies = {};
  for (const [name, user] of Object.entries({ member, admin })) {
    platform.auth.startSession({ setHeader: (_name, value) => { cookies[name] = value.split(';')[0]; } }, user.id);
  }
  async function call(path, { who, method = 'GET', body, headers = {}, raw = false } = {}) {
    const response = await fetch(base + path, { method, headers: { origin, ...(who ? { cookie: cookies[who] } : {}),
      ...(body !== undefined ? { 'content-type': raw ? 'text/html' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: text ? JSON.parse(text) : null };
  }
  try { await run({ platform, call, member, admin, dist, data, root, origin }); }
  finally {
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('public catalog revalidates one anonymous snapshot without touching sessions or ranking', async () => fixture(async ({ platform, call, origin }) => {
  const first = await call('/api/catalog');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'public, no-cache');
  assert.match(first.headers.get('server-timing'), /miss/);
  const sessions = platform.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
  const allWorks = platform.library.allWorks;
  const leaderboard = platform.arena.leaderboard;
  const totals = platform.arena.totals;
  platform.library.allWorks = () => { throw new Error('warm catalog and session must not enumerate works'); };
  platform.arena.leaderboard = () => { throw new Error('catalog and session must not wait for ranking'); };
  platform.arena.totals = () => { throw new Error('catalog and session must not scan ballots'); };
  try {
    for (const who of [undefined, 'member', 'admin']) {
      const response = await call('/api/catalog', { who });
      assert.equal(response.text, first.text);
      assert.equal(response.headers.get('etag'), first.headers.get('etag'));
      assert.match(response.headers.get('server-timing'), /hit/);
      const revalidated = await call('/api/catalog', { who, headers: { 'if-none-match': `W/${first.headers.get('etag')}` } });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.text, '');
    }
    assert.deepEqual(platform.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(), sessions);
    for (const who of [undefined, 'member', 'admin']) {
      const result = await call('/api/session', { who });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(Boolean(result.data.user), Boolean(who));
      assert.equal(Object.hasOwn(result.data, 'review'), false);
    }
    assert.equal((await call('/api/catalog', { headers: { 'if-none-match': first.headers.get('etag') } })).status, 304,
      'session last_seen writes do not invalidate the public snapshot');
    const head = await call('/api/catalog', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(first.text));
  } finally { platform.library.allWorks = allWorks; platform.arena.leaderboard = leaderboard; platform.arena.totals = totals; }
  for (const key of ['user', 'me', 'review', 'reactions', 'arena', 'totals']) assert.equal(Object.hasOwn(first.data, key), false);
  for (const item of [...first.data.works, ...first.data.questions]) assert.equal(Object.hasOwn(item, 'mine'), false);
  const preflight = await call('/api/catalog', { method: 'OPTIONS', headers: {
    'access-control-request-method': 'GET', 'access-control-request-headers': 'If-None-Match',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /If-None-Match/);
  assert.match(first.headers.get('access-control-expose-headers'), /ETag/);
  assert.equal((await call('/api/catalog?page=1')).status, 400);
}));

test('catalog immediately follows question/work visibility, moderation, profiles, external writes and package replacement', async () => fixture(async ({ platform, call, member, dist, data, root }) => {
  let current = await call('/api/catalog');
  async function changed(check) {
    const next = await call('/api/catalog', { headers: { 'if-none-match': current.headers.get('etag') } });
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.get('etag'), current.headers.get('etag'));
    check(next.data);
    current = next;
  }
  const edited = await call('/api/admin/questions/one/meta', { who: 'admin', method: 'POST', body: { title: 'New title' } });
  assert.equal(edited.status, 200, edited.text);
  await changed(value => assert.equal(value.questions[0].title, 'New title'));
  const draft = await call('/api/drafts?task=one&name=work.html', { who: 'member', method: 'POST', raw: true,
    body: '<!doctype html><h1>Uploaded work</h1>' });
  assert.equal(draft.status, 200, draft.text);
  const submitted = await call('/api/works', { who: 'member', method: 'POST', body: {
    draftId: draft.data.draft.id, confirmed: true, title: 'Upload', modelId: 'model', effort: 'Default',
    providerId: 'official', harnessOther: 'Test', generationMode: 'single-turn', humanIntervention: 'none',
  } });
  assert.equal(submitted.status, 200, submitted.text);
  const id = submitted.data.work.id;
  assert.equal((await call('/api/works/one/' + id + '/review', { who: 'admin', method: 'POST', body: { status: 'verified' } })).status, 200);
  await changed(value => {
    const work = value.works.find(item => item.id === id);
    assert.ok(work);
    for (const key of ['mine', 'moderation', 'audience', 'arena', 'checks', 'trial', 'sourceName', 'root', 'entry', 'reviewer'])
      assert.equal(Object.hasOwn(work, key), false, key);
  });
  const activity = await call('/api/activity', { who: 'member' });
  assert.equal(activity.status, 200);
  assert.equal(activity.headers.get('cache-control'), 'no-store');
  assert.equal(activity.data.workAccess.find(item => item.id === id).mine, true);
  assert.equal(activity.data.workAccess.find(item => item.id === id).arena.state, 'in_pool');
  assert.equal(Object.hasOwn(activity.data, 'works'), false);
  assert.deepEqual((await call('/api/activity')).data.workAccess, [], 'anonymous activity does not repeat per-work access flags');
  const legacy = await call('/api/bootstrap', { who: 'member' });
  assert.equal(legacy.data.works.find(item => item.id === id).mine, true);
  assert.ok(legacy.data.works.find(item => item.id === id).checks);
  platform.db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run('Display name', member.id);
  await changed(value => assert.equal(value.works.find(item => item.id === id).author.name, 'Display name'));
  const external = new DatabaseSync(join(root, 'data', 'platform.db'));
  try { external.prepare('UPDATE users SET nickname = ? WHERE id = ?').run('External name', member.id); }
  finally { external.close(); }
  await changed(value => assert.equal(value.works.find(item => item.id === id).author.name, 'External name'));
  assert.equal((await call(`/api/works/one/${id}/moderation`, { who: 'admin', method: 'POST',
    body: { status: 'rejected', reason: 'Synthetic rejection' } })).status, 200);
  await changed(value => assert.equal(value.works.some(item => item.id === id), false));
  assert.equal((await call('/api/questions/one/moderation', { who: 'admin', method: 'POST',
    body: { status: 'rejected', reason: 'Synthetic rejection' } })).status, 200);
  await changed(value => {
    assert.equal(value.questions.length, 0);
    assert.equal(value.works.length, 0);
  });
  data.tasks.push({ ...data.tasks[0], id: 'two', title: 'New packaged question', results: [] });
  writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  await changed(value => assert.equal(value.questions[0].id, 'two'));
}));

test('a moderation write during a shared cold catalog build is visible before responses leave', async () => fixture(async ({ platform, call, admin, dist, data }) => {
  data.tasks[0].results = Array.from({ length: 96 }, (_, i) => ({ ...data.tasks[0].results[0], id: `work-${i}` }));
  writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  await call('/api/session');
  await new Promise(resolve => setImmediate(resolve));
  const toPublic = platform.library.toPublic;
  let serialized = 0, changed = false;
  platform.library.toPublic = (...args) => {
    if (++serialized === 1) setImmediate(() => {
      platform.library.setFaceSettings(admin, 'one', 'work-0', { show_gallery: false });
      changed = true;
    });
    return toPublic.apply(platform.library, args);
  };
  try {
    const [a, b] = await Promise.all([call('/api/catalog'), call('/api/catalog', { who: 'admin' })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(changed, true);
    assert.equal(a.data.works.length, 95);
    assert.equal(a.data.works.some(work => work.id === 'work-0'), false);
    assert.equal(a.text, b.text);
    assert.ok(serialized <= 192, `two catalog revisions and the moderation response share builds (${serialized} serialized)`);
    assert.equal((await call('/api/catalog', { headers: { 'if-none-match': a.headers.get('etag') } })).status, 304);
  } finally { platform.library.toPublic = toPublic; }
}));
