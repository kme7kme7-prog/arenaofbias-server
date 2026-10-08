import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog, entityKey, modelKey } from '../server/catalog.mjs';
import { openDatabase } from '../server/db.mjs';

function pack(root) {
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({
    models: [{ id: 'other', name: 'Other' }],
    modelPool: [{ id: 'luna', name: 'GPT-5.6 Luna', aliases: ['GPT Luna v5.6'] }],
    tasks: [{ id: 'one', title: 'Test question', category: '建模', results: [] }],
  }));
  return dist;
}

test('model names compact punctuation without confusing versions or changing x: keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-name-'));
  try {
    const catalog = createCatalog(pack(root));
    for (const name of ['gpt56 luna', 'GPT-5.6-Luna', 'ＧＰＴ５．６　Ｌｕｎａ', 'gpt luna v56']) {
      assert.equal(catalog.modelNamed(name)?.name, 'GPT-5.6 Luna');
    }
    assert.equal(catalog.modelNamed('GPT-5.7 Luna'), null);
    assert.equal(catalog.modelNamed('gpt56 luan'), null);
    const typed = { modelId: null, modelName: 'gpt56 luna', effort: 'High' };
    assert.equal(modelKey(typed), 'x:gpt56 luna');
    assert.equal(entityKey(typed), 'x:gpt56 luna|high');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate report lists a stored unregistered work with only effective ballots and leaves the database intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-duplicates-'));
  const dist = pack(root), file = join(root, 'platform.db');
  const db = openDatabase(file);
  try {
    const insert = db.prepare(`INSERT INTO works (id, task_id, title, model_id, model_other, effort, content_key, source_name,
      root, entry, file_count, bytes, digest, checks, created_at, updated_at, status, generation_mode, human_intervention)
      VALUES (?, 'one', ?, ?, ?, ?, ?, 'work.html', '', 'index.html', 1, 1, ?, '[]', 1, 1, ?, 'single-turn', 'none')`);
    insert.run('duplicate', 'Typed Luna', null, 'gpt56 luna', 'High', 'duplicate', 'duplicate-digest', 'verified');
    insert.run('opponent', 'Other', 'other', '', 'High', 'opponent', 'opponent-digest', 'verified');
    insert.run('held', 'Held', 'other', '', 'High', 'held', 'held-digest', 'unverified');
    const identity = id => {
      const row = db.prepare('SELECT * FROM works WHERE id = ?').get(id);
      return JSON.stringify({ id, taskId: 'one', modelId: row.model_id, modelName: row.model_other || 'Other', effort: row.effort, digest: row.digest });
    };
    const vote = db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source, a_identity, b_identity)
      VALUES (?, ?, 'one', 'duplicate', ?, ?, 'a', 2, ?, ?, ?)`);
    vote.run('valid', 'valid', 'opponent', 'valid', 'arena', identity('duplicate'), identity('opponent'));
    vote.run('held', 'held', 'held', 'held', 'arena', identity('duplicate'), identity('held'));
    vote.run('missing', 'missing', 'opponent', 'missing', 'arena', null, identity('opponent'));
    vote.run('legacy', 'legacy', 'opponent', 'legacy', 'legacy', identity('duplicate'), identity('opponent'));
    // Same model, different effort: counts for configurations, but not for the model board.
    insert.run('same-model', 'Typed Luna Low', 'luna', '', 'Low', 'same-model', 'same-model-digest', 'verified');
    const corrected = { id: 'duplicate', taskId: 'one', modelId: 'luna', modelName: 'GPT-5.6 Luna', effort: 'High', manual: true };
    vote.run('same-model', 'same-model', 'same-model', 'same-model', 'arena', identity('duplicate'),
      JSON.stringify({ id: 'same-model', taskId: 'one', modelId: 'luna', modelName: 'GPT-5.6 Luna', effort: 'Low' }));
    db.prepare('UPDATE votes SET a_correction = ? WHERE id = ?').run(JSON.stringify(corrected), 'same-model');
  } finally { db.close(); }
  try {
    const before = readFileSync(file);
    const result = spawnSync(process.execPath, ['scripts/report-model-duplicates.mjs', '--db', file, '--dist', dist], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.count, 1);
    assert.deepEqual(report.matches, [{ id: 'duplicate', task: 'one', taskTitle: 'Test question', modelOther: 'gpt56 luna',
      modelId: 'luna', modelName: 'GPT-5.6 Luna', status: 'verified', deletedAt: null, curatedAs: null,
      validVotes: { config: 2, model: 1 } }]);
    assert.deepEqual(readFileSync(file), before, 'report must not migrate, merge, clean up or otherwise rewrite the source database');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
