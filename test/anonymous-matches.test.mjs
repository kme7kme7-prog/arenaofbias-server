import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArena } from '../server/arena.mjs';
import { limits } from '../server/config.mjs';
import { openDatabase, transaction } from '../server/db.mjs';

const addMatch = (db) => db.prepare(`INSERT INTO matches
  (id, task_id, a_work, b_work, a_token, b_token, created_at, expires_at)
  VALUES (?, 'task', 'a', 'b', ?, ?, ?, ?)`);

function arenaFor(db) {
  const snapshot = { task: () => ({}), root: 'fixture', version: 'fixture' };
  const works = ['a', 'b'].map((id) => ({ id, taskId: 'task', modelId: id, modelName: id, effort: 'High' }));
  return createArena({ db, limits, catalog: { snapshot: () => snapshot, task: () => ({}) },
    library: { eligible: () => works, originOf: (token) => `https://${token}.invalid` } });
}

test('expired unvoted rounds are removed while recorded ballots and daily guess results remain', () => {
  const db = openDatabase(':memory:');
  try {
    const now = Date.now();
    const add = addMatch(db);
    add.run('expired', 'ea', 'eb', now - 100, now - 1);
    add.run('voted', 'va', 'vb', now - 100, now - 1);
    add.run('live', 'la', 'lb', now, now + 60e3);
    db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at)
      VALUES ('vote', 'voted', 'task', 'a', 'b', 'task:a+b', 'a', ?)`).run(now - 50);
    db.prepare("INSERT INTO guess_results (id, day_key, created_at) VALUES ('daily', '2026-10-01', ?)").run(now - 100);
    const arena = arenaFor(db);
    assert.deepEqual(db.prepare('SELECT id FROM matches ORDER BY id').all().map((row) => row.id), ['live', 'voted']);
    assert.equal(arena.cleanupExpiredMatches(now + 60e3), 1);
    assert.equal(db.prepare('SELECT id FROM matches').get().id, 'voted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n, 1);
  } finally { db.close(); }
});

test('concurrent anonymous draws cannot exceed capacity and expiry releases a place', async () => {
  const db = openDatabase(':memory:');
  try {
    const now = Date.now();
    const add = addMatch(db);
    transaction(db, () => {
      for (let i = 0; i < 9999; i++) add.run(`m${i}`, `a${i}`, `b${i}`, now, now + 3600e3);
    });
    const arena = arenaFor(db);
    const draws = await Promise.allSettled([arena.createMatch(null, 'task'), arena.createMatch(null, 'task')]);
    assert.equal(draws.filter((result) => result.status === 'fulfilled').length, 1);
    const blocked = draws.find((result) => result.status === 'rejected').reason;
    assert.equal(blocked.status, 429);
    assert.equal(blocked.code, 'anonymous-capacity');
    assert.equal(blocked.retryAfter, 60);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 10000);
    db.prepare("UPDATE matches SET expires_at = ? WHERE id = 'm0'").run(now - 1);
    assert.equal(arena.cleanupExpiredMatches(), 1);
    assert.ok((await arena.createMatch(null, 'task')).id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 10000);
  } finally { db.close(); }
});
