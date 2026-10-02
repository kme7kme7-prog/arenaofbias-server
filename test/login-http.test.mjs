import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';

test('login verifies a one-use challenge before credentials and rotates the presented session', async () => {
  const keys = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_VERIFY_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const used = new Set();
  const verifier = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const token = new URLSearchParams(body).get('response');
    const success = token?.startsWith('valid-') && !used.has(token);
    used.add(token);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: Boolean(success) }));
  });
  await new Promise((resolve) => verifier.listen(0, '127.0.0.1', resolve));
  process.env.TURNSTILE_SITE_KEY = 'test-site';
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${verifier.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'login-http-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Test', models: [], tasks: [] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), admin: fileURLToPath(new URL('../admin', import.meta.url)),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: [], cdn: [], capture: false,
    secureCookies: false, trustProxy: false }, limits });
  const server = createServer(platform.handleSite);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = platform.auth.createAdmin('owner', 'correct-password');
  const member = await platform.auth.register('member', 'member-password');
  let oldCookie;
  platform.auth.startSession({ setHeader: (_name, value) => { oldCookie = value.split(';')[0]; } }, admin.id);
  let credentialChecks = 0;
  const login = platform.auth.login;
  platform.auth.login = (...args) => { credentialChecks++; return login(...args); };
  const post = (body, cookie = '') => fetch(base + '/api/auth/login', { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  try {
    const body = { name: admin.name, password: 'correct-password' };
    assert.equal((await post(body)).status, 400);
    assert.equal((await post({ ...body, turnstileToken: 'invalid' })).status, 400);
    assert.equal(credentialChecks, 0, 'invalid challenges never reach password hashing');
    const denied = await post({ ...body, password: 'wrong-password', turnstileToken: 'valid-wrong' });
    assert.equal(denied.status, 401);
    const accepted = await post({ ...body, turnstileToken: 'valid-admin' }, oldCookie);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).user.role, 'admin');
    const cookie = accepted.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, oldCookie);
    assert.equal((await (await fetch(base + '/api/auth/me', { headers: { cookie: oldCookie } })).json()).user, null);
    assert.equal((await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json()).user.role, 'admin');
    assert.equal((await post({ ...body, turnstileToken: 'valid-admin' })).status, 400, 'tokens cannot be replayed');
    const memberLogin = await post({ name: member.name, password: 'member-password', turnstileToken: 'valid-member' });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/admin/users', { headers: { cookie: memberCookie } })).status, 403);
    const checksBeforeOutage = credentialChecks;
    process.env.TURNSTILE_VERIFY_URL = 'http://127.0.0.1:1';
    assert.equal((await post({ ...body, turnstileToken: 'valid-outage' })).status, 503);
    assert.equal(credentialChecks, checksBeforeOutage, 'verification outages fail before password hashing');
    const shell = await fetch(base + '/admin/');
    assert.match(shell.headers.get('content-security-policy'), /script-src[^;]*https:\/\/challenges.cloudflare.com/);
    assert.match(shell.headers.get('content-security-policy'), /frame-src[^;]*https:\/\/challenges.cloudflare.com/);
    await shell.arrayBuffer();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    await new Promise((resolve) => verifier.close(resolve));
    rmSync(root, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
