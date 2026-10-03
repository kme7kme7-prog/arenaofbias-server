import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { limits } from '../server/config.mjs';

async function withPlatform(readLimits, run) {
  const root = mkdtempSync(join(tmpdir(), 'read-guard-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Private catalog', models: [], tasks: [] }));
  writeFileSync(join(dist, '.datapack-source.json'), JSON.stringify({ source: 'local', path: dist }));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><h1>Work</h1>');
  writeFileSync(join(dist, 'app.js'), 'console.log("work");');
  writeFileSync(join(dist, 'probe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const origin = 'https://gallery.arenaofbias.icu';
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [origin], admins: [], cdn: [],
    capture: false, secureCookies: false, trustProxy: true, readLimits }, limits });
  platform.library.byContentKey = () => ({ dir: dist, entry: 'index.html', curated: true, moderation: { status: 'legacy' } });
  const site = createServer(platform.handleSite);
  const content = createServer(platform.handleContent);
  await Promise.all([site, content].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const base = `http://127.0.0.1:${site.address().port}`;
  const work = `http://127.0.0.1:${content.address().port}`;
  async function cookie(name, admin = false) {
    const user = await verifiedUser(platform.auth, name, 'correct horse');
    if (admin) platform.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    let value;
    platform.auth.startSession({ setHeader: (_key, header) => { value = header.split(';')[0]; } }, user.id);
    return value;
  }
  async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest((options.content ? work : base) + path, {
        method: options.method ?? 'GET', headers: { origin,
          'x-forwarded-for': options.ip ?? '198.51.100.10', ...options.headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          headers: new Headers(response.headers), body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
  try { await run({ request, cookie, origin }); }
  finally {
    await Promise.all([site, content].map(server => new Promise(resolve => server.close(resolve))));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('catalog reads share an IP budget across endpoints, query strings, HEAD and sessions', async () => {
  await withPlatform({ api: 10, catalog: 3 }, async ({ request, cookie, origin }) => {
    const session = await cookie('reader');
    assert.equal((await request('/api/works?cache=one')).status, 200);
    assert.equal((await request('/api/prompts?cache=two', { method: 'HEAD',
      ip: '203.0.113.1, 198.51.100.10' })).status, 200);
    assert.equal((await request('/api/bootstrap', { headers: { cookie: session } })).status, 200);
    const denied = await request('/api/votes?scope=formal', { ip: '203.0.113.2, 198.51.100.10' });
    assert.equal(denied.status, 429);
    assert.equal((await request('/api/show1/leaderboard?scope=entertainment&category=web')).status, 429);
    assert.ok(Number(denied.headers.get('retry-after')) > 0);
    assert.equal(denied.headers.get('access-control-allow-origin'), origin);
    assert.equal((await request('/api/auth/me')).status, 200, 'small reads have a separate budget');
    assert.equal((await request('/api/works', { ip: '198.51.100.11' })).status, 200);
  });
});

test('the general read budget counts unknown API paths and keeps writes available', async () => {
  await withPlatform({ api: 2, catalog: 10 }, async ({ request }) => {
    assert.equal((await request('/api/not-a-route')).status, 404);
    assert.equal((await request('/api/auth/me', { method: 'HEAD' })).status, 200);
    assert.equal((await request('/api/prompts')).status, 429);
    assert.equal((await request('/api/auth/logout', { method: 'POST' })).status, 200);
  });
});

test('the complete package catalog is admin-only and encoded paths cannot expose it', async () => {
  await withPlatform({}, async ({ request, cookie }) => {
    const member = await cookie('member');
    const admin = await cookie('moderator', true);
    const paths = ['/data.json', '/%64ata.json', '/data%2ejson?cache=one'];
    if (process.platform === 'win32') paths.push('/DATA.JSON');
    for (const path of paths) {
      assert.equal((await request(path)).status, 404, path);
      assert.equal((await request(path, { headers: { cookie: member } })).status, 404, path);
      const allowed = await request(path, { headers: { cookie: admin } });
      assert.equal(allowed.status, 200, path);
      assert.equal(JSON.parse(allowed.body).title, 'Private catalog');
    }
    for (const headers of [{}, { cookie: admin }]) {
      assert.equal((await request('/.datapack-source.json', { headers })).status, 404);
    }
  });
});

test('API static files and work hosts share resource budgets, with a separate HTML budget', async () => {
  await withPlatform({ files: 5, pages: 1 }, async ({ request }) => {
    const host = (digit) => ({ host: `w${digit.repeat(32)}.localhost` });
    assert.equal((await request('/probe.svg')).status, 200);
    assert.equal((await request('/app.js', { content: true, headers: host('1') })).status, 200);
    assert.equal((await request('/', { content: true, headers: host('2') })).status, 200);
    const page = await request('/index.html?cache=two', { content: true, method: 'HEAD', headers: host('3') });
    assert.equal(page.status, 429);
    assert.ok(Number(page.headers.get('retry-after')) > 0);
    assert.equal((await request('/app.js', { content: true, headers: host('4') })).status, 200);
    const file = await request('/app.js?cache=three', { content: true, headers: host('5') });
    assert.equal(file.status, 429);
    assert.ok(Number(file.headers.get('retry-after')) > 0);
    assert.equal((await request('/api/auth/me')).status, 200, 'resource throttling does not lock accounts');
  });
});
