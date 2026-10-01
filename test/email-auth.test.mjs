import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSmtpServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createEmailAuth } from '../server/auth-email.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS } from '../server/db.mjs';

let root, platform, server, smtp, base;
const messages = [];
let holdSmtpReply = false;
let releaseSmtpReply;
let smtpReplyHeld;
const originalEnv = Object.fromEntries([
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_STARTTLS',
  'MAIL_CODE_TTL_MS', 'MAIL_COOLDOWN_MS', 'MAIL_IP_MAX', 'MAIL_EMAIL_MAX',
  'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_VERIFY_URL',
].map((key) => [key, process.env[key]]));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const codeFromLastMail = () => {
  const body = messages.at(-1).split('\r\n\r\n')[1];
  return Buffer.from(body, 'base64').toString('utf8').match(/\b\d{6}\b/)[0];
};
const cookie = (response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';
async function post(path, body, session = '') {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json', ...(session ? { cookie: session } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: cookie(response) };
}
async function me(session) {
  return (await (await fetch(base + '/api/auth/me', { headers: { cookie: session } })).json()).user;
}
async function register(username, password, turnstileToken) {
  const email = `${username}-registration@test.invalid`;
  const sent = await post('/api/auth/email/send', { purpose: 'register', email, turnstileToken });
  assert.equal(sent.status, 200);
  return post('/api/auth/register', { username, password, email, code: codeFromLastMail() });
}
function openSmtp() {
  return createSmtpServer((socket) => {
    let pending = '';
    let data = false;
    let mail = '';
    socket.write('220 fake smtp\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n');
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push(mail);
            mail = '';
            data = false;
            if (holdSmtpReply) {
              releaseSmtpReply = () => socket.write('250 stored\r\n');
              smtpReplyHeld?.();
            } else socket.write('250 stored\r\n');
          } else mail += line + '\r\n';
        } else if (line.startsWith('EHLO ')) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH ')) socket.write('235 authenticated\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 send\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
}

before(async () => {
  smtp = openSmtp();
  await listen(smtp);
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_USER: 'sender@test.invalid',
    SMTP_PASS: 'test', SMTP_STARTTLS: '0', MAIL_CODE_TTL_MS: '600000',
    MAIL_COOLDOWN_MS: '1000', MAIL_IP_MAX: '100', MAIL_EMAIL_MAX: '3',
  });
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  root = mkdtempSync(join(tmpdir(), 'email-auth-v2-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'test', models: [], tasks: [] }));
  platform = createPlatform({
    config: { dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost:9999',
      siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false, trustProxy: false },
    limits,
  });
  server = createHttpServer(platform.handleSite);
  await listen(server);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await close(server);
  if (platform) await platform.close();
  if (smtp) await close(smtp);
  if (root) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let alice, alicePassword = 'correct horse';
test('registration requires a verified email and Turnstile is off without keys', async () => {
  assert.deepEqual(await (await fetch(base + '/api/auth/turnstile')).json(), { siteKey: null });
  assert.equal((await post('/api/auth/register', { username: 'alice', password: alicePassword })).status, 400);
  const result = await register('alice', alicePassword);
  assert.equal(result.status, 200);
  alice = result.cookie;
  assert.equal(result.data.user.email, 'alice-registration@test.invalid');
  const mailText = Buffer.from(messages.at(-1).split('\r\n\r\n')[1], 'base64').toString('utf8');
  assert.match(mailText, /注册账号并验证邮箱/);
});

test('email migration can rerun without changing existing account data', () => {
  const before = platform.db.prepare('SELECT * FROM users WHERE name_key = ?').get('alice');
  MIGRATIONS[23](platform.db);
  assert.deepEqual(platform.db.prepare('SELECT * FROM users WHERE name_key = ?').get('alice'), before);
});

test('registration codes are purpose-specific, one-use and roll back with failed account creation', async () => {
  const delivered = [];
  const emailAuth = createEmailAuth(platform.db, platform.auth, {
    mailer: { ready: () => true, send: async (mail) => { delivered.push(mail); } },
  });
  const email = 'atomic-registration@test.invalid';
  const body = { name: 'atomic-user', password: 'correct horse', email };
  await assert.rejects(() => emailAuth.register(body), { status: 400 });
  await emailAuth.send({ purpose: 'bind', email }, platform.auth.userFrom({ headers: { cookie: alice } }), 'core-ip');
  await assert.rejects(() => emailAuth.register({ ...body, code: delivered.at(-1).code }), { status: 400 });
  await emailAuth.send({ purpose: 'register', email }, null, 'core-ip');
  const code = delivered.at(-1).code;
  assert.equal(delivered.at(-1).purpose, 'register');
  await assert.rejects(() => emailAuth.register({ ...body, code: code === '000000' ? '000001' : '000000' }), { status: 400 });
  platform.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON users WHEN NEW.name = 'atomic-user' BEGIN SELECT RAISE(ABORT, 'registration insert failed'); END");
  try {
    await assert.rejects(() => emailAuth.register({ ...body, code }), /registration insert failed/);
    assert.equal(platform.db.prepare('SELECT id FROM users WHERE name_key = ?').get('atomic-user'), undefined);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE purpose = 'register' AND email_hash = ?")
      .get(createHash('sha256').update(email).digest('hex')).n, 1);
  } finally {
    platform.db.exec('DROP TRIGGER fail_registration');
  }
  const user = await emailAuth.register({ ...body, email: email.toUpperCase(), code });
  assert.equal(user.email, email);
  assert.equal(user.email_verified_at > 0, true);
  assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE purpose = 'register' AND email_hash = ?")
    .get(createHash('sha256').update(email).digest('hex')).n, 0);
  assert.equal('emailBound' in platform.auth.public(user), false);
  await assert.rejects(() => emailAuth.register({ ...body, name: 'another-user', email: 'unused@test.invalid', code }), { status: 400 });
  await assert.rejects(() => emailAuth.send({ purpose: 'register', email }, null, 'core-ip'), { status: 409 });
  await assert.rejects(() => emailAuth.register({ ...body, name: 'another-user', code }), { status: 409 });
});

test('registration send rejects bad emails, unavailable delivery, expired codes and shared limits', async () => {
  const delivered = [];
  const mailer = { ready: () => false, send: async (mail) => { delivered.push(mail); } };
  const emailAuth = createEmailAuth(platform.db, platform.auth, { mailer });
  await assert.rejects(() => emailAuth.send({ purpose: 'register', email: 'bad' }, null, 'registration-ip'), { status: 400 });
  await assert.rejects(() => emailAuth.send({ purpose: 'register', email: 'offline@test.invalid' }, null, 'registration-ip'), { status: 503 });
  mailer.ready = () => true;
  const email = 'registration-limit@test.invalid';
  await emailAuth.send({ purpose: 'register', email }, null, 'registration-ip');
  const code = delivered.at(-1).code;
  platform.db.prepare("UPDATE email_codes SET expires_at = 0 WHERE purpose = 'register' AND email_hash = ?")
    .run(createHash('sha256').update(email).digest('hex'));
  await assert.rejects(() => emailAuth.register({ name: 'expired-user', password: 'correct horse', email, code }), { status: 400 });
  for (let i = 0; i < 2; i++) {
    await emailAuth.send({ purpose: 'register', email }, null, 'registration-ip');
    platform.db.prepare("UPDATE email_codes SET last_sent_at = 0 WHERE purpose = 'register'").run();
  }
  await assert.rejects(() => emailAuth.send({ purpose: 'register', email }, null, 'registration-ip'), { status: 429 });
  mailer.send = async () => { throw new Error('test delivery failure'); };
  await assert.rejects(() => emailAuth.send({ purpose: 'register', email: 'delivery-fail@test.invalid' }, null, 'registration-ip'), { status: 503 });
});

test('fake SMTP receives a six-digit bind code and binding normalizes email', async () => {
  const sent = await post('/api/auth/email/send', { purpose: 'bind', email: 'ALICE@Test.invalid' }, alice);
  assert.equal(sent.status, 200);
  assert.equal(sent.data.email, 'alice@test.invalid');
  assert.match(messages.at(-1), /To: <alice@test.invalid>/);
  const code = codeFromLastMail();
  assert.match(code, /^\d{6}$/);
  assert.equal((await post('/api/auth/email/verify', { purpose: 'bind', email: 'alice@test.invalid', code }, alice)).status, 200);
  const bound = await post('/api/auth/email/bind', { email: 'ALICE@Test.invalid', code }, alice);
  assert.equal(bound.data.user.email, 'alice@test.invalid');
  assert.equal((await me(alice)).email, 'alice@test.invalid');
  assert.equal(platform.db.prepare('SELECT email_verified_at FROM users WHERE name_key = ?').get('alice').email_verified_at > 0, true);
  assert.equal((await post('/api/auth/email/bind', { email: 'alice@test.invalid', code }, alice)).status, 400);
});

test('expired codes and five wrong attempts cannot bind', async () => {
  const email = 'expire@test.invalid';
  assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email }, alice)).status, 200);
  const expired = codeFromLastMail();
  platform.db.prepare("UPDATE email_codes SET expires_at = 0 WHERE purpose = 'bind' AND email_hash = ?")
    .run(createHash('sha256').update(email).digest('hex'));
  assert.equal((await post('/api/auth/email/bind', { email, code: expired }, alice)).status, 400);
  const burn = 'burn@test.invalid';
  assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email: burn }, alice)).status, 200);
  const right = codeFromLastMail();
  const wrong = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/email/verify', { purpose: 'bind', email: burn, code: wrong }, alice)).status, 400);
  assert.equal((await post('/api/auth/email/bind', { email: burn, code: right }, alice)).status, 400);
});

test('email and IP send limits apply independently', async () => {
  const email = 'limited@test.invalid';
  for (let i = 0; i < 3; i++) {
    assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email }, alice)).status, 200);
    platform.db.prepare("UPDATE email_codes SET last_sent_at = 0 WHERE purpose = 'bind'").run();
  }
  assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email }, alice)).status, 429);
  process.env.MAIL_IP_MAX = '1';
  const limiter = createEmailAuth(platform.db, platform.auth);
  await limiter.send({ purpose: 'bind', email: 'ip-one@test.invalid' }, platform.auth.userFrom({ headers: { cookie: alice } }), 'new-ip');
  await assert.rejects(() => limiter.send({ purpose: 'bind', email: 'ip-two@test.invalid' }, platform.auth.userFrom({ headers: { cookie: alice } }), 'new-ip'), { status: 429 });
  process.env.MAIL_IP_MAX = '100';
});

test('changing email preserves the account and rejects an already bound address', async () => {
  const bob = await register('bob', 'correct horse');
  assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email: 'alice@test.invalid' }, bob.cookie)).status, 409);
  const newEmail = 'new@test.invalid';
  assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email: newEmail }, alice)).status, 200);
  const changed = await post('/api/auth/email/bind', { email: newEmail, code: codeFromLastMail() }, alice);
  assert.equal(changed.data.user.email, newEmail);
  assert.equal((await me(alice)).username, 'alice');
});

test('reset send is indistinguishable for unknown accounts; reset revokes every session', async () => {
  const second = await post('/api/auth/login', { username: 'alice', password: alicePassword });
  const unknown = await post('/api/auth/email/send', { purpose: 'reset', username: 'missing' });
  holdSmtpReply = true;
  const held = new Promise((resolve) => { smtpReplyHeld = resolve; });
  const knownRequest = post('/api/auth/email/send', { purpose: 'reset', username: 'alice' });
  await held;
  let known;
  try {
    known = await Promise.race([
      knownRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error('reset response waited for SMTP')), 1000)),
    ]);
  } finally {
    holdSmtpReply = false;
    smtpReplyHeld = undefined;
    releaseSmtpReply?.();
    releaseSmtpReply = undefined;
  }
  assert.deepEqual({ status: unknown.status, data: unknown.data }, { status: known.status, data: known.data });
  const code = codeFromLastMail();
  assert.equal((await post('/api/auth/email/verify', { purpose: 'reset', username: 'alice', code })).status, 200);
  assert.equal((await post('/api/auth/password/reset', { username: 'alice', code, password: 'new correct horse' })).status, 200);
  assert.equal(await me(alice), null);
  assert.equal(await me(second.cookie), null);
  assert.equal((await post('/api/auth/login', { username: 'alice', password: alicePassword })).status, 401);
  assert.equal((await post('/api/auth/login', { username: 'alice', password: 'new correct horse' })).data.user.email, 'new@test.invalid');
});

test('closing the platform waits for a reset email sent after the response', async () => {
  const dist = join(root, 'dist');
  const other = createPlatform({ config: { dist, dataDir: join(root, 'shutdown-data'),
    contentTemplate: 'http://{token}.localhost:9999', siteOrigins: [], admins: [], cdn: [],
    capture: false, secureCookies: false, trustProxy: false }, limits });
  const user = await other.auth.register('shutdown-user', 'correct horse');
  other.auth.bindEmail(user.id, 'shutdown@test.invalid');
  const local = createHttpServer(other.handleSite);
  await listen(local);
  const localBase = `http://127.0.0.1:${local.address().port}`;
  holdSmtpReply = true;
  const held = new Promise((resolve) => { smtpReplyHeld = resolve; });
  try {
    const response = await fetch(`${localBase}/api/auth/email/send`, { method: 'POST',
      headers: { origin: localBase, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'reset', username: 'shutdown-user' }) });
    assert.equal(response.status, 200);
    await held;
    await close(local);
    let closed = false;
    const closing = other.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    releaseSmtpReply();
    await closing;
    assert.equal(closed, true);
  } finally {
    holdSmtpReply = false;
    smtpReplyHeld = undefined;
    releaseSmtpReply?.();
    releaseSmtpReply = undefined;
    if (local.listening) await close(local);
  }
});

test('configured Turnstile gates code sends and registration uses only the sent code', async () => {
  const checks = [];
  const stub = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { checks.push(new URLSearchParams(body)); res.end(JSON.stringify({ success: new URLSearchParams(body).get('response') === 'good' })); });
  });
  await listen(stub);
  process.env.TURNSTILE_SITE_KEY = 'site-test';
  process.env.TURNSTILE_SECRET_KEY = 'secret-test';
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${stub.address().port}/siteverify`;
  try {
    assert.deepEqual(await (await fetch(base + '/api/auth/turnstile')).json(), { siteKey: 'site-test' });
    const email = 'charlie-registration@test.invalid';
    assert.equal((await post('/api/auth/email/send', { purpose: 'register', email })).status, 400);
    assert.equal((await post('/api/auth/email/send', { purpose: 'register', email, turnstileToken: 'bad' })).status, 400);
    const charlie = await register('charlie', 'correct horse', 'good');
    assert.equal(charlie.status, 200);
    assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email: 'gate@test.invalid' }, charlie.cookie)).status, 400);
    assert.equal((await post('/api/auth/email/send', { purpose: 'bind', email: 'gate@test.invalid', turnstileToken: 'good' }, charlie.cookie)).status, 200);
    assert.equal(checks.at(-1).get('secret'), 'secret-test');
  } finally {
    await close(stub);
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_VERIFY_URL;
  }
});
