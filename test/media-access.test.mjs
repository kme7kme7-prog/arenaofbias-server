import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { CONTENT_REVALIDATE } from '../server/content-cache.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'protected-media-'));
  const dist = join(root, 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'Alpha', vendor: 'A' }],
    tasks: [{ id: 'one', title: 'One', prompt: 'P', category: '静态网页', templates: ['static'], results: [] }] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), admins: [], siteOrigins: [], cdn: [],
    contentTemplate: 'http://{token}.localhost', capture: false, moderation: { enabled: false }, leaderboardWarmup: false }, limits });
  const owner = platform.auth.createAdmin('owner', 'a correct password');
  let cookie;
  platform.auth.startSession({ setHeader: (_, value) => { cookie = value.split(';')[0]; } }, owner.id);
  const draft = platform.library.createDraft(owner, 'one', 'work.html', Buffer.from('<html><body>work</body></html>'));
  const work = platform.library.submit(owner, { draftId: draft.id, confirmed: true, modelId: 'a', effort: 'high', providerId: 'official' });
  platform.db.prepare("UPDATE works SET status='verified',show_gallery=1,moderation=? WHERE id=?")
    .run(JSON.stringify({ status: 'approved' }), work.id);
  const dir = join(root, 'data', 'media', work.id); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'first.jpg'); writeFileSync(file, 'public image bytes');
  const server = createServer(platform.handleSite);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await platform.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/media/${work.id}/first.jpg`;
  return { platform, work, cookie, url, file };
}

test('public media validates identical bytes and withdrawal beats a cached ETag', async t => {
  const f = await fixture(t);
  const first = await fetch(f.url);
  assert.equal(first.status, 200); assert.equal(await first.text(), 'public image bytes');
  assert.equal(first.headers.get('cache-control'), CONTENT_REVALIDATE);
  const etag = first.headers.get('etag'); assert.ok(etag);
  const cached = await fetch(f.url, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  const head = await fetch(f.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('etag'), etag); assert.equal(await head.text(), '');
  writeFileSync(f.file, 'revised image bytes');
  const changed = await fetch(f.url, { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag); await changed.arrayBuffer();
  f.platform.db.prepare('UPDATE works SET deleted_at=? WHERE id=?').run(Date.now(), f.work.id);
  const removed = await fetch(f.url, { headers: { 'If-None-Match': etag } });
  assert.equal(removed.status, 404); assert.equal(removed.headers.get('cache-control'), 'no-store');
});

test('private owner media is no-store and a revoked session cannot finish opening it', async t => {
  const f = await fixture(t);
  f.platform.db.prepare("UPDATE works SET moderation=? WHERE id=?").run(JSON.stringify({ status: 'pending' }), f.work.id);
  assert.equal((await fetch(f.url)).status, 404);
  const privateRead = await fetch(f.url, { headers: { cookie: f.cookie, 'If-None-Match': '*' } });
  assert.equal(privateRead.status, 200); await privateRead.arrayBuffer();
  assert.equal(privateRead.headers.get('cache-control'), 'no-store'); assert.equal(privateRead.headers.get('etag'), null);
  const original = f.platform.library.canRead;
  let armed = true;
  f.platform.library.canRead = function (work, viewer) {
    const allowed = original.call(this, work, viewer);
    if (armed && viewer && allowed) { armed = false; queueMicrotask(() => f.platform.db.exec('DELETE FROM sessions')); }
    return allowed;
  };
  const revoked = await fetch(f.url, { headers: { cookie: f.cookie } });
  assert.equal(revoked.status, 404); assert.doesNotMatch(await revoked.text(), /public image bytes/);
});

test('public media rechecks visibility after asynchronous hashing before 200 or 304', async t => {
  const f = await fixture(t);
  const original = f.platform.library.canRead;
  let armed = true;
  f.platform.library.canRead = function (work, viewer) {
    const allowed = original.call(this, work, viewer);
    if (armed && allowed) { armed = false; queueMicrotask(() => f.platform.db.prepare('UPDATE works SET deleted_at=? WHERE id=?').run(Date.now(), f.work.id)); }
    return allowed;
  };
  const response = await fetch(f.url, { headers: { 'If-None-Match': '*' } });
  assert.equal(response.status, 410); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /public image bytes/);
});

test('a public media target removed between stat and open still returns 404', async t => {
  for (const missing of ['file', 'directory']) await t.test(missing, async t => {
    const f = await fixture(t), original = f.platform.library.canRead;
    let gates = 0;
    f.platform.library.canRead = function (work, viewer) {
      const allowed = original.call(this, work, viewer);
      if (allowed && ++gates === 2) {
        if (missing === 'file') rmSync(f.file);
        else { rmSync(dirname(f.file), { recursive: true }); writeFileSync(dirname(f.file), 'replaced parent'); }
      }
      return allowed;
    };
    const response = await fetch(f.url);
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /public image bytes/);
  });
});
