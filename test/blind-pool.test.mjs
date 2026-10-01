import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createCatalog, entityKey, modelKey } from '../server/catalog.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { createFeatured, selectFeatured } from '../server/featured.mjs';
import { createLibrary } from '../server/library.mjs';
import { createArena } from '../server/arena.mjs';
import { fitBradleyTerry, rankEntries, rankWorks } from '../server/ranking.mjs';

const work = (id, model = 'a', extra = {}) => ({ id, model, title: id, effort: 'High',
  scene: `results/one/${id}/`, generationMode: 'single-turn', humanIntervention: 'none', ...extra });
const results = () => [work('a1'), work('a2'), work('b1', 'b'), work('b2', 'b')];

function fixture(entries = results(), textEntries = []) {
  const root = mkdtempSync(join(tmpdir(), 'blind-pool-'));
  const dist = join(root, 'dist');
  for (const item of [...entries, ...textEntries]) {
    mkdirSync(join(dist, item.scene), { recursive: true });
    writeFileSync(join(dist, item.scene, 'index.html'), `<title>${item.id}</title>`);
  }
  const data = { models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks: [
    { id: 'one', title: 'One', results: entries }, { id: 'text', kind: 'text', results: textEntries },
    { id: 'community-text', templates: ['text'], results: [] },
  ] };
  const save = () => writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  save();
  const config = { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false };
  const db = openDatabase(join(config.dataDir, 'platform.db'));
  const catalog = createCatalog(dist);
  const library = createLibrary({ db, catalog, config, limits });
  const arena = createArena({ db, catalog, library, limits });
  const enable = () => {
    for (const item of entries) library.setFaceSettings({ id: 'reviewer', name: 'reviewer' }, 'one', item.id, { show_arena: true });
    arena.invalidate();
  };
  let n = 0;
  const vote = (left, right, choice = 'a') => {
    const identity = (id) => {
      const item = library.work('one', id);
      return JSON.stringify({ ...item, dir: undefined, configKey: entityKey(item), modelKey: modelKey(item) });
    };
    const id = `vote-${++n}`;
    db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source, a_identity, b_identity)
      VALUES (?, ?, 'one', ?, ?, ?, ?, ?, 'arena', ?, ?)`).run(id, id, left, right, id, choice, n, identity(left), identity(right));
    arena.invalidate();
  };
  return { root, dist, db, catalog, library, arena, data, save, enable, vote, config,
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('eligibility normalizes agent and controls matches, counted scores and pool statistics together', async () => {
  const f = fixture([...results(), work('agent', 'a', { generationMode: 'agent' }),
    work('multi', 'a', { generationMode: 'multi-turn' }), work('guided', 'b', { humanIntervention: 'prompt-guided' }),
    work('edited', 'b', { humanIntervention: 'code-edited' }), work('unset', 'b', { generationMode: '' })]);
  try {
    assert.deepEqual(f.arena.poolStats('one'), { works: 0, entries: 0 });
    f.enable();
    assert.equal(f.library.work('one', 'agent').generationMode, 'single-turn');
    assert.deepEqual(f.library.eligible('one').map((item) => item.id).sort(), ['a1', 'a2', 'agent', 'b1', 'b2']);
    f.db.exec(`INSERT INTO works (id, task_id, title, model_id, model_other, content_key, source_name, root, entry, file_count, bytes,
      digest, checks, created_at, updated_at, status, show_arena, generation_mode, human_intervention)
      VALUES ('historical', 'one', 'Historical', 'a', '', 'historical', 'work.html', '', 'index.html', 1, 1, 'old', '[]', 1, 1,
      'verified', 1, 'agent', 'none')`);
    assert.equal(f.library.work('one', 'historical').generationMode, 'single-turn');
    assert.equal(f.db.prepare("SELECT generation_mode FROM works WHERE id = 'historical'").get().generation_mode, 'agent');
    assert.deepEqual(f.arena.poolStats('one'), { works: 6, entries: 3 });
    f.vote('a1', 'b1');
    f.vote('a1', 'multi');
    assert.equal((await f.arena.leaderboard({ task: 'one' })).totals.votes, 1);
    for (let i = 0; i < 10; i++) {
      const match = await f.arena.createMatch(null, 'one');
      const row = f.db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
      assert.ok([row.a_work, row.b_work].every((id) => f.library.isEligible(f.library.work('one', id))));
    }
  } finally { f.close(); }
});

test('admin views report pool membership, and text tasks are exempt from generation rules', () => {
  const f = fixture([work('a1'), work('multi', 'a', { generationMode: 'multi-turn' })],
    [work('t1', 'a', { scene: 'results/text/t1/', generationMode: '', humanIntervention: '' })]);
  try {
    const reviewer = { id: 'reviewer', name: 'reviewer' };
    const view = (task, id) => f.library.adminWork(f.library.work(task, id));
    for (const [task, id] of [['one', 'a1'], ['one', 'multi'], ['text', 't1']]) f.library.setFaceSettings(reviewer, task, id, { show_arena: true });
    assert.deepEqual([view('text', 't1').arena_eligible, view('text', 't1').arena_generation_ok], [true, true]);
    assert.deepEqual([view('one', 'multi').arena_eligible, view('one', 'multi').arena_generation_ok], [false, false]);
    assert.deepEqual([view('one', 'a1').arena_eligible, view('one', 'a1').arena_generation_ok], [true, true]);
  } finally { f.close(); }
});

test('prompt variants never cross-match and configuration keys stay shared', async () => {
  const entries = [work('a1', 'a', { promptVariant: 'long' }), work('b1', 'b', { promptVariant: 'long' }),
    work('a2', 'a', { promptVariant: 'short' }), work('b2', 'b', { promptVariant: 'short' }), work('lone')];
  const f = fixture(entries);
  try {
    f.enable();
    for (let i = 0; i < 60; i++) {
      const match = await f.arena.createMatch(null, 'one');
      const row = f.db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
      const a = f.library.work('one', row.a_work), b = f.library.work('one', row.b_work);
      assert.equal(a.promptVariant, b.promptVariant);
      assert.notEqual(entityKey(a), entityKey(b));
      assert.notEqual(a.id, 'lone');
      assert.notEqual(b.id, 'lone');
    }
    f.vote('a1', 'b1');
    f.vote('a2', 'b2');
    const board = await f.arena.leaderboard({ task: 'one' });
    assert.equal(board.rows.length, 2);
    assert.ok(board.rows.every((row) => row.games === 2 && !row.key.includes('long') && !row.key.includes('short')));
    for (const id of ['b1', 'b2']) f.library.setFaceSettings({ id: 'reviewer', name: 'reviewer' }, 'one', id, { show_arena: false });
    await assert.rejects(() => f.arena.createMatch(null, 'one'), (error) => error.code === 'insufficient',
      'one configuration remains insufficient even when it has multiple prompt variants');
  } finally { f.close(); }
});

test('default priors preserve the original fit and work deviations include within-configuration votes', () => {
  const comparisons = [{ a: 0, b: 1, y: 1 }, { a: 0, b: 2, y: 0.5 }, { a: 1, b: 2, y: 0 }];
  assert.deepEqual(fitBradleyTerry(3, comparisons), fitBradleyTerry(3, comparisons,
    Array.from({ length: 3 }, () => ({ mean: 0, variance: 1 }))));
  const a1 = { id: 'a1', configKey: 'a' }, a2 = { id: 'a2', configKey: 'a' }, b = { id: 'b', configKey: 'b' };
  const votes = Array.from({ length: 12 }, () => ({ a: a1, b, choice: 'tie' }));
  const inside = Array.from({ length: 10 }, () => ({ a: a1, b: a2, choice: 'a' }));
  const key = (item) => item.configKey;
  assert.deepEqual(rankEntries(votes, key, { provisionalGames: 5 }), rankEntries([...votes, ...inside], key, { provisionalGames: 5 }));
  const scores = rankWorks([...votes, ...inside], key);
  assert.ok(scores.find((item) => item.id === 'a1').score > scores.find((item) => item.id === 'a2').score);
  assert.equal(scores.find((item) => item.id === 'a1').games, 22);
  assert.ok(scores.every((item) => item.interval > 0));
  const anchored = fitBradleyTerry(1, [], [{ mean: 1, variance: 0.25 }], { anchored: true });
  assert.ok(Math.abs(anchored[0].score - (1000 + 400 / Math.LN10)) < 1e-9);
  assert.ok(Math.abs(anchored[0].interval - 1.96 * 200 / Math.LN10) < 1e-9);
});

test('featured uses the five-game threshold, conservative scores, modelKey and 40-point hysteresis', () => {
  const works = [
    { id: 'old', modelId: 'cover', effort: 'High' }, { id: 'new', modelId: 'cover', effort: 'Max' },
    { id: 'lucky', modelId: 'b' }, { id: 'named', modelId: null, modelName: ' ＭＯＤＥＬ X ' },
  ];
  const scores = [{ id: 'old', score: 1100, interval: 100, games: 5 }, { id: 'new', score: 1150, interval: 111, games: 6 },
    { id: 'lucky', score: 2000, interval: 1, games: 4 }, { id: 'named', score: 1000, interval: 200, games: 5 }];
  const initial = selectFeatured(works, scores, []);
  assert.equal(initial.find((pick) => pick.scope === 'cover').work_id, 'new');
  assert.equal(initial.find((pick) => pick.scope === 'model' && pick.model_key === 'cover').work_id, 'new');
  assert.equal(initial.find((pick) => pick.model_key === 'x:model x').work_id, 'named');
  assert.equal(initial.some((pick) => pick.work_id === 'lucky'), false);
  const previous = [{ scope: 'cover', model_key: '', work_id: 'old', conservative: 500 },
    { scope: 'model', model_key: 'cover', work_id: 'old', conservative: 500 }];
  assert.ok(selectFeatured(works, scores, previous).filter((pick) => pick.model_key !== 'x:model x').every((pick) => pick.work_id === 'old'));
  scores[1].interval = 110;
  assert.equal(selectFeatured(works, scores, previous)[0].work_id, 'new', 'exactly 40 points replaces the incumbent');
});

test('daily featured refresh is asynchronous, persists across restart, skips text and drops ineligible picks immediately', async () => {
  const f = fixture();
  let service;
  try {
    f.enable();
    let now = new Date(2026, 9, 2, 12).getTime(), calls = 0;
    let scores = [{ id: 'a1', score: 1200, interval: 100, games: 5 }, { id: 'b1', score: 1100, interval: 100, games: 5 }];
    const arena = { async workScores(task) { assert.equal(task, 'one'); calls++; return scores; } };
    const options = { ...f, arena, now: () => now };
    service = createFeatured(options);
    assert.deepEqual(service.read(), {});
    assert.equal(calls, 0, 'the read schedules computation without running it');
    await service.drain();
    assert.deepEqual(service.read(), { one: { cover: 'a1', models: { a: 'a1', b: 'b1' } } });
    scores = [{ id: 'a1', score: 1100, interval: 100, games: 5 }, { id: 'b1', score: 1500, interval: 100, games: 5 }];
    await service.close();
    service = createFeatured(options);
    assert.equal(service.read().one.cover, 'a1');
    await service.drain();
    assert.equal(calls, 1);
    now = new Date(2026, 9, 3, 0).getTime();
    assert.equal(service.read().one.cover, 'a1', 'old result is returned while recomputing');
    await service.drain();
    assert.equal(service.read().one.cover, 'b1');
    f.library.setFaceSettings({ id: 'reviewer', name: 'reviewer' }, 'one', 'b1', { show_arena: false });
    assert.deepEqual(service.read().one, { cover: null, models: { a: 'a1' } });
    assert.equal(calls, 2, 'removal does not force another same-day fit');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM featured_picks WHERE work_id = ?').get('b1').n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM featured_refreshes').get().n, 1);
    MIGRATIONS.at(-1)(f.db);
    assert.equal(service.read().one.models.a, 'a1', 'migration can rerun without clearing picks');
  } finally { await service?.close(); f.close(); }
});

test('bootstrap exposes only elected tasks and works; work scores use the same counted ballots as leaderboard', async () => {
  const f = fixture();
  let platform, server;
  try {
    f.enable();
    for (let i = 0; i < 5; i++) f.vote('a1', 'b1');
    platform = createPlatform({ config: f.config, limits });
    server = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`)).json();
    await get();
    await platform.featured.drain();
    assert.deepEqual((await get()).featured, { one: { cover: 'a1', models: { a: 'a1', b: 'b1' } } });
    assert.equal((await platform.arena.workScores('one')).length, 2);
    const b = f.data.tasks[0].results.find((item) => item.id === 'b1');
    b.humanIntervention = 'code-edited';
    f.save();
    platform.arena.invalidate();
    assert.equal((await platform.arena.leaderboard({ task: 'one' })).totals.votes, 0);
    assert.deepEqual(await platform.arena.workScores('one'), []);
    assert.deepEqual((await get()).featured, { one: { cover: 'a1', models: { a: 'a1' } } });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await platform?.close();
    f.close();
  }
});

test('a day without any qualifying works is persisted and never refitted that day', async () => {
  const f = fixture();
  let service;
  try {
    let calls = 0;
    const options = { ...f, arena: { async workScores() { calls++; return []; } }, now: () => new Date(2026, 9, 2, 12).getTime() };
    service = createFeatured(options);
    assert.deepEqual(service.read(), {});
    await service.drain();
    await service.close();
    service = createFeatured(options);
    assert.deepEqual(service.read(), {});
    await service.drain();
    assert.equal(calls, 1);
  } finally { await service?.close(); f.close(); }
});
