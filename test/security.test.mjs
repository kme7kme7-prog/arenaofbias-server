import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlatform } from '../server/app.mjs';
import { guardCaptureContext } from '../server/capture.mjs';
import { limits } from '../server/config.mjs';
import { clientIp } from '../server/http.mjs';

async function withSite(run, trustProxy = false) {
  const root = mkdtempSync(join(tmpdir(), 'security-regression-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, '_scenes', 'probe'), { recursive: true });
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Audit', models: [], tasks: [] }));
  writeFileSync(join(dist, '_scenes', 'probe', 'index.html'), '<!doctype html><script>fetch("/api/admin/users")</script>');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script>fetch("/api/admin/users")</script>');
  writeFileSync(join(dist, 'probe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), admin: fileURLToPath(new URL('../admin', import.meta.url)),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: [], cdn: [],
    capture: false, secureCookies: false, trustProxy }, limits });
  const server = createServer(platform.handleSite);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('API static files cannot execute package HTML or SVG, and the full catalog is private', async () => {
  await withSite(async (base) => {
    for (const path of ['/', '/index.html', '/_scenes/probe/', '/_scenes/probe/index.html']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
    const svg = await fetch(base + '/probe.svg');
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    await svg.arrayBuffer();
    const data = await fetch(base + '/data.json');
    assert.equal(data.status, 404);
    await data.arrayBuffer();
    const admin = await fetch(base + '/admin/');
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get('content-security-policy'), /script-src 'self'/);
    assert.doesNotMatch(admin.headers.get('content-security-policy'), /sandbox/);
    await admin.arrayBuffer();
  });
});

test('malformed content URLs return 400 and the same process continues serving works', () => {
  const root = mkdtempSync(join(tmpdir(), 'content-security-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><p>Work remains available</p>');
  const source = `
    import { createServer, request } from 'node:http';
    import { createContentHandler } from ${JSON.stringify(new URL('../server/content.mjs', import.meta.url).href)};
    const handler = createContentHandler({ config: { cdn: [] }, siteOrigins: ['http://localhost'], arena: {},
      library: { publicContent: () => true, byContentKey: () => ({ dir: ${JSON.stringify(root)}, entry: 'index.html', moderation: { status: 'legacy' } }) } });
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const statuses = [];
    for (const path of ${JSON.stringify(['//[', '/\\[', 'http://[', '/'])}) {
      statuses.push(await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server.address().port, path,
          headers: { host: 'w' + '1'.repeat(32) + '.localhost' } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end();
      }));
    }
    await new Promise(resolve => server.close(resolve));
    console.log(JSON.stringify(statuses));
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [400, 400, 400, 200]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('client-supplied forwarded prefixes cannot reset the login rate limit', async () => {
  await withSite(async (base) => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: {
        origin: base, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.5`,
      }, body: JSON.stringify({ name: 'unknown-audit-user', password: 'wrong-password' }) });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    assert.deepEqual(statuses, [...Array(5).fill(401), ...Array(6).fill(429)]);
  }, true);
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.1' },
    socket: { remoteAddress: '203.0.113.5' } }, true), '203.0.113.5', 'direct clients cannot supply proxy identities');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.1, invalid' },
    socket: { remoteAddress: '127.0.0.1' } }, true), '127.0.0.1', 'invalid proxy values fall back to the socket');
});

test('capture routing blocks foreign navigation, WebSockets and private redirects before fetching them', async () => {
  let routeHandler, socketHandler;
  const context = {
    route: async (_pattern, handler) => { routeHandler = handler; },
    routeWebSocket: async (_pattern, handler) => { socketHandler = handler; },
  };
  await guardCaptureContext(context, { origin: 'http://work.localhost:5180', cdn: ['cdn.example'] });
  let socketClosed = false;
  await socketHandler({ close: () => { socketClosed = true; } });
  assert.equal(socketClosed, true);

  async function request(url, resourceType, responses = {}) {
    const fetched = [];
    let outcome;
    await routeHandler({
      request: () => ({ url: () => url, method: () => 'GET', resourceType: () => resourceType, allHeaders: async () => ({}) }),
      abort: async () => { outcome = 'aborted'; },
      fulfill: async () => { outcome = 'fulfilled'; },
      fetch: async (options) => {
        fetched.push(options.url);
        assert.equal(options.maxRedirects, 0);
        if (options.headers) assert.equal(options.headers.host, new URL(url).host);
        const value = responses[options.url] ?? { status: 200, headers: {} };
        return { status: () => value.status, headers: () => value.headers, dispose: async () => {} };
      },
    });
    return { fetched, outcome };
  }
  assert.deepEqual(await request('http://127.0.0.1:9999/internal', 'document'), { fetched: [], outcome: 'aborted' });
  assert.deepEqual(await request('https://cdn.example/page', 'document'), { fetched: [], outcome: 'aborted' });
  assert.deepEqual(await request('http://work.localhost:5180/app.js', 'script'), {
    fetched: ['http://127.0.0.1:5180/app.js'], outcome: 'fulfilled',
  });
  assert.deepEqual(await request('https://cdn.example/module', 'script', {
    'https://cdn.example/module': { status: 302, headers: { location: 'http://127.0.0.1:9999/internal' } },
  }), { fetched: ['https://cdn.example/module'], outcome: 'aborted' });
  assert.deepEqual(await request('https://cdn.example/module', 'script', {
    'https://cdn.example/module': { status: 302, headers: { location: '/module.js' } },
  }), { fetched: ['https://cdn.example/module', 'https://cdn.example/module.js'], outcome: 'fulfilled' });
});
