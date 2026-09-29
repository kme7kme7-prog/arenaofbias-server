// Admin staging inbox: upload → preview → register, inline meta edits and the
// vote-count guard on deletion.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits as defaultLimits } from '../server/config.mjs';
import { parseWorkFilename } from '../server/inbox.mjs';

const PAGE = '<!doctype html><html><head><title>t</title></head><body><canvas></canvas><script>canvas(0)</script></body></html>';

describe('admin inbox', () => {
  let root;
  let platform;
  let site;
  let base;
  const jars = new Map();

  async function call(who, method, path, body, { raw = false } = {}) {
    const headers = {};
    if (jars.get(who)) headers.cookie = jars.get(who);
    headers.origin = base;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jars.set(who, cookie.split(';')[0]);
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, response };
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'inbox-test-'));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'results', 'one', 'a1'), { recursive: true });
    writeFileSync(join(dist, 'results', 'one', 'a1', 'index.html'), '<!doctype html><title>a1</title>');
    writeFileSync(join(dist, 'data.json'), JSON.stringify({
      title: 'test',
      models: [{ id: 'm-a', name: 'Model A', vendor: 'VA' }],
      tasks: [{ id: 'one', title: 'One', promptPending: false, results: [{ id: 'a1', model: 'm-a', effort: '', title: 'A1', summary: '', scene: 'results/one/a1/', captures: {}, gallery: [] }] }],
    }));
    const config = { dist, dataDir: join(root, 'data'), contentTemplate: '', siteOrigins: ['http://127.0.0.1'], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: false };
    platform = createPlatform({ config, limits: defaultLimits });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${site.address().port}`;
    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
    assert.equal((await call('alice', 'POST', '/api/auth/register', { name: 'alice', password: 'correct horse' })).status, 200);
  });

  after(async () => {
    site.close();
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('filename conventions pre-fill the registration form', () => {
    assert.deepEqual(parseWorkFilename('「江南水乡，Claude 4.5.html」'), { title: '江南水乡', model: 'Claude 4.5' });
    assert.deepEqual(parseWorkFilename('my work.html'), { title: 'my work', model: '' });
  });

  test('staging, listing and previewing uploads', async () => {
    const upload = await call('root', 'POST', `/api/admin/inbox?name=${encodeURIComponent('「江南水乡，GPT-5.html」')}`, PAGE, { raw: true });
    assert.equal(upload.status, 200);

    const conflict = await call('root', 'POST', `/api/admin/inbox?name=${encodeURIComponent('「江南水乡，GPT-5.html」')}`, PAGE, { raw: true });
    assert.equal(conflict.status, 409);
    const overwrite = await call('root', 'POST', `/api/admin/inbox?name=${encodeURIComponent('「江南水乡，GPT-5.html」')}&overwrite=1`, PAGE, { raw: true });
    assert.equal(overwrite.status, 200);

    const rejected = await call('root', 'POST', `/api/admin/inbox?name=notes.txt`, 'plain text', { raw: true });
    assert.equal(rejected.status, 400);

    const list = await call('root', 'GET', '/api/admin/inbox');
    assert.equal(list.data.entries.length, 1);
    const entry = list.data.entries[0];
    assert.deepEqual(entry.suggest, { title: '江南水乡', model: 'GPT-5' });
    assert.ok(entry.preview.startsWith(`/admin/inbox/${entry.id}/`));

    const preview = await fetch(base + entry.preview, { headers: { cookie: jars.get('root') } });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type') ?? '', /text\/html/, 'the staged upload renders instead of downloading');
    assert.equal(preview.headers.get('content-security-policy'), 'sandbox allow-scripts');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await preview.text(), /canvas/);
    const outsider = await fetch(base + entry.preview, { headers: { cookie: jars.get('alice') } });
    assert.equal(outsider.status, 404);
    const stranger = await fetch(`${base}/admin/inbox/${'0'.repeat(16)}/../platform.db`, { headers: { cookie: jars.get('root') } });
    assert.equal(stranger.status, 404);
    const forged = await fetch(`${base}/admin/inbox/${'z'.repeat(16)}/file`, { headers: { cookie: jars.get('root') } });
    assert.equal(forged.status, 404);
  });

  test('registering as a draft, then publishing from the review queue', async () => {
    const listed = await call('root', 'GET', '/api/admin/inbox');
    const entry = listed.data.entries[0];
    const registered = await call('root', 'POST', '/api/admin/inbox/register', {
      id: entry.id, task: 'one', summary: '水乡', modelId: 'm-a',
    });
    assert.equal(registered.status, 200);
    const work = registered.data.work;
    assert.equal(work.status, 'unverified');
    assert.equal(work.title, '江南水乡');
    assert.equal(work.modelName, 'Model A');
    assert.equal(work.tool, '');
    // Per-face review: registration decides nothing — both faces wait off.
    assert.deepEqual([work.show_gallery, work.show_arena], [false, false]);
    assert.equal((await call('root', 'GET', '/api/admin/inbox')).data.entries.length, 0);

    // Second file, registered with publish → straight into the verified pool.
    await call('root', 'POST', `/api/admin/inbox?name=published.html`, PAGE, { raw: true });
    const second = (await call('root', 'GET', '/api/admin/inbox')).data.entries[0];
    const direct = await call('root', 'POST', '/api/admin/inbox/register', { id: second.id, task: 'one', publish: true, modelName: '手工模型', show_gallery: true, show_arena: false });
    assert.equal(direct.status, 200);
    assert.equal(direct.data.work.status, 'verified');
    assert.equal(direct.data.work.modelName, '手工模型');

    const missing = await call('root', 'POST', '/api/admin/inbox/register', { id: 'f'.repeat(16), task: 'one', modelName: 'x' });
    assert.equal(missing.status, 404);
    const badTask = await call('root', 'POST', `/api/admin/inbox?name=bad.html`, PAGE, { raw: true });
    assert.equal(badTask.status, 200);
    const bad = (await call('root', 'GET', '/api/admin/inbox')).data.entries[0];
    const refused = await call('root', 'POST', '/api/admin/inbox/register', { id: bad.id, task: 'nope', modelName: 'x' });
    assert.equal(refused.status, 404);
    assert.equal((await call('root', 'GET', '/api/admin/inbox')).data.entries.length, 1);

    const removed = await call('root', 'DELETE', `/api/admin/inbox?id=${bad.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await call('root', 'GET', '/api/admin/inbox')).data.entries.length, 0);
  });

  test('inline meta edits update uploads', async () => {
    const list = await call('root', 'GET', '/api/admin/works?task=one&source=upload');
    const work = list.data.works.find((item) => item.status === 'unverified');
    const edited = await call('root', 'POST', `/api/admin/works/${work.task}/${work.id}/meta`, { title: '新标题', summary: '新摘要', modelName: '新模型' });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.work.title, '新标题');
    assert.equal(edited.data.work.modelName, '新模型');
    const broken = await call('root', 'POST', `/api/admin/works/${work.task}/${work.id}/meta`, { title: '' });
    assert.equal(broken.status, 400);
    const curated = await call('root', 'POST', '/api/admin/works/one/a1/meta', { title: 'x' });
    assert.equal(curated.status, 404);
  });

  test('works with votes refuse deletion', async () => {
    const list = await call('root', 'GET', '/api/admin/works?task=one&source=upload');
    const work = list.data.works.find((item) => item.id.startsWith('up-'));
    platform.db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at)
      VALUES ('v-test', 'm-test', NULL, ?, ?, ?, 'p-test', 'a', ?)`).run(work.task, work.id, 'other', Date.now());
    const deleted = await call('root', 'DELETE', `/api/works/${work.task}/${work.id}`);
    assert.equal(deleted.status, 409);
    assert.match(deleted.data.error, /对局记录/);
    const clean = list.data.works.find((item) => item.id !== work.id && item.id.startsWith('up-'));
    assert.ok(clean, 'a vote-free upload exists');
    assert.equal((await call('root', 'DELETE', `/api/works/${clean.task}/${clean.id}`)).status, 200);
  });
});
