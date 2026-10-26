import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase, transaction } from '../server/db.mjs';

test('read indexes upgrade v52 without changing records, ballot order or expired-round eligibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'query-indexes-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  const ballots = "SELECT id, a_identity, b_identity FROM votes WHERE source = 'arena' AND voided_at IS NULL ORDER BY created_at";
  const pairs = 'SELECT pair_key, a_work, b_work FROM votes WHERE user_id = ? AND task_id = ?';
  const corrections = "SELECT detail FROM audit WHERE action = 'vote-identity-correction' ORDER BY id";
  const moves = "SELECT at, work_id, detail FROM audit WHERE action IN ('meta', 'inbox-assign') AND detail LIKE '%归属题目 % → %'";
  const cleanup = 'DELETE FROM matches WHERE expires_at <= ? AND (choice IS NULL OR user_id IS NULL) AND id NOT IN (SELECT match_id FROM votes)';
  const survivors = () => {
    db.exec('SAVEPOINT cleanup');
    db.prepare(cleanup).run(100);
    const ids = db.prepare('SELECT id FROM matches ORDER BY id').all().map(row => row.id);
    db.exec('ROLLBACK TO cleanup; RELEASE cleanup');
    return ids;
  };
  const records = () => Object.fromEntries(['users', 'votes', 'matches', 'audit'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('\n');
  try {
    for (const migration of MIGRATIONS.slice(0, 52)) typeof migration === 'function' ? migration(db) : db.exec(migration);
    db.exec("PRAGMA user_version = 52; INSERT INTO users(id,name,name_key,salt,hash,created_at) VALUES ('u','User','user','s','h',1)");
    const match = db.prepare(`INSERT INTO matches(id,user_id,task_id,a_work,b_work,a_token,b_token,created_at,expires_at,choice)
      VALUES (?,?,'task','a','b',?,?,1,?,?)`);
    for (const [id, userId, expires, choice] of [
      ['anonymous-pending', null, 99, null], ['anonymous-skipped', null, 99, 'skip'], ['anonymous-voted', null, 99, 'a'],
      ['member-pending', 'u', 99, null], ['member-skipped', 'u', 99, 'skip'], ['member-voted', 'u', 99, 'a'],
      ['live', null, 101, null],
    ]) match.run(id, userId, `a-${id}`, `b-${id}`, expires, choice);
    const vote = db.prepare(`INSERT INTO votes(id,match_id,user_id,task_id,a_work,b_work,pair_key,choice,created_at,source,a_identity,b_identity,voided_at)
      VALUES (?,?,?,'task','a','b',?,'a',?,?,'{"saved":"a"}','{"saved":"b"}',?)`);
    // Same-time ballots stay in the original insertion order; legacy and voided rows stay excluded.
    vote.run('second-alphabetically', 'anonymous-voted', null, 'p1', 10, 'arena', null);
    vote.run('first-alphabetically', 'member-voted', 'u', 'p2', 10, 'arena', null);
    vote.run('legacy', 'legacy-match', 'u', 'p3', 9, 'show1', null);
    vote.run('voided', 'voided-match', 'u', 'p4', 9, 'arena', 20);
    const audit = db.prepare('INSERT INTO audit(at,actor_name,action,work_id,detail) VALUES (1,\'Admin\',?,?,?)');
    for (let i = 0; i < 40; i++) audit.run('work-edit', 'a', 'ordinary edit');
    audit.run('vote-identity-correction', 'a', '{"reason":"manual","voteId":"one"}');
    audit.run('meta', 'a', '归属题目 old → new');
    audit.run('inbox-assign', 'b', '归属题目 new → old');
    audit.run('vote-identity-correction', 'b', '{"reason":"manual","voteId":"two"}');
    const before = records(), beforeBallots = db.prepare(ballots).all(), beforePairs = db.prepare(pairs).all('u', 'task');
    const beforeCorrections = db.prepare(corrections).all();
    const beforeMoves = db.prepare(moves).all().map(JSON.stringify).sort();
    const remaining = survivors();
    assert.deepEqual(remaining, ['anonymous-voted', 'live', 'member-skipped', 'member-voted']);
    db.close();
    db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.deepEqual(records(), before);
    assert.deepEqual(db.prepare(ballots).all(), beforeBallots);
    assert.deepEqual(db.prepare(pairs).all('u', 'task').map(JSON.stringify).sort(), beforePairs.map(JSON.stringify).sort());
    assert.deepEqual(db.prepare(corrections).all(), beforeCorrections);
    assert.deepEqual(db.prepare(moves).all().map(JSON.stringify).sort(), beforeMoves);
    assert.deepEqual(survivors(), remaining);
    assert.match(plan(ballots), /USING INDEX votes_arena_created/);
    assert.doesNotMatch(plan(ballots), /TEMP B-TREE/);
    assert.match(plan(pairs, 'u', 'task'), /USING INDEX votes_user_task \(user_id=\? AND task_id=\?\)/);
    assert.match(plan(cleanup, 100), /USING INDEX matches_disposable_expiry \(expires_at<\?\)/);
    assert.match(plan(corrections), /USING INDEX audit_action/);
    assert.match(plan(moves), /USING INDEX audit_action/);
    transaction(db, () => MIGRATIONS[52](db));
    assert.deepEqual(records(), before, 'the index migration is safe to rerun');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
    db = openDatabase(file);
    assert.deepEqual(records(), before, 'reopening the upgraded database preserves every existing record');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
