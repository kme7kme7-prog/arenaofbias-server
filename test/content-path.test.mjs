import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentHandler } from '../server/content.mjs';
import { validateContentOrigin, contentUrl, contentRoute, pathDocument, contentRuntimePath } from '../server/content-path.mjs';
import { guardCaptureContext } from '../server/capture.mjs';

const key = prefix => `${prefix}${'a'.repeat(32)}`;
const origin = 'https://content.example.test';
const config = { contentPathOrigin: origin, contentTemplate: 'https://{token}.legacy.test', cdn: [], siteOrigins: ['https://site.example.test'] };

test('fixed transport keeps every capability on one dedicated host and rejects a trusted site origin', () => {
  for (const k of ['w', 'm', 'd', 'p', 'c'].map(key)) assert.equal(new URL(contentUrl(config, k)).origin, origin);
  assert.equal(contentUrl({ contentTemplate: config.contentTemplate }, key('w')), `https://${key('w')}.legacy.test`);
  assert.equal(validateContentOrigin(origin, config.siteOrigins), origin);
  assert.equal(validateContentOrigin('http://127.0.0.1:1234', []), 'http://127.0.0.1:1234');
  for (const value of [origin + '/', origin + '/works', 'http://content.example.test', 'https://user:pass@content.example.test', config.siteOrigins[0], config.siteOrigins[0] + ':8443'])
    assert.throws(() => validateContentOrigin(value, config.siteOrigins));
  assert.equal(contentRoute(config, { headers: { host: 'elsewhere.test' }, url: `/v/${key('w')}/` }), null);
});

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'content-path-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html><head><script type="importmap">{"imports":{"app":"/assets/app.mjs"}}</script><link href="/assets/app.css" rel="stylesheet"></head><body><img src="/image.svg"><script type="module" src="/assets/app.mjs"></script></body></html>');
  writeFileSync(join(directory, 'assets', 'app.mjs'), 'export default 42;');
  writeFileSync(join(directory, 'assets', 'app.css'), 'body{background:url(/image.svg)}');
  let available = true;
  const work = { dir: directory, entry: 'index.html', moderation: { status: 'approved' } };
  const lookup = () => available ? work : null;
  const server = createServer(createContentHandler({ config: { ...config, ...(options.pages ? { readLimits: { pages: options.pages } } : {}) }, siteOrigins: config.siteOrigins,
    library: { byContentKey: lookup, previewByKey: lookup, curatedByKey: lookup,
      draftByToken: lookup, publicContent: Boolean, publicCuratedContent: Boolean, isEligible: Boolean },
    arena: { workForToken: lookup }, qualification: { workForToken: lookup } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, host = 'content.example.test', method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = get({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host, ...headers } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
  return { request, revoke: () => { available = false; } };
}

test('trusted shell contains no work code and sandbox responses are opaque even outside the shell', async t => {
  const f = await fixture(t);
  for (const k of ['w', 'm', 'd', 'p', 'c', 'e'].map(key)) {
    const shell = await f.request(`/v/${k}/?aob=fold`);
    assert.equal(shell.status, 200);
    assert.match(shell.body, new RegExp(`data-source="/c/${k}/\\?aob=fold"`));
    assert.doesNotMatch(shell.body, /export default 42|<img src=/);
    assert.match(shell.headers['content-security-policy'], /script-src 'sha256-/);
    assert.equal(shell.headers['cache-control'], 'no-store');
    const work = await f.request(`/c/${k}/?aob=fold`);
    assert.equal(work.status, 200);
    const sandbox = work.headers['content-security-policy'].split(';')[0];
    assert.match(sandbox, /^sandbox allow-scripts/);
    assert.doesNotMatch(sandbox, /allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/);
    assert.match(work.headers['content-security-policy'], new RegExp(`connect-src https://content\\.example\\.test/c/${k}/`));
    assert.doesNotMatch(work.headers['content-security-policy'], /'self'/);
    assert.equal(work.headers['access-control-allow-origin'], '*');
    assert.equal(work.headers['access-control-allow-credentials'], undefined);
    assert.ok(work.body.includes(`src="${contentRuntimePath}"`));
    assert.match(work.body, new RegExp(`src="/c/${k}/assets/app.mjs"`));
    assert.match(work.body, /img crossorigin="anonymous"/);
  }
  f.revoke();
  const shared = await f.request(contentRuntimePath);
  assert.equal(shared.status, 200, 'shared runtime contains no work data and remains cacheable');
  assert.equal(shared.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const path of [`/v/${key('w')}/`, `/c/${key('w')}/assets/app.mjs`, `/c/${key('m')}/__content-runtime.js`])
    assert.equal((await f.request(path)).status, 410, 'revocation gates shell and every asset');
});

test('path transport rebases CSS and bridge resources, keeps HEAD and legacy addresses working', async t => {
  const f = await fixture(t), k = key('m');
  const style = await f.request(`/c/${k}/assets/app.css`);
  assert.match(style.body, new RegExp(`url\\(/c/${k}/image.svg\\)`));
  const frame = await f.request(`/c/${k}/`);
  assert.match(frame.body, new RegExp(`/c/${k}/__sp_fold.js`));
  for (const path of ['__sp_fold.js', '__content-runtime.js', 'assets/app.mjs']) {
    const result = await f.request(`/c/${k}/${path}`);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /javascript/);
  }
  const head = await f.request(`/v/${k}/`, 'content.example.test', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal((await f.request('/', `${key('w')}.legacy.test`)).status, 200);
  for (const path of ['/', '/v/not-a-key/', `/c/${k}/../../secret`, `/c/${k}/missing`])
    assert.ok((await f.request(path)).status >= 400);
});

test('rebasing preserves standards mode and remaps root module imports without changing source on disk', () => {
  const route = contentRoute(config, { headers: { host: 'content.example.test' }, url: `/c/${key('w')}/nested/index.html` });
  const source = Buffer.from('<!doctype html><body><script type="module">import "/assets/app.mjs";</script></body>');
  const result = pathDocument(source, route, '/nested/index.html').toString();
  assert.ok(result.startsWith('<!doctype html>'));
  assert.match(result, /<base href="https:\/\/content.example.test\/c\/w[a-f0-9]+\/nested\/">/);
  assert.match(result, /import "\/assets\/app.mjs"/, 'module specifier is handled by import map');
  assert.match(result, /"https:\/\/content.example.test\/":"https:\/\/content.example.test\/c\//);
  const script = '<script>const html=\'<img src="/keep-this-string">\';</script>';
  const quoted = pathDocument(Buffer.from(`<!doctype html><body><img src=/pixel.svg srcset="/a.svg 1x, /b.svg 2x">${script}</body>`), route, '/').toString();
  assert.ok(quoted.includes(script), 'script contents are not rewritten as HTML');
  assert.ok(quoted.includes(`src=${route.prefix}pixel.svg`));
  assert.ok(quoted.includes(`srcset="${route.prefix}a.svg 1x, ${route.prefix}b.svg 2x"`));
});

test('opaque work requests can preflight reads, never writes or credentialed access', async t => {
  const f = await fixture(t), url = `/c/${key('w')}/assets/app.mjs`;
  const allowed = await f.request(url, 'content.example.test', 'OPTIONS', {
    origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type,x-preview' });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-methods'], 'GET, HEAD');
  assert.equal(allowed.headers['access-control-allow-headers'], 'content-type,x-preview');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  assert.equal((await f.request(url, 'content.example.test', 'OPTIONS', { 'access-control-request-method': 'POST' })).status, 405);
  f.revoke();
  assert.equal((await f.request(url, 'content.example.test', 'OPTIONS', { 'access-control-request-method': 'GET' })).status, 410);
});

test('fixed-host shell does not halve the work HTML request budget', async t => {
  const f = await fixture(t, { pages: 1 });
  for (let i = 0; i < 3; i++) assert.equal((await f.request(`/v/${key('w')}/`)).status, 200);
  assert.equal((await f.request(`/c/${key('w')}/`)).status, 200);
  assert.equal((await f.request(`/c/${key('w')}/`)).status, 429);
});

test('shell storage and message broker accepts only its opaque child and configured parent', () => {
  const saved = new Map(), messages = [], childMessages = [];
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const window = { localStorage: storage, sessionStorage: storage };
  const parent = { postMessage: data => messages.push(data) };
  const frame = { contentWindow: { postMessage: data => childMessages.push(data) }, setAttribute() {} };
  let listener;
  runInNewContext(readFileSync(new URL('../server/content-shell.js', import.meta.url), 'utf8'), {
    window, parent, addEventListener: (_, handler) => { listener = handler; },
    document: { body: { dataset: { work: key('w'), source: `/c/${key('w')}/`, parents: JSON.stringify(config.siteOrigins) }, append() {} },
      createElement: () => frame },
  });
  const message = { source: 'aob-storage', type: 'local', op: 'set', key: '__proto__', value: 'own-work' };
  listener({ source: {}, origin: 'null', data: message });
  listener({ source: frame.contentWindow, origin, data: message });
  assert.equal(saved.size, 0, 'foreign windows and navigated non-opaque documents cannot write');
  listener({ source: frame.contentWindow, origin: 'null', data: message });
  assert.equal(JSON.parse(saved.get(`aob-work:${key('w')}`)).__proto__, 'own-work');
  assert.equal(messages.length, 0, 'storage values are not forwarded to the site');
  listener({ source: parent, origin: 'https://untrusted.example', data: 'forged' });
  assert.equal(childMessages.length, 0);
  listener({ source: parent, origin: config.siteOrigins[0], data: { source: 'sp-arena', fold: false } });
  assert.equal(childMessages.length, 1);
  listener({ source: frame.contentWindow, origin: 'null', data: 'aob:work-ready' });
  assert.equal(messages[0], 'aob:work-ready');
});

test('capture restricts same-host requests to the current capability, including redirects', async () => {
  let intercept;
  await guardCaptureContext({ routeWebSocket: async () => {}, route: async (_, handler) => { intercept = handler; } },
    { origin: `${origin}/v/${key('p')}`, cdn: [] });
  const run = async (url, redirect) => {
    let result = '', calls = 0;
    await intercept({ request: () => ({ method: () => 'GET', resourceType: () => 'document', url: () => url }),
      fetch: async () => { calls++; return { status: () => redirect ? 302 : 200, headers: () => ({ location: redirect }), dispose: async () => {} }; },
      abort: async () => { result = 'blocked'; }, fulfill: async () => { result = 'allowed'; } });
    return { result, calls };
  };
  assert.deepEqual(await run(`${origin}/v/${key('p')}/`), { result: 'allowed', calls: 1 });
  assert.deepEqual(await run(`${origin}/c/${key('p')}/assets/app.js`), { result: 'allowed', calls: 1 });
  assert.deepEqual(await run(`${origin}/c/${key('w')}/`), { result: 'blocked', calls: 0 });
  assert.deepEqual(await run(`${origin}/c/${key('p')}/`, `${origin}/c/${key('w')}/`), { result: 'blocked', calls: 1 });
});
