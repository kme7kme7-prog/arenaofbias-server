import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyArenaBackfill, DUPLICATE_CURATED_WORKS, planArenaBackfill } from '../server/arena-backfill.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { MIGRATIONS } from '../server/db.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arena-backfill-'));
  const database = join(root, 'platform.db'), dist = join(root, 'dist');
  mkdirSync(dist);
  const tasks = [
    { id: 'one', results: [{ id: 'curated', model: 'a', generationMode: 'single-turn', humanIntervention: 'none' }] },
    { id: 'text', kind: 'text', results: [{ id: 'text-curated', model: 'a' }] },
    { id: 'community-text', templates: ['text'], results: [] },
    ...DUPLICATE_CURATED_WORKS.map((key) => ({ id: key.split('/')[0], results: [{ id: key.split('/')[1], model: 'a' }] })),
  ];
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }], tasks }));
  const db = new DatabaseSync(database);
  for (const migration of MIGRATIONS.slice(0, 25)) typeof migration === 'function' ? migration(db) : db.exec(migration);
  db.exec('PRAGMA user_version = 25');
  const insert = db.prepare(`INSERT INTO works (id, task_id, title, model_other, content_key, source_name, root, entry,
    file_count, bytes, digest, checks, status, generation_mode, human_intervention, moderation, created_at, updated_at, show_arena)
    VALUES (?, ?, 'Work', 'M', ?, 'work.html', '', 'index.html', 1, 1, 'digest', '[]', 'verified', ?, ?, ?, 1, 1, 0)`);
  for (const [id, mode, human] of [
    ['old', '', ''], ['agent', 'agent', ''], ['single', 'single-turn', ''], ['multi', 'multi-turn', ''],
    ['guided', '', 'prompt-guided'], ['edited', 'agent', 'code-edited'], ['excluded', '', ''], ['deleted', '', ''],
  ]) insert.run(id, 'one', id, mode, human, '{"status":"legacy"}');
  insert.run('pending', 'one', 'pending', '', '', '{"status":"rejected"}');
  insert.run('text-upload', 'text', 'text-upload', 'agent', '', '{"status":"legacy"}');
  insert.run('community-upload', 'community-text', 'community-upload', '', '', '{"status":"legacy"}');
  db.exec("UPDATE works SET deleted_at = 2 WHERE id = 'deleted'");
  db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, calibration_arena, updated_by, updated_at)
    VALUES ('one', 'curated', 0, 0, 'keep calibration', 'previous', 1)`).run();
  return { root, database, dist, db, catalog: createCatalog(dist),
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('backfill CLI previews read-only and applies exclusions, audit and metadata rules in one transaction', () => {
  const f = fixture();
  try {
    const command = (args = []) => JSON.parse(execFileSync(process.execPath, ['scripts/arena-backfill.mjs',
      '--db', f.database, '--dist', f.dist, ...args], { encoding: 'utf8', windowsHide: true }));
    const before = f.db.prepare('SELECT * FROM works ORDER BY id').all();
    const preview = command();
    assert.equal(preview.apply, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM works ORDER BY id').all(), before);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 25, 'preview does not migrate');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
    assert.ok(preview.duplicates.every((item) => item.present && !item.excluded));
    assert.equal(preview.tasks.some((task) => ['text', 'community-text'].includes(task.task)), false);
    const exclude = [...DUPLICATE_CURATED_WORKS, 'one/excluded'].join(',');
    const filtered = command(['--exclude', exclude]);
    const one = filtered.tasks.find((task) => task.task === 'one');
    assert.equal(one.openCount, 7);
    assert.equal(one.generationCount, 4);
    assert.deepEqual(one.nonstandard.sort(), ['one/edited', 'one/guided', 'one/multi']);
    assert.ok(filtered.duplicates.every((item) => item.excluded));
    assert.deepEqual(one.excluded, ['one/excluded']);
    const backup = join(f.root, 'backup.db');
    const applied = command(['--exclude', exclude, '--apply', '--backup', backup, '--actor', 'owner']);
    assert.equal(applied.changedCount, filtered.changedCount);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'arena-backfill'").get().n, applied.changedCount);
    const row = (id) => f.db.prepare('SELECT * FROM works WHERE id = ?').get(id);
    for (const id of ['old', 'agent', 'single']) assert.deepEqual([row(id).generation_mode, row(id).human_intervention, row(id).show_arena], ['single-turn', 'none', 1]);
    for (const id of ['multi', 'guided', 'edited']) {
      const original = before.find((item) => item.id === id);
      assert.deepEqual([row(id).generation_mode, row(id).human_intervention], [original.generation_mode, original.human_intervention]);
      assert.equal(row(id).show_arena, 1);
    }
    for (const id of ['text-upload', 'community-upload', 'excluded', 'deleted'])
      assert.deepEqual(row(id), before.find((item) => item.id === id));
    assert.equal(row('pending').show_arena, 0);
    const curated = f.db.prepare("SELECT * FROM work_overrides WHERE task_id = 'one'").get();
    assert.deepEqual([curated.show_gallery, curated.show_arena, curated.calibration_arena], [0, 1, 'keep calibration']);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM work_overrides').get().n, 1, 'excluded duplicates and text are untouched');
    assert.equal(command(['--exclude', exclude]).changedCount, 0, 'a second run has no changes');
    const saved = new DatabaseSync(backup, { readOnly: true });
    try { assert.deepEqual(saved.prepare('SELECT * FROM works ORDER BY id').all(), before); }
    finally { saved.close(); }
  } finally { f.close(); }
});

test('an audit failure rolls back every backfill change; successful application invalidates callers', () => {
  const f = fixture();
  try {
    const before = f.db.prepare('SELECT * FROM works ORDER BY id').all();
    const overrides = f.db.prepare('SELECT * FROM work_overrides').all();
    f.db.exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    let invalidated = 0;
    const options = { actor: 'owner', invalidate: () => invalidated++ };
    assert.throws(() => applyArenaBackfill(f.db, f.catalog, options), /audit failed/);
    assert.deepEqual(f.db.prepare('SELECT * FROM works ORDER BY id').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM work_overrides').all(), overrides);
    assert.equal(invalidated, 0);
    f.db.exec('DROP TRIGGER fail_backfill');
    applyArenaBackfill(f.db, f.catalog, options);
    assert.equal(invalidated, 1);
    const report = planArenaBackfill(f.db, f.catalog);
    assert.equal(report.changes.length, 0);
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { f.close(); }
});
