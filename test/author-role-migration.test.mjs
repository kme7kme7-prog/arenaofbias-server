import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

const insertWork = (db, id, owner) => db.prepare(`INSERT INTO works
  (id, task_id, owner_id, title, model_other, content_key, source_name, root, entry, file_count, bytes, digest, checks, created_at, updated_at, curated_as, nominated_at)
  VALUES (?, 'task', ?, ?, 'Model', ?, 'work.html', '', 'index.html', 1, 1, ?, '[]', 1, 1, ?, 123)`)
  .run(id, owner, id, id, id, id === 'historical' ? 'replacement' : null);

for (const version of [36, 37]) test(`v${version} to v38 backfills creation roles, retains dependent rows and historical records, and is idempotent`, () => {
  const root = mkdtempSync(join(tmpdir(), 'author-role-migration-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, version)) typeof migration === 'function' ? migration(db) : db.exec(migration);
    db.exec(`PRAGMA user_version = ${version}`);
    if (version === 37) db.prepare('INSERT INTO curated_content_keys (task_id, work_id, content_key) VALUES (?, ?, ?)').run('task', 'historical', 'c' + 'a'.repeat(32));
    const user = db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [id, role] of [['senior', 'admin'], ['demoted', 'member'], ['regular', 'member']]) user.run(id, id, id, role, 'salt', 'hash', 1);
    db.exec("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('session', 'regular', 1, 100, 1)");
    const question = db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation)
      VALUES (?, ?, ?, 'Summary', 'Prompt', '[]', '["static"]', 1, ?)`);
    question.run('path', 'demoted', 'Path', JSON.stringify({ status: 'approved', reason: '管理员创建' }));
    question.run('current', 'senior', 'Current', '{"status":"approved"}');
    question.run('ordinary', 'regular', 'Ordinary', '{"status":"approved"}');
    insertWork(db, 'historical', 'demoted'); insertWork(db, 'current', 'senior'); insertWork(db, 'ordinary', 'regular');
    db.prepare(`INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (1, 'demoted', 'demoted', 'content-review', 'task', 'historical', ?)`)
      .run(JSON.stringify({ status: 'approved', reason: '管理员上传', source: 'human' }));
    db.exec(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, user_id, a_identity)
      VALUES ('v', 'v', 'task', 'historical', 'ordinary', 'pair', 'a', 1, 'regular', '{"curated":true,"modelId":"old"}')`);
    const history = { votes: db.prepare('SELECT * FROM votes').all(), audit: db.prepare('SELECT * FROM audit').all() };
    db.close(); db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 38);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('SELECT content_key FROM curated_content_keys').get()?.content_key, version === 37 ? 'c' + 'a'.repeat(32) : undefined);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    assert.equal(db.prepare("SELECT role FROM users WHERE id='regular'").get().role, 'user');
    for (const table of ['questions', 'works']) assert.deepEqual(
      db.prepare(`SELECT author_role, count(*) AS n FROM ${table} GROUP BY author_role ORDER BY author_role`).all().map(row => ({ ...row })),
      [{ author_role: 'admin', n: 2 }, { author_role: 'user', n: 1 }]);
    assert.deepEqual(db.prepare('SELECT * FROM votes').all(), history.votes);
    assert.deepEqual(db.prepare('SELECT * FROM audit').all(), history.audit);
    assert.equal(db.prepare("SELECT curated_as FROM works WHERE id='historical'").get().curated_as, 'replacement');
    assert.equal(db.prepare("SELECT nominated_at FROM works WHERE id='historical'").get().nominated_at, 123);
    db.exec("UPDATE users SET role='moderator' WHERE id='regular'");
    const rows = db.prepare('SELECT * FROM works ORDER BY id').all();
    MIGRATIONS[37](db);
    assert.deepEqual(db.prepare('SELECT * FROM works ORDER BY id').all(), rows, 'existing authorship never follows later role changes');
    assert.equal(db.prepare("SELECT author_role FROM questions WHERE id='ordinary'").get().author_role, 'user');
    db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation)
      VALUES ('moderator-new', 'regular', 'Moderator', 'Summary', 'Prompt', '[]', '["static"]', 1, '{"status":"pending"}')`).run();
    insertWork(db, 'moderator-new', 'regular');
    MIGRATIONS[37](db);
    for (const table of ['questions', 'works']) assert.deepEqual(
      db.prepare(`SELECT author_role, count(*) AS n FROM ${table} GROUP BY author_role ORDER BY author_role`).all().map(row => ({ ...row })),
      [{ author_role: 'admin', n: 2 }, { author_role: 'moderator', n: 1 }, { author_role: 'user', n: 1 }]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
