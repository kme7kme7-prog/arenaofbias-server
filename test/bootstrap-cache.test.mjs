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
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { etagMatches, pickEncoding } from '../server/compress.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-cache-'));
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
    moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 }, bootstrapCacheMs: 60_000 }, limits });
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
  try { await run({ platform, call, member, admin, dist, data, root, origin, base }); }
  finally {
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}


// Raw bytes as they leave the server, without fetch decoding them.
function raw(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    request(base + path, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('Accept-Encoding negotiation prefers br, honours q=0 and wildcards', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('gzip;q=1, br;q=0.5'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding(undefined), null);
  assert.equal(pickEncoding('*'), 'br');
  assert.equal(pickEncoding('*;q=0'), null);
  assert.equal(pickEncoding('deflate, x-gzip'), 'gzip');
  assert.ok(etagMatches('"abc-br"', 'abc'));
  assert.ok(etagMatches('W/"abc-gzip", "zzz"', 'abc'));
  assert.ok(etagMatches('*', 'abc'));
  assert.equal(etagMatches('"abcd"', 'abc'), false);
});

test('bootstrap and catalog are compressed per Accept-Encoding with matching validators', async () => fixture(async ({ base, origin }) => {
  for (const path of ['/api/bootstrap', '/api/catalog', '/api/bootstrap?lite=1']) {
    const plain = await raw(base, path, { origin, 'accept-encoding': 'identity' });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.headers.vary, /Origin/);
    assert.match(plain.headers.vary, /Accept-Encoding/);
    const json = JSON.parse(plain.body);
    for (const [encoding, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]]) {
      const packed = await raw(base, path, { origin, 'accept-encoding': encoding === 'br' ? 'gzip, deflate, br' : 'gzip' });
      assert.equal(packed.status, 200);
      assert.equal(packed.headers['content-encoding'], encoding, path);
      assert.equal(Number(packed.headers['content-length']), packed.body.length);
      assert.ok(packed.body.length < plain.body.length);
      assert.deepEqual(JSON.parse(decode(packed.body)), json);
      assert.match(packed.headers.vary, /Accept-Encoding/);
      assert.notEqual(packed.headers.etag, plain.headers.etag, 'each representation has its own strong validator');
      // Any representation's validator, or a weakened one, revalidates the content.
      for (const tag of [packed.headers.etag, plain.headers.etag, `W/${packed.headers.etag}`]) {
        const again = await raw(base, path, { origin, 'accept-encoding': 'gzip, br', 'if-none-match': tag });
        assert.equal(again.status, 304, `${path} ${tag}`);
        assert.equal(again.body.length, 0);
        assert.match(again.headers.vary, /Accept-Encoding/);
      }
    }
  }
  const small = await raw(base, '/api/announcements', { origin, 'accept-encoding': 'br' });
  assert.equal(small.headers['content-encoding'], undefined, 'tiny bodies are not worth compressing');
}));

test('signed-out bootstrap is cached per generation and never carries or receives personal fields', async () => fixture(async ({ platform, call, base, origin }) => {
  const first = await call('/api/bootstrap');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  assert.match(first.headers.get('server-timing'), /bootstrap;.*miss/);
  assert.ok(first.data.serverVersion);
  assert.ok(Object.hasOwn(first.data, 'datapack'));
  assert.equal(first.data.user, null);
  assert.equal(first.data.me, null);
  assert.equal(first.data.review, null);
  // The first build may write an activity row (featured refresh), so the next read can rebuild once.
  assert.equal((await call('/api/bootstrap')).headers.get('etag'), first.headers.get('etag'));
  // Signed-in requests are built for that user, stay uncached and do not touch the shared body.
  for (const who of ['member', 'admin', 'member']) {
    const personal = await call('/api/bootstrap', { who });
    assert.equal(personal.headers.get('cache-control'), 'no-store');
    assert.equal(personal.headers.get('etag'), null);
    assert.equal(personal.headers.get('server-timing'), null);
    assert.ok(personal.data.user);
    assert.ok(personal.data.me);
    const lite = await call('/api/bootstrap?lite=1', { who });
    assert.equal(lite.headers.get('cache-control'), 'no-store');
    assert.equal(lite.data.user.name, personal.data.user.name);
  }
  assert.ok((await call('/api/bootstrap', { who: 'admin' })).data.review, 'staff still get their review counts');
  const after = await call('/api/bootstrap');
  assert.equal(after.text, first.text, 'signed-in reads leave the shared body untouched');
  assert.match(after.headers.get('server-timing'), /hit/);
  assert.equal(after.headers.get('etag'), first.headers.get('etag'));
  // A stale or forged cookie is treated as signed out and gets the shared body.
  const stranger = await raw(base, '/api/bootstrap', { origin, 'accept-encoding': 'identity', cookie: 'sp_session=nope' });
  assert.equal(stranger.body.toString(), first.text);
  const allWorks = platform.library.allWorks;
  platform.library.allWorks = () => { throw new Error('a cache hit must not enumerate works'); };
  try { assert.equal((await call('/api/bootstrap', { headers: { 'if-none-match': first.headers.get('etag') } })).status, 304); }
  finally { platform.library.allWorks = allWorks; }
}));

test('signed-out bootstrap follows catalog, moderation and activity writes', async () => fixture(async ({ platform, call, admin }) => {
  let current = await call('/api/bootstrap');
  async function changed(check, path = '/api/bootstrap') {
    const next = await call(path, { headers: { 'if-none-match': current.headers.get('etag') } });
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.get('etag'), current.headers.get('etag'));
    check(next.data);
    current = next;
  }
  const reacted = await call('/api/works/one/pack/reactions', { who: 'member', method: 'POST', body: { emoji: 'press' } });
  assert.equal(reacted.status, 200, reacted.text);
  await changed((value) => assert.equal(JSON.stringify(value.reactions).includes('press'), true));
  assert.equal((await call('/api/bootstrap', { headers: { 'if-none-match': current.headers.get('etag') } })).status, 304);
  const edited = await call('/api/admin/questions/one/meta', { who: 'admin', method: 'POST', body: { title: 'Renamed' } });
  assert.equal(edited.status, 200, edited.text);
  await changed((value) => assert.equal(value.questions[0].title, 'Renamed'));
  platform.library.setFaceSettings(admin, 'one', 'pack', { show_gallery: false });
  await changed((value) => assert.equal(value.works.some((work) => work.id === 'pack'), false));
  current = await call('/api/bootstrap?lite=1');
  assert.equal(Object.hasOwn(current.data, 'works'), false);
  for (const key of ['serverVersion', 'datapack', 'questions', 'site', 'domainGroups', 'featured', 'reactions'])
    assert.ok(Object.hasOwn(current.data, key), key);
  const edited2 = await call('/api/admin/questions/one/meta', { who: 'admin', method: 'POST', body: { title: 'Lite title' } });
  assert.equal(edited2.status, 200);
  await changed((value) => assert.equal(value.questions[0].title, 'Lite title'), '/api/bootstrap?lite=1');
}));

test('a cached signed-out bootstrap expires after its time limit', async () => {
  const { createSharedJson } = await import('../server/catalog-response.mjs');
  let clock = 0, reads = 0, value = 1;
  const shared = createSharedJson({ strict: () => 's', read: () => { reads++; return { value }; }, ttl: 1000, cacheControl: 'private, no-cache', now: () => clock });
  await shared.current();
  await shared.current();
  assert.equal(reads, 1);
  clock = 999; await shared.current(); assert.equal(reads, 1);
  clock = 1000; await shared.current(); assert.equal(reads, 2);
  const unchanged = (await shared.current()).entry;
  value = 2; clock = 3000;
  const next = (await shared.current()).entry;
  assert.notEqual(next.hash, unchanged.hash);
  // Frequent loose writes never make a waiting request rebuild in a loop.
  let loose = 0;
  const busy = createSharedJson({ strict: () => 's', loose: () => String(loose++), read: () => ({ ok: true }), ttl: 60_000, cacheControl: 'x' });
  assert.equal((await busy.current()).entry.body.toString(), '{"ok":true}');
});
