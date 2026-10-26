import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { CONTENT_REVALIDATE } from '../server/content-cache.mjs';
import { referencePng as png } from './helpers/reference-images.mjs';

const origin = 'https://gallery.example.test';
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reference-access-'));
  const dist = join(root, 'dist'); mkdirSync(join(dist, 'references'), { recursive: true });
  const data = { models: [], tasks: [{ id: 'one', title: 'One', prompt: 'P', category: '静态网页', templates: ['static'],
    references: [{ name: '01-pack.png', src: 'references/pack.png', width: 3, height: 2 }], results: [] }] };
  writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  writeFileSync(join(dist, 'references/pack.png'), png);
  writeFileSync(join(dist, 'references/changed-pack.png'), png);
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), admins: [], siteOrigins: [origin], cdn: [],
    contentTemplate: 'http://{token}.localhost', capture: false, moderation: { enabled: false }, leaderboardWarmup: false }, limits });
  const owner = platform.auth.createAdmin('owner', 'a correct password');
  const reviewer = platform.auth.createAdmin('reviewer', 'a correct password');
  const cookies = new Map();
  for (const user of [owner, reviewer]) platform.auth.startSession({ setHeader: (_, value) => cookies.set(user.id, value.split(';')[0]) }, user.id);
  const uploaded = platform.references.upload(owner, 'uploaded.png', png);
  const server = createServer(platform.handleSite); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await platform.close(); rmSync(root, { recursive: true, force: true }); });
  const review = await fetch(`${base}/api/questions/one/moderation`, { method: 'POST', headers: { origin, cookie: cookies.get(owner.id), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) });
  assert.equal(review.status, 200); await review.arrayBuffer();
  const hold = () => platform.db.prepare('UPDATE question_overrides SET moderation=? WHERE task_id=?').run(JSON.stringify({ status: 'rejected' }), 'one');
  const paths = { pack: '/media/pack-references/one/01-pack.png', upload: `/${uploaded.src}` };
  const read = async (path, user = null, method = 'GET', extra = {}) => {
    const response = await fetch(base + path, { method, headers: { origin, ...(user ? { cookie: cookies.get(user.id) } : {}), ...extra } });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };
  const arm = mutate => {
    const original = platform.auth.userFrom; let armed = true;
    platform.auth.userFrom = function (req) {
      const user = original.call(this, req);
      if (armed) { armed = false; queueMicrotask(mutate); }
      return user;
    };
  };
  return { platform, owner, reviewer, root, dist, data, uploaded, paths, hold, read, arm };
}

test('public uploaded and packaged references revalidate without losing PNG, filename, CORS or HEAD', async t => {
  const f = await fixture(t);
  f.platform.references.save('one', [{ id: f.uploaded.id, name: '01-upload.png', caption: '' }]);
  for (const path of Object.values(f.paths)) {
    const first = await f.read(path);
    assert.equal(first.status, 200); assert.deepEqual(first.body, png);
    assert.equal(first.headers.get('cache-control'), CONTENT_REVALIDATE);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(first.headers.get('access-control-allow-origin'), origin);
    assert.equal(first.headers.get('access-control-allow-credentials'), 'true');
    const etag = first.headers.get('etag'); assert.ok(etag);
    const cached = await f.read(path, null, 'GET', { 'If-None-Match': etag });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
    const head = await f.read(path, null, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers.get('etag'), etag);
  }
  assert.match((await f.read(f.paths.upload)).headers.get('content-disposition'), /01-upload.png/);
});

test('private references never store bytes or validators and recheck logout after opening', async t => {
  for (const kind of ['upload', 'pack']) for (const method of ['GET', 'HEAD']) {
    await t.test(`${kind} ${method}`, async t => {
      const f = await fixture(t); if (kind === 'pack') f.hold();
      const first = await f.read(f.paths[kind], f.owner, method, { 'If-None-Match': '*' });
      assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.equal(first.headers.get('etag'), null);
      f.arm(() => f.platform.db.exec('DELETE FROM sessions'));
      const denied = await f.read(f.paths[kind], f.owner, method);
      assert.equal(denied.status, 404); assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.equal(denied.body.includes(png), false);
    });
  }
});

test('public references cannot reuse old bytes after the question is rejected during hashing', async t => {
  for (const kind of ['upload', 'pack']) await t.test(kind, async t => {
    const f = await fixture(t);
    f.platform.references.save('one', [{ id: f.uploaded.id, name: '01-upload.png', caption: '' }]);
    f.arm(f.hold);
    const denied = await f.read(f.paths[kind], null, 'GET', { 'If-None-Match': '*' });
    assert.equal(denied.status, 404); assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.headers.get('etag'), null); assert.equal(denied.body.includes(png), false);
  });
});

test('a reviewer demoted while opening a private reference cannot receive old bytes', async t => {
  const f = await fixture(t);
  f.arm(() => f.platform.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.reviewer.id));
  const denied = await f.read(f.paths.upload, f.reviewer);
  assert.equal(denied.status, 404); assert.equal(denied.body.includes(png), false);
});

test('a packaged reference remapped during hashing cannot send its previous target', async t => {
  const f = await fixture(t);
  f.arm(() => {
    f.data.tasks[0].references[0].src = 'references/changed-pack.png';
    writeFileSync(join(f.dist, 'data.json'), JSON.stringify(f.data));
  });
  const denied = await f.read(f.paths.pack, null, 'GET', { 'If-None-Match': '*' });
  assert.equal(denied.status, 404); assert.equal(denied.body.includes(png), false);
});
