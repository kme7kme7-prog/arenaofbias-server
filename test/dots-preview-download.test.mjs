import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { createModerationTokens } from '../server/dots-moderation.mjs';
import { createDotsPreviewDownload } from '../server/dots-preview-download.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
function model(extras = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const data = { version: 2, bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    geometries: [{ attributes: { position: { type: 'Float32Array', offset: 0, length: 9, itemSize: 3 } }, groups: [] }],
    materials: [{ type: 'MeshStandardMaterial' }],
    meshes: [{ geometry: 0, material: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], ...extras };
  const header = Buffer.from(JSON.stringify(data)), prefix = Buffer.alloc(4); prefix.writeUInt32LE(header.length);
  return gzipSync(Buffer.concat([prefix, header, Buffer.alloc(Math.ceil((4 + header.length) / 8) * 8 - 4 - header.length), Buffer.from(positions.buffer)]));
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dots-preview-download-')), dist = join(root, 'dist'), dataDir = join(root, 'state');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Fixture', models: [{ id: 'model', name: 'Model', vendor: 'Vendor' }], tasks: [
    { id: 'one', title: 'One', category: '建模', results: [] },
  ] }));
  const platform = createPlatform({ config: { dist, dataDir, contentTemplate: 'http://{token}.localhost', admins: [], siteOrigins: [], cdn: [],
    secureCookies: false, capture: false, moderation: { enabled: false } }, limits,
    captureFactory: () => ({ available: false, async enqueue() { assert.fail('preview download must not capture'); }, async close() {} }) });
  let duringOpen = null;
  const inFlight = new Set(), failures = [];
  const path = '/api/dots/works/one/up-abcd1234/preview', download = `${path}/model`;
  const server = createServer((req, res) => {
    const pending = platform.handleSite(req, res);
    inFlight.add(pending);
    pending.then(() => inFlight.delete(pending), error => { inFlight.delete(pending); failures.push(error); res.destroy(); });
    if (req.url === download && duringOpen) { const action = duringOpen; duringOpen = null; action(); }
    return pending;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const actor = platform.auth.createAdmin('owner', 'correct horse');
  platform.db.prepare(`INSERT INTO works
    (id,task_id,owner_id,title,model_id,model_other,content_key,source_name,root,entry,file_count,bytes,digest,checks,trial,created_at,updated_at,status,moderation,cover)
    VALUES ('up-abcd1234','one',?,'Preview','model','','key','work.html','','index.html',1,20,'digest','[]','{}',1,1,'unverified','{"status":"approved","source":"human"}','cover.png')`).run(actor.id);
  const work = platform.library.uploadById('up-abcd1234');
  const mediaDir = join(platform.library.mediaDir, work.id);
  mkdirSync(work.dir, { recursive: true }); mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(work.dir, work.entry), '<!doctype html><p>original</p>'); writeFileSync(join(mediaDir, 'cover.png'), PNG);
  const tokens = createModerationTokens(platform.db), token = tokens.create('preview-reader', 'test', 'works:read,preview:write');
  const call = (method = 'GET', route = download, { bearer = token.token, body, cookie, encoding = 'gzip' } = {}) => fetch(base + route, {
    method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      'Accept-Encoding': encoding, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) }, body,
  });
  const upload = async (body = model()) => {
    const res = await call('PUT', path, { body }); assert.equal(res.status, 200, await res.clone().text()); return res.json();
  };
  try { await run({ platform, call, upload, token, tokens, path, download, work, root, mediaDir, during: action => { duringOpen = action; } }); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...inFlight]);
    await platform.close(); rmSync(root, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'all request handlers finish before the fixture database closes');
  }
}

test('preview downloader refuses missing, curated and non-upload works before opening a file', async () => {
  for (const work of [null, { id: 'up-abcd1234', curated: true }, { id: 'up-abcd1234', curated: false }]) {
    const service = createDotsPreviewDownload({ library: { work: () => work, uploadById: () => null }, previews: { current: () => assert.fail('not an upload') } });
    await assert.rejects(service.handle({ req: { url: '/model' }, params: { task: 'one', id: 'x' }, checkAccess() {} }), error => error.status === 404);
  }
});

test('HTTP preview upload downloads the actual sanitized saved gzip with matching SHA and safe headers', async () => fixture(async ({ platform, call, upload, mediaDir }) => {
  const dirty = model({ scripts: ['never store this'], extras: { ignored: true } });
  const result = await upload(dirty), name = result.previewModel.split('/').at(-1), saved = readFileSync(join(mediaDir, name));
  assert.notDeepEqual(saved, dirty, 'upload must be sanitized before the download');
  const res = await call(), bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200); assert.deepEqual(bytes, saved);
  assert.equal(bytes.readUInt16LE(0), 0x8b1f, 'the response body is the saved gzip, without HTTP content encoding');
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('content-length'), String(saved.length));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="preview-[a-z0-9]+\.sbox"$/);
  assert.match(res.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
  assert.equal(res.headers.get('x-preview-sha256'), hash(saved));
  const manifest = JSON.parse(readFileSync(join(mediaDir, 'preview.json')));
  assert.equal(res.headers.get('x-preview-version'), manifest.version);
  const head = await call('HEAD'); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(platform.db.prepare("SELECT COUNT(*) n FROM moderation_token_audit WHERE action='preview-model' AND outcome='ok'").get().n, 2);
}));

test('HTTP download requires works:read and refuses unknown, method and client path selectors', async () => fixture(async ({ call, upload, tokens, platform, download }) => {
  await upload();
  const other = tokens.create('uploader', 'test', 'preview:write');
  assert.equal((await call('GET', download, { bearer: other.token })).status, 403);
  assert.equal((await call('GET', download, { bearer: null })).status, 401);
  const cookie = {}; platform.auth.startSession({ setHeader: (_key, value) => { cookie.value = value.split(';')[0]; } }, platform.auth.list()[0].id);
  assert.equal((await call('GET', download, { bearer: null, cookie: cookie.value })).status, 401);
  assert.equal((await call('GET', download.replace('up-abcd1234', 'up-missing1'))).status, 404);
  assert.equal((await call('GET', download.replace('/one/', '/other/'))).status, 404);
  assert.equal((await call('POST')).status, 405);
  for (const suffix of ['?path=../../platform.db', '?version=preview-old.json', '?url=https://evil.example', '/../../file']) {
    assert.ok([400, 404, 405].includes((await call('GET', download + suffix)).status), suffix);
  }
}));

test('only the current upload manifest is downloadable; missing, altered and older-source previews fail closed', async () => fixture(async ({ call, upload, mediaDir, work }) => {
  assert.equal((await call()).status, 404);
  const first = await upload(), firstPath = join(mediaDir, first.previewModel.split('/').at(-1));
  const manifestPath = join(mediaDir, 'preview.json'), manifest = readFileSync(manifestPath), saved = readFileSync(firstPath);
  rmSync(firstPath); assert.equal((await call()).status, 404); writeFileSync(firstPath, saved);
  writeFileSync(firstPath, Buffer.from('altered model')); assert.equal((await call()).status, 404); writeFileSync(firstPath, saved);
  writeFileSync(join(work.dir, work.entry), 'changed source'); assert.equal((await call()).status, 404);
  writeFileSync(join(work.dir, work.entry), '<!doctype html><p>original</p>');
  writeFileSync(manifestPath, '{broken'); assert.equal((await call()).status, 404); writeFileSync(manifestPath, manifest);
  const legacy = JSON.parse(manifest); delete legacy.source; legacy.model = 'preview.sbox';
  writeFileSync(join(mediaDir, 'preview.sbox'), saved); writeFileSync(manifestPath, JSON.stringify(legacy));
  assert.equal((await call()).status, 404, 'operator-made/legacy preview is outside this upload endpoint');
  writeFileSync(manifestPath, manifest);
  const next = await upload(model({ bounds: { min: [0, 0, 0], max: [2, 2, 2] } }));
  const res = await call(); assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-preview-sha256'), hash(readFileSync(join(mediaDir, next.previewModel.split('/').at(-1)))));
  await res.arrayBuffer();
  assert.notEqual(next.previewModel, first.previewModel);
}));

test('manifest paths and media symlinks cannot turn the downloader into an arbitrary file endpoint', async () => fixture(async ({ call, upload, mediaDir, root }) => {
  const result = await upload(), file = join(mediaDir, result.previewModel.split('/').at(-1));
  const bytes = readFileSync(file), outside = join(root, 'outside.sbox'); writeFileSync(outside, bytes);
  rmSync(file); symlinkSync(outside, file); assert.equal((await call()).status, 404); rmSync(file); writeFileSync(file, bytes);
  const manifestPath = join(mediaDir, 'preview.json'), manifest = readFileSync(manifestPath);
  const traversal = JSON.parse(manifest); traversal.model = '../../outside.sbox'; writeFileSync(manifestPath, JSON.stringify(traversal));
  assert.equal((await call()).status, 404); writeFileSync(manifestPath, manifest);
  const outsideManifest = join(root, 'outside.json'); writeFileSync(outsideManifest, manifest);
  rmSync(manifestPath); symlinkSync(outsideManifest, manifestPath); assert.equal((await call()).status, 404); rmSync(manifestPath); writeFileSync(manifestPath, manifest);
  const alias = `${mediaDir}-actual`; renameSync(mediaDir, alias); symlinkSync(alias, mediaDir);
  assert.equal((await call()).status, 404); rmSync(mediaDir); renameSync(alias, mediaDir);
}));

test('revocation or scope withdrawal while the model stream opens sends no model bytes and records a denial', async () => {
  for (const change of ['revoke', 'withdraw']) await fixture(async ({ call, upload, during, tokens, token, platform }) => {
    await upload();
    during(() => change === 'revoke' ? tokens.revoke(token.id) : tokens.withdraw(token.id, 'works:read'));
    const res = await call(), body = await res.text();
    assert.equal(res.status, change === 'revoke' ? 401 : 403);
    assert.equal(res.headers.get('content-disposition'), null);
    assert.doesNotMatch(body, /modelSha|sourceDigest|geometries/);
    const rows = platform.db.prepare("SELECT outcome FROM moderation_token_audit WHERE action='preview-model' ORDER BY id").all();
    assert.equal(rows.length, 1); assert.match(rows[0].outcome, /^error:/);
  });
});

test('a preview switched while the stream opens cannot send a previous model as the current one', async () => fixture(async ({ call, upload, during, mediaDir }) => {
  await upload();
  during(() => { const path = join(mediaDir, 'preview.json'), manifest = JSON.parse(readFileSync(path)); manifest.version = 'preview-abcdef123456.json'; writeFileSync(path, JSON.stringify(manifest)); });
  const res = await call(); assert.equal(res.status, 404); assert.equal(res.headers.get('content-disposition'), null);
}));
