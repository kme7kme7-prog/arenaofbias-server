import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createContentHandler } from '../server/content.mjs';
import { CONTENT_REVALIDATE } from '../server/content-cache.mjs';

const key = prefix => prefix + 'a'.repeat(32);
const source = '<!doctype html><html><head></head><body><p>Original</p></body></html>';
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'content-cache-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), source);
  writeFileSync(join(root, 'assets/app.mjs'), 'export default "AAAA";');
  writeFileSync(join(root, 'assets/style.css'), 'body{background:url(/image.svg)}');
  writeFileSync(join(root, 'assets/model.bin'), Buffer.alloc(2 * 1024 * 1024, 42));
  const state = { public: true, preview: true, eligible: true, camera: null, gates: 0, revokeOnSecondGate: false };
  const work = { dir: root, entry: 'index.html', moderation: { status: 'approved' }, taskId: 'fixture', id: 'work' };
  const publicGate = () => {
    if (state.revokeOnSecondGate && ++state.gates >= 2) state.public = false;
    return state.public;
  };
  const server = createServer(createContentHandler({
    config: { contentPathOrigin: 'http://content.example.test', contentTemplate: 'http://{token}.legacy.test', cdn: [], readLimits: { pages: 1000 } },
    siteOrigins: ['http://site.example.test'],
    library: { byContentKey: () => work, curatedByKey: () => work, publicContent: publicGate, publicCuratedContent: publicGate,
      previewByKey: () => state.preview ? work : null, draftByToken: () => work, isEligible: () => state.eligible,
      calibrationOf: () => state.camera ? { camera: state.camera } : null },
    arena: { workForToken: () => work }, qualification: { workForToken: () => work },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const get = (path, headers = {}, method = 'GET', host = 'content.example.test') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { Host: host, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { root, state, work, get };
}

test('public work HTML, rewritten CSS, streamed files and injected scripts revalidate without changing their bytes or security headers', async t => {
  const f = await fixture(t);
  for (const prefix of ['w', 'c']) {
    for (const path of ['/', '/assets/style.css', '/assets/app.mjs', '/assets/model.bin', '/__aob_fold.js', '/__content-runtime.js']) {
      const url = `/c/${key(prefix)}${path}`, first = await f.get(url);
      assert.equal(first.status, 200);
      assert.equal(first.headers['cache-control'], CONTENT_REVALIDATE);
      assert.match(first.headers.etag, /^W\/"[0-9a-f]{64}"$/);
      const again = await f.get(url, { 'If-None-Match': `"unrelated", ${first.headers.etag}` });
      assert.equal(again.status, 304, path);
      assert.equal(again.body.length, 0);
      assert.equal(again.headers['content-length'], undefined);
      for (const name of ['etag', 'cache-control', 'content-security-policy', 'access-control-allow-origin', 'permissions-policy'])
        assert.equal(again.headers[name], first.headers[name], name);
      assert.equal(again.headers['access-control-allow-credentials'], undefined);
      const head = await f.get(url, {}, 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers.etag, first.headers.etag);
      assert.equal(Number(head.headers['content-length']), first.body.length);
      assert.equal((await f.get(url, { 'If-None-Match': first.headers.etag.replace('W/', '') }, 'HEAD')).status, 304);
      const miss = await f.get(url, { 'If-None-Match': '"wrong"' });
      assert.equal(miss.status, 200); assert.deepEqual(miss.body, first.body);
      if (path.endsWith('app.mjs') || path.endsWith('model.bin')) assert.deepEqual(first.body, readFileSync(join(f.root, path)));
    }
  }
  assert.equal(readFileSync(join(f.root, 'index.html'), 'utf8'), source, 'stored work source stays untouched');
});

test('file edits, display options and calibration changes invalidate old validators, including equal-sized files with restored timestamps', async t => {
  const f = await fixture(t), url = `/c/${key('w')}/`;
  const original = await f.get(url);
  const folded = await f.get(url + '?aob=fold', { 'If-None-Match': original.headers.etag });
  assert.equal(folded.status, 200); assert.notEqual(folded.headers.etag, original.headers.etag);
  const privateAddress = await f.get(`/c/${key('c')}/`, { 'If-None-Match': original.headers.etag });
  assert.equal(privateAddress.status, 200, 'rebased document capabilities must not share a validator');
  f.state.camera = { position: [1, 2, 3], target: [0, 0, 0] };
  const camera = await f.get(url, { 'If-None-Match': original.headers.etag });
  assert.equal(camera.status, 200); assert.notEqual(camera.headers.etag, original.headers.etag);
  assert.match(camera.body.toString(), /__AOB_SAVED__/);
  f.state.camera.position[0] = 9;
  const adjusted = await f.get(url, { 'If-None-Match': camera.headers.etag });
  assert.equal(adjusted.status, 200); assert.notEqual(adjusted.headers.etag, camera.headers.etag);
  writeFileSync(join(f.root, 'index.html'), source.replace('Original', 'Updated!'));
  assert.equal((await f.get(url, { 'If-None-Match': adjusted.headers.etag })).status, 200);
  const moduleUrl = `/c/${key('w')}/assets/app.mjs`, file = join(f.root, 'assets/app.mjs');
  const old = await f.get(moduleUrl), stat = statSync(file);
  writeFileSync(file, 'export default "BBBB";'); utimesSync(file, stat.atime, stat.mtime);
  const changed = await f.get(moduleUrl, { 'If-None-Match': old.headers.etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.etag, old.headers.etag);
  assert.match(changed.body.toString(), /BBBB/);
  const legacy = await f.get('/', {}, 'GET', `${key('w')}.legacy.test`);
  assert.equal(legacy.status, 200); assert.equal(legacy.headers['cache-control'], CONTENT_REVALIDATE);
  assert.equal((await f.get('/', { 'If-None-Match': legacy.headers.etag }, 'GET', `${key('w')}.legacy.test`)).status, 304);
});

test('withdrawals, held moderation, expired previews and missing files win over conditional requests', async t => {
  const f = await fixture(t);
  for (const prefix of ['w', 'c']) {
    const html = `/c/${key(prefix)}/`, asset = `/c/${key(prefix)}/assets/app.mjs`;
    f.state.public = true;
    const first = await f.get(html), file = await f.get(asset);
    f.state.public = false;
    for (const [url, tag] of [[html, first.headers.etag], [asset, file.headers.etag], [`/v/${key(prefix)}/`, '*']]) {
      const denied = await f.get(url, { 'If-None-Match': tag });
      assert.equal(denied.status, 410); assert.equal(denied.headers['cache-control'], 'no-store'); assert.equal(denied.headers.etag, undefined);
    }
  }
  for (const prefix of ['p', 'd', 'm', 'e']) {
    for (const path of ['/', '/assets/app.mjs', '/assets/style.css', '/__aob_fold.js']) {
      const response = await f.get(`/c/${key(prefix)}${path}`, { 'If-None-Match': '*' });
      assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers.etag, undefined);
    }
  }
  f.state.preview = false;
  assert.equal((await f.get(`/c/${key('p')}/`, { 'If-None-Match': '*' })).status, 410);
  f.state.eligible = false;
  for (const prefix of ['m', 'e']) assert.equal((await f.get(`/c/${key(prefix)}/`, { 'If-None-Match': '*' })).status, 410);
  f.state.public = true;
  const missing = await f.get(`/c/${key('w')}/missing.js`, { 'If-None-Match': '*' });
  assert.equal(missing.status, 404); assert.equal(missing.headers['cache-control'], 'no-store'); assert.equal(missing.headers.etag, undefined);
});

test('public streamed files repeat the live access gate after asynchronous hashing before allowing 304 reuse', async t => {
  const f = await fixture(t), url = `/c/${key('w')}/assets/model.bin`;
  const first = await f.get(url);
  f.state.gates = 0; f.state.revokeOnSecondGate = true;
  const denied = await f.get(url, { 'If-None-Match': first.headers.etag });
  assert.equal(denied.status, 410); assert.equal(denied.headers.etag, undefined); assert.equal(denied.headers['cache-control'], 'no-store');
});
