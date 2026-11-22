import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { fitBradleyTerry } from '../server/ranking.mjs';

const basisId = '2b2170691c51c6c8';

test('guided charts exempt only the basis account ID in model and configuration views', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guided-weighting-'));
  const dist = join(root, 'dist');
  const task = { id: 'tower', title: 'Tower', summary: 'Synthetic', prompt: 'Build a tower', category: '建模', domains: ['建筑'],
    results: ['a', 'b'].map(model => {
      const scene = `results/tower/${model}/`;
      mkdirSync(join(dist, scene), { recursive: true });
      writeFileSync(join(dist, scene, 'index.html'), `<title>${model}</title>`);
      return { id: model, model, effort: 'High', scene, generationMode: 'single-turn', humanIntervention: 'none' };
    }) };
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks: [task] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false }, limits });
  const { db, arena } = platform;
  try {
    const insertUser = db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertUser.run('ordinary', 'arenagalleri-basis', 'arenagalleri-basis', 'admin', 'unused', 'unused', 1);
    insertUser.run(basisId, 'renamed-basis', 'renamed-basis', 'moderator', 'unused', 'unused', 1);
    const viewer = { id: 'ordinary', name: 'arenagalleri-basis', role: 'admin' };
    const identity = model => JSON.stringify({ id: model, taskId: 'tower', modelId: model, modelName: model.toUpperCase(), effort: 'High',
      modelKey: model, configKey: `${model}|high`, generationMode: 'single-turn', humanIntervention: 'none', providerId: 'official' });
    const insert = db.prepare('INSERT INTO guided_trial_votes (id, match_id, user_id, task_id, a_work, b_work, choice, aspect_id, aspect_choice, a_identity, b_identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 80; i++) insert.run(`v${i}`, `m${i}`, 'ordinary', 'tower', 'a', 'b', i < 60 ? 'a' : 'b', 'material',
      i < 60 ? 'a' : 'b', identity('a'), identity('b'), 1000 + i);
    const expected = weight => fitBradleyTerry(2, Array.from({ length: 80 }, (_, i) => ({ a: 0, b: 1, y: i < 60 ? 1 : 0, w: weight })),
      [{ mean: 0, variance: 1 }, { mean: 0, variance: 1 }], { anchored: true })[0];
    for (const by of ['model', 'config']) {
      for (const category of [null, '建模']) {
        const chart = await arena.guidedDimensions(viewer, by, category);
        const cell = chart.entries.find(row => row.model === 'a').dimensions.aesthetic;
        assert.equal(cell.score, Math.round(expected(0.5).score));
        assert.equal(cell.interval, Math.round(expected(0.5).interval));
        assert.equal(cell.n, 80);
      }
    }
    db.prepare('UPDATE guided_trial_votes SET user_id=?').run(basisId);
    arena.invalidate();
    for (const by of ['model', 'config']) {
      for (const category of [null, '建模']) {
        const chart = await arena.guidedDimensions(viewer, by, category);
        const cell = chart.entries.find(row => row.model === 'a').dimensions.aesthetic;
        assert.equal(cell.score, Math.round(expected(1).score));
        assert.equal(cell.interval, Math.round(expected(1).interval));
        assert.equal(chart.totals.pairs, 80);
        assert.equal(chart.totals.voters, 1);
      }
    }
    await assert.rejects(arena.guidedDimensions({ id: 'member', role: 'user' }), { status: 403 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
    assert.equal((await arena.leaderboard({ task: 'tower' })).totals.votes, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guided_trial_votes').get().n, 80);
  } finally {
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});
