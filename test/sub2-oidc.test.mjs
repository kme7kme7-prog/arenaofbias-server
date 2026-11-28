import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { SUB2_OIDC_PATH } from '../server/sub2-oidc.mjs';

test('Arena registration, session reuse and signed Sub2API authorization with single-use PKCE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-sub2-oidc-'));
  const original = process.env.ARENA_SUB2_OIDC_CONFIG;
  const issuer = 'https://api.example.test' + SUB2_OIDC_PATH;
  const redirectUri = 'https://sub2api.example.test/api/v1/auth/oauth/oidc/callback';
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const clientId = 'sub2api';
  const clientSecret = 'a'.repeat(43);
  const verifier = 'b'.repeat(64);
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const nonce = 'browser_nonce';
  let delivered, platform, server;
  try {
    const configPath = join(dir, 'oidc.json');
    writeFileSync(configPath, JSON.stringify({ issuer, redirectUri, loginUrl: 'https://gallery.example.test/sub2api-login.html',
      clientId, clientSecret, privateKey }));
    process.env.ARENA_SUB2_OIDC_CONFIG = configPath;
    const dist = join(dir, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'test', models: [], tasks: [] }));
    platform = createPlatform({
      config: { dist, dataDir: join(dir, 'data'), contentTemplate: 'http://{token}.localhost:9999',
        siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false, trustProxy: false },
      limits,
      mailer: { ready: () => true, send: async (message) => { delivered = message; } },
    });
    server = createServer(platform.handleSite);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const oidc = origin + SUB2_OIDC_PATH;
    const get = (path, headers = {}) => fetch(oidc + path, { headers, redirect: 'manual' });
    const post = (path, data, cookie = '') => fetch(origin + path, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const exchange = (fields) => fetch(oidc + '/token', {
      method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier, ...fields }),
    });
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      code_challenge_method: 'S256', code_challenge: codeChallenge, state: 'browser_state', nonce, scope: 'openid email profile' });
    const location = (response) => new URL(response.headers.get('location'));

    const discovery = await (await get('/.well-known/openid-configuration')).json();
    assert.equal(discovery.issuer, issuer);
    const bad = new URLSearchParams(query);
    bad.set('redirect_uri', 'https://attacker.example.test');
    assert.equal((await get('/authorize?' + bad)).status, 400);
    const anonymous = await get('/authorize?' + query);
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    const login = location(anonymous);
    assert.equal(login.origin, 'https://gallery.example.test');
    assert.equal(login.searchParams.get('mode'), 'login');
    const resume = '/authorize?' + new URLSearchParams({ request: login.searchParams.get('request') });

    await platform.auth.register('legacyuser', 'legacy test password');
    const legacy = await post('/api/auth/login', { name: 'legacyuser', password: 'legacy test password' });
    assert.equal(legacy.status, 200);
    const legacyCookie = legacy.headers.get('set-cookie').split(';')[0];
    const unverified = await get(resume, { cookie: legacyCookie });
    assert.equal(location(unverified).searchParams.get('mode'), 'bind');

    const email = 'arena-test@example.test';
    const sent = await post('/api/auth/email/send', { purpose: 'register', email });
    assert.equal(sent.status, 200);
    const registration = await post('/api/auth/register', { name: 'arenauser', password: 'a test password', email, code: delivered.code });
    assert.equal(registration.status, 200);
    const { user } = await registration.json();
    const cookie = registration.headers.get('set-cookie').split(';')[0];
    const authenticated = await get(resume, { cookie });
    assert.equal(authenticated.status, 302);
    const callback = location(authenticated);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get('state'), 'browser_state');
    assert.equal((await get(resume, { cookie })).status, 400);

    const code = callback.searchParams.get('code');
    assert.equal((await exchange({ code, client_secret: 'invalid' })).status, 401);
    assert.equal((await exchange({ code, code_verifier: 'c'.repeat(64) })).status, 400);
    const redeemed = await exchange({ code });
    assert.equal(redeemed.status, 200);
    assert.equal((await exchange({ code })).status, 400);
    const { id_token, access_token } = await redeemed.json();
    const [head, payload, signature] = id_token.split('.');
    const jwt = JSON.parse(Buffer.from(payload, 'base64url'));
    const { keys: [jwk] } = await (await get('/jwks')).json();
    assert.equal(JSON.parse(Buffer.from(head, 'base64url')).kid, jwk.kid);
    assert(verify('RSA-SHA256', Buffer.from(head + '.' + payload), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')));
    assert.deepEqual([jwt.iss, jwt.aud, jwt.nonce, jwt.sub, jwt.email, jwt.email_verified], [issuer, clientId, nonce, user.id, email, true]);
    assert.equal((await get('/userinfo')).status, 401);
    const info = await (await get('/userinfo', { authorization: 'Bearer ' + access_token })).json();
    assert.deepEqual([info.sub, info.email, info.email_verified], [user.id, email, true]);
    const direct = await get('/authorize?' + query, { cookie });
    assert.equal(location(direct).origin, 'https://sub2api.example.test');
    const loggedOut = await post('/api/auth/logout', {}, cookie);
    assert.equal(loggedOut.status, 200);
    assert.equal(location(await get('/authorize?' + query, { cookie })).origin, 'https://gallery.example.test');
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await platform?.close();
    rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.ARENA_SUB2_OIDC_CONFIG;
    else process.env.ARENA_SUB2_OIDC_CONFIG = original;
  }
});
