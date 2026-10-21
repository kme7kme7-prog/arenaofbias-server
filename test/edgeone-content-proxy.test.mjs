import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../deploy/edgeone/public-content-proxy.js', import.meta.url), 'utf8');
const key = 'w' + '1'.repeat(32);
const base = `https://w.arenaofbias.icu/c/${key}/`;
const policy = 'private, no-cache, max-age=0, must-revalidate';
function runtime(fetch) {
  let handler;
  vm.runInNewContext(source, { Request, Response, Headers, URL, fetch,
    addEventListener(name, callback) { assert.equal(name, 'fetch'); handler = callback; } });
  return request => {
    let promise;
    handler({ request, respondWith(value) { promise = value; } });
    return promise;
  };
}

test('public proxy forwards exact public path/query and conditional headers to one fixed TLS origin', async () => {
  let observed;
  const run = runtime(async (url, init) => {
    observed = { url, init };
    return new Response('original bytes', { headers: { ETag: 'W/"v1"', 'Cache-Control': policy,
      'Content-Security-Policy': "sandbox allow-scripts", 'Access-Control-Allow-Origin': '*' } });
  });
  const url = base + '?aob=arena-fold&aob=entertainment-camera&parent=https%3A%2F%2Fgame.arenaofbias.icu';
  const result = await run(new Request(url, { headers: {
    'If-None-Match': 'W/"v0"', 'Accept-Encoding': 'gzip, br', Origin: 'null',
    Cookie: 'secret=private', Authorization: 'Bearer secret', 'X-Forwarded-For': '1.2.3.4',
    'X-AOB-Upstream': 'https://attacker.invalid/',
  } }));
  assert.equal(observed.url, url.replace('https://w.', 'https://api.'));
  assert.equal(observed.init.headers.get('Host'), 'w.arenaofbias.icu');
  assert.equal(observed.init.headers.get('If-None-Match'), 'W/"v0"');
  assert.equal(observed.init.headers.get('Accept-Encoding'), 'gzip, br');
  assert.equal(observed.init.headers.get('Origin'), 'null');
  for (const name of ['Cookie', 'Authorization', 'X-Forwarded-For', 'X-AOB-Upstream'])
    assert.equal(observed.init.headers.get(name), null);
  assert.equal(observed.init.eo.resolveOverride, '114.66.27.88');
  assert.equal(observed.init.redirect, 'manual');
  assert.equal(observed.init.eo.timeoutSetting.connectTimeout, 10000);
  assert.equal(observed.init.eo.timeoutSetting.readTimeout, 10000);
  assert.equal(await result.text(), 'original bytes');
  assert.equal(result.headers.get('Cache-Control'), policy);
  assert.equal(result.headers.get('Content-Security-Policy'), 'sandbox allow-scripts');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*');
});

test('private keys, formal review, shell, runtime and methods retain the original CDN path', async () => {
  for (const path of ['p', 'd', 'm', 'e'].map(prefix => `/c/${prefix}${'1'.repeat(32)}/`)
    .concat([`/v/${key}/`, '/_aob/content-runtime.test.js', '/c/w-not-a-key/', '/api/session'])) {
    let calls = 0;
    const original = new Request('https://w.arenaofbias.icu' + path);
    const upstream = new Response('private', { headers: { 'Cache-Control': 'no-store' } });
    const result = await runtime(async request => { calls++; assert.equal(request, original); return upstream; })(original);
    assert.equal(calls, 1); assert.equal(result, upstream);
  }
  for (const method of ['OPTIONS', 'POST']) {
    const original = new Request(base, { method });
    await runtime(async request => { assert.equal(request, original); return new Response(null, { status: 204 }); })(original);
  }
  for (const url of [base.replace('https:', 'http:')]) {
    const original = new Request(url);
    await runtime(async request => { assert.equal(request, original); return new Response('old path'); })(original);
  }
  for (const host of ['evil.arenaofbias.icu', 'example.eo-edgefunctions.com', 'w.arenaofbias.icu:8443']) {
    const result = await runtime(async () => { throw new Error('must not fetch an unmatched/default host'); })(
      new Request(base.replace('w.arenaofbias.icu', host)));
    assert.equal(result.status, 404); assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});

test('origin alone decides 304, withdrawals and updates; no additional fetch for errors', async () => {
  for (const [status, etag] of [[304, 'W/"v1"'], [410, null], [404, null], [429, null], [503, null], [200, 'W/"v2"']]) {
    let calls = 0;
    const run = runtime(async () => {
      calls++;
      return new Response(status === 304 ? null : 'current response', { status,
        headers: { 'Cache-Control': status < 400 ? policy : 'no-store', ...(etag ? { ETag: etag } : {}) } });
    });
    const result = await run(new Request(base, { headers: { 'If-None-Match': 'W/"v1"' } }));
    assert.equal(calls, 1); assert.equal(result.status, status);
    assert.equal(result.headers.get('ETag'), etag);
    assert.equal(await result.text(), status === 304 ? '' : 'current response');
    if (status >= 400) assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});

test('curated resources, HEAD, gzip and redirects preserve response semantics', async () => {
  const compressed = Uint8Array.from([31, 139, 8, 0, 0, 0, 0, 0]);
  let original;
  const run = runtime(async (_url, init) => {
    original = new Response(init.method === 'HEAD' ? null : compressed, { headers: {
      'Content-Encoding': 'gzip', 'Content-Length': String(compressed.length), ETag: 'W/"gzip"', Vary: 'Accept-Encoding',
    } });
    return original;
  });
  const curated = base.replace('/c/w', '/c/c') + 'assets/model.glb';
  const result = await run(new Request(curated));
  assert.equal(result, original, 'preserve runtime body encoding metadata');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), compressed);
  assert.equal(result.headers.get('Content-Encoding'), 'gzip');
  assert.equal(result.headers.get('Content-Length'), String(compressed.length));
  const head = await run(new Request(base, { method: 'HEAD' }));
  assert.equal(await head.text(), ''); assert.equal(head.headers.get('Content-Length'), String(compressed.length));
  const redirect = await runtime(async () => new Response(null, { status: 302, headers: { Location: './index.html' } }))(new Request(base));
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('Location'), './index.html');
});

test('transport errors fall back once to ordinary download without inventing 304', async () => {
  const original = new Request(base, { headers: { 'If-None-Match': 'W/"v1"' } });
  let calls = 0;
  const result = await runtime(async request => {
    if (++calls === 1) throw new Error('origin timeout');
    assert.equal(request, original); return new Response('full existing CDN response');
  })(original);
  assert.equal(calls, 2); assert.equal(result.status, 200); assert.equal(await result.text(), 'full existing CDN response');
});
