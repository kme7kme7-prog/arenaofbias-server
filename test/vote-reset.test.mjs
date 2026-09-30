import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { resetVotes, voteResetCounts } from '../server/vote-reset.mjs';

test('reset CLI previews without writes, backs up all sources and clears votes and matches together', () => {
  const root = mkdtempSync(join(tmpdir(), 'aob-vote-reset-'));
  const database = join(root, 'platform.db');
  const backup = join(root, 'before-reset.db');
  const db = openDatabase(database);
  try {
    for (const source of ['legacy', 'show1', 'arena']) {
      db.prepare(`INSERT INTO matches (id, task_id, a_work, b_work, a_token, b_token, created_at, expires_at)
        VALUES (?, 'task', 'a', 'b', ?, ?, 1, 2)`).run(source, `a-${source}`, `b-${source}`);
      db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source)
        VALUES (?, ?, 'task', 'a', 'b', ?, 'a', 1, ?)`).run(source, source, source, source);
    }
    db.prepare("INSERT INTO audit (at, actor_name, action) VALUES (1, 'owner', 'existing')").run();
    db.exec(`INSERT INTO users (id, name, name_key, role, salt, hash, created_at)
      VALUES ('owner', 'owner', 'owner', 'admin', 'salt', 'hash', 1);
      INSERT INTO comments (id, task_id, work_id, user_id, body, created_at)
      VALUES ('comment', 'task', 'a', 'owner', 'keep me', 1);`);
    const command = (args) => JSON.parse(execFileSync(process.execPath, [
      fileURLToPath(new URL('../scripts/reset-votes.mjs', import.meta.url)), ...args,
    ], { encoding: 'utf8', windowsHide: true }));
    const preview = command(['--db', database]);
    assert.equal(preview.apply, false);
    assert.equal(preview.votes, 3);
    assert.equal(voteResetCounts(db).votes, 3);
    const reset = command(['--db', database, '--apply', '--backup', backup, '--actor', 'owner']);
    assert.equal(reset.before.votes, 3);
    assert.equal(reset.after.votes, 0);
    assert.equal(reset.after.matches, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'existing'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'votes-reset'").get().n, 1);
    assert.equal(db.prepare('SELECT name FROM users').get().name, 'owner');
    assert.equal(db.prepare('SELECT body FROM comments').get().body, 'keep me');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const saved = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(voteResetCounts(saved).votes, 3); assert.equal(voteResetCounts(saved).matches, 3); }
    finally { saved.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an audit failure rolls the entire reset back', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at)
      VALUES ('vote', 'match', 'task', 'a', 'b', 'pair', 'a', 1);
      CREATE TRIGGER fail_reset BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END;`);
    assert.throws(() => resetVotes(db, 'owner', 'backup'), /audit failed/);
    assert.equal(voteResetCounts(db).votes, 1);
  } finally { db.close(); }
});
