import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAuth } from '../server/auth.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { createLoginSecurity } from '../server/login-security.mjs';

const options = { admins: [], secureCookies: false, sessionTtl: 30 * 24 * 3600e3 };
function session(auth, user, previous) {
  let cookie;
  auth.startSession({ setHeader: (_name, value) => { cookie = value.split(';')[0]; } }, user.id,
    previous ? { headers: { cookie: previous } } : undefined);
  return cookie;
}
const request = (cookie) => ({ headers: { cookie } });

test('a successful login rotates and revokes the browser session without revoking another device', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, options);
    const user = await auth.register('reader', 'correct password');
    const original = session(auth, user);
    const other = session(auth, user);
    const replacement = session(auth, await auth.login('reader', 'correct password'), original);
    assert.notEqual(original, replacement);
    assert.equal(auth.userFrom(request(original)), null);
    assert.equal(auth.userFrom(request(replacement)).id, user.id);
    assert.equal(auth.userFrom(request(other)).id, user.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
  } finally { db.close(); }
});

test('member and effective admin sessions expire when idle and retain absolute expiry', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { ...options, admins: ['reserved'] });
    const member = await auth.register('reader', 'correct password');
    const admin = auth.createAdmin('operator', 'correct password');
    const reserved = auth.createAdmin('reserved', 'correct password');
    db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(reserved.id);
    for (const user of [admin, reserved]) {
      const cookie = session(auth, user);
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').run(Date.now() - 31 * 60e3, user.id);
      assert.equal(auth.userFrom(request(cookie)), null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
    }
    const cookie = session(auth, member);
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 23 * 3600e3);
    const absoluteExpiry = db.prepare('SELECT expires_at FROM sessions').get().expires_at;
    assert.equal(auth.userFrom(request(cookie)).id, member.id);
    const touched = db.prepare('SELECT last_seen_at, expires_at FROM sessions').get();
    assert.ok(touched.last_seen_at > Date.now() - 1000);
    assert.equal(touched.expires_at, absoluteExpiry);
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 25 * 3600e3);
    assert.equal(auth.userFrom(request(cookie)), null);
    const expired = session(auth, member);
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal(auth.userFrom(request(expired)), null);
  } finally { db.close(); }
});

test('the session idle migration preserves creation and absolute expiry and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const idle = MIGRATIONS.at(-3);
    for (const migration of MIGRATIONS.slice(0, -3)) {
      if (typeof migration === 'function') migration(db);
      else db.exec(migration);
    }
    db.exec("INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES ('u', 'reader', 'reader', 'member', 's', 'h', 100)");
    db.exec("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('token', 'u', 200, 300)");
    idle(db);
    assert.deepEqual({ ...db.prepare('SELECT created_at, expires_at, last_seen_at FROM sessions').get() },
      { created_at: 200, expires_at: 300, last_seen_at: 200 });
    db.exec('UPDATE sessions SET last_seen_at = 250');
    idle(db);
    assert.equal(db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at, 250);
  } finally { db.close(); }
});

test('login failures lock normalized accounts across IPs and log effective admin failures', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { ...options, admins: ['reserved'] });
    auth.createAdmin('operator', 'correct password');
    let time = 1_000_000;
    const guard = createLoginSecurity(db, { isAdminName: auth.isAdminName, now: () => time });
    for (let i = 0; i < 5; i++) {
      const attempt = guard.begin(i % 2 ? ' OPERATOR ' : 'ＯＰＥＲＡＴＯＲ', `198.51.100.${i + 1}`);
      guard.failure(attempt);
      guard.finish(attempt);
    }
    assert.throws(() => guard.begin('operator', '203.0.113.5'),
      (error) => error.status === 429 && error.code === 'login_limited' && error.retryAfter === 900);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'admin-login-failed'").get().n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'login-blocked'").get().n, 1);
    const reserved = guard.begin('reserved', '203.0.113.6');
    guard.failure(reserved);
    guard.finish(reserved);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'admin-login-failed'").get().n, 6,
      'configured names are audited even before CLI account creation');
    time += 15 * 60e3;
    const renewed = guard.begin('operator', '203.0.113.5');
    guard.success(renewed);
    guard.finish(renewed);
  } finally { db.close(); }
});

test('unknown and ordinary accounts share IP locks; in-flight attempts release without recording captcha failures', () => {
  const db = openDatabase(':memory:');
  try {
    const guard = createLoginSecurity(db, { isAdminName: () => false, now: () => 1_000_000 });
    const active = Array.from({ length: 5 }, (_, i) => guard.begin('unknown', `198.51.100.${i}`));
    assert.throws(() => guard.begin('unknown', '198.51.100.9'), (error) => error.status === 429);
    guard.finish(active[0]);
    guard.finish(active[0]);
    const replacement = guard.begin('unknown', '198.51.100.9');
    guard.finish(replacement);
    for (const attempt of active) guard.finish(attempt);
    for (let i = 0; i < 5; i++) {
      const attempt = guard.begin(`unknown-${i}`, '203.0.113.1');
      guard.failure(attempt);
      guard.finish(attempt);
    }
    assert.throws(() => guard.begin('different-user', '203.0.113.1'), (error) => error.status === 429 && error.code === 'login_limited');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'admin-login-failed'").get().n, 0);
    const normal = guard.begin('ordinary', '203.0.113.2');
    guard.success(normal);
    guard.finish(normal);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'login-blocked'").get().n, 1);
  } finally { db.close(); }
});

test('role edits cannot report demoting an administrator fixed by configuration', () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { ...options, admins: ['reserved'] });
    const actor = auth.createAdmin('operator', 'correct password');
    const fixed = auth.createAdmin('reserved', 'correct password');
    assert.throws(() => auth.setRole(actor, fixed.id, 'member'), (error) => error.status === 409);
    assert.equal(auth.isAdminName(' OPERATOR '), true);
    assert.equal(auth.isAdminName('ＲＥＳＥＲＶＥＤ'), true);
    assert.equal(auth.isAdminName('unknown'), false);
    assert.equal(auth.setRole(actor, fixed.id, 'admin').role, 'admin');
  } finally { db.close(); }
});

test('a global in-flight budget limits concurrent verification from distinct accounts and IPs', () => {
  const db = openDatabase(':memory:');
  try {
    const guard = createLoginSecurity(db, { isAdminName: () => false });
    const active = Array.from({ length: 32 }, (_, i) => guard.begin(`account-${i}`, `198.51.100.${i}`));
    assert.throws(() => guard.begin('next-account', '203.0.113.1'),
      (error) => error.status === 429 && error.retryAfter === 1);
    guard.finish(active[0]);
    const next = guard.begin('next-account', '203.0.113.1');
    guard.finish(next);
    for (const attempt of active) guard.finish(attempt);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
  } finally { db.close(); }
});
