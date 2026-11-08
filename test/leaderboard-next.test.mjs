import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createArena } from '../server/arena.mjs';
import { createCatalog, modelKey, entityKey } from '../server/catalog.mjs';
import { createLibrary } from '../server/library.mjs';
import { openDatabase } from '../server/db.mjs';
import { rankEntries } from '../server/ranking.mjs';
import { limits } from '../server/config.mjs';
import { CURATED_BOARDS } from '../server/curated-boards.mjs';

function fixture(taskSpecs = null) {
  const root = mkdtempSync(join(tmpdir(), 'curated-ranking-'));
  const selected = CURATED_BOARDS.frontend.taskIds[0];
  const entries = [['ah', 'a', 'High'], ['al', 'a', 'Low'], ['b', 'b', 'High'], ['c', 'c', 'High'],
    ['dh', 'd', 'High'], ['dl', 'd', 'Low'], ['unknown', 'unknown', 'High'], ['pool', 'pool-only', 'High']];
  const tasks = (taskSpecs ?? [selected, 'not-selected'].map(id => ({id,category:'design'}))).map(({id,category}) => ({ id, category, domains: ['demo'], title: id,
    results: entries.map(([key, model, effort]) => ({ id: key, model, effort, title: key,
      generationMode: 'single-turn', humanIntervention: 'none', scene: `results/${id}/${key}/` })) }));
  for (const task of tasks) for (const work of task.results) {
    mkdirSync(join(root, work.scene), { recursive: true });
    writeFileSync(join(root, work.scene, 'index.html'), `<title>${task.id}/${work.id}</title>`);
  }
  writeFileSync(join(root, 'data.json'), JSON.stringify({ tasks, modelPool: [{ id: 'pool-only', name: 'Pool only' }], models: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() })) }));
  const db = openDatabase(join(root, 'state/platform.db'));
  const catalog = createCatalog(root);
  const config = { dist: root, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false };
  const library = createLibrary({ db, catalog, limits, config });
  const arena = createArena({ db, catalog, library, limits });
  db.prepare('UPDATE curated_settings SET counting_started_at=? WHERE id=1').run(1700000000000);
  let n = 0;
  const vote = (a, b, count, task = selected, extra = {}) => {
    const identity = (id) => {
      const work = library.work(task, id);
      return JSON.stringify({ ...work, dir: undefined, digest: Object.keys(extra).length ? 'earlier-content' : catalog.snapshot().entryDigest(work),
        modelKey: modelKey(work), configKey: entityKey(work), ...extra });
    };
    for (let i = 0; i < count; i++) {
      const id = `vote-${++n}`;
      db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source, a_identity, b_identity, voter_level)
        VALUES (?, ?, ?, ?, ?, ?, 'a', ?, 'arena', ?, ?, 1)`).run(id, id, task, a, b, id,
        db.prepare('SELECT counting_started_at FROM curated_settings WHERE id=1').get().counting_started_at, identity(a), identity(b));
    }
    arena.invalidate();
  };
  return { arena, catalog, library, db, vote, selected, config, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}


// Frozen DTOs were generated with lb/baseline (5e63606), with fixed qualification time.
const omitTime = (value) => JSON.parse(JSON.stringify(value), (key, v) =>
  ['updatedAt', 'nextUpdateAt'].includes(key) ? undefined : v);
const cases = [{ by: 'model' }, { by: 'config' }, { by: 'model', category: 'design' },
  { by: 'config', task: CURATED_BOARDS.frontend.taskIds[0] }, { by: 'model', audience: 'curated' }];

test('v2 matches frozen baseline field for field and v3 caches stay separate', async () => {
  const f = fixture();
  try {
    f.vote('ah', 'b', 35); f.vote('al', 'c', 24); f.vote('dh', 'b', 22, 'not-selected');
    const baseline = JSON.parse(readFileSync(new URL('./fixtures/leaderboard-v2.json', import.meta.url)));
    for (let i = 0; i < cases.length; i++) {
      const before = await f.arena.leaderboardSnapshot(cases[i]);
      assert.deepEqual(omitTime(before), baseline[i]);
      const next = await f.arena.leaderboardSnapshot({ ...cases[i], scoring: 3 });
      assert.deepEqual(omitTime(await f.arena.leaderboardSnapshot(cases[i])), baseline[i]);
      if (cases[i].audience === 'curated') assert.deepEqual(omitTime(next), baseline[i]);
      else {
        assert.equal(next.scoring.version, 3);
        assert.ok(next.rows.every(r => r.games >= 21));
        assert.ok(next.watch.length + next.rows.length + next.partial.length > 0);
        assert.deepEqual(next, await f.arena.leaderboardSnapshot({ ...cases[i], scoring: 3 }));
      }
    }
  } finally { f.close(); }
});

test('/next selects v3; previous opens only after switching; curated and weighted trial keep v2', async () => {
  const f = fixture(); let platform, server;
  const localLimits = { ...limits, board: { ...limits.board, scoring: 2 } };
  try {
    f.vote('ah', 'b', 35); f.vote('al', 'c', 24); f.vote('dh', 'b', 22, 'not-selected');
    platform = createPlatform({ config: f.config, limits: localLimits });
    server = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/leaderboard`;
    const get = async (suffix) => { const response = await fetch(base + suffix); return [response.status, await response.json()]; };
    const [status, next] = await get('/next?by=model');
    assert.equal(status, 200); assert.equal(next.scoring.version, 3);
    const [, v2] = await get('?by=model');
    assert.equal(v2.scoring, undefined);
    const baseline = JSON.parse(readFileSync(new URL('./fixtures/leaderboard-v2.json', import.meta.url)));
    assert.deepEqual(omitTime(v2), baseline[0]);
    assert.equal((await get('/previous'))[0], 404);
    assert.equal((await get('/next?audience=curated'))[1].scoring, undefined);
    assert.equal((await get('/weighted-trial'))[1].scoring, undefined);
    localLimits.board.scoring = 3;
    assert.equal((await get('?by=model'))[1].scoring.version, 3);
    assert.deepEqual(omitTime((await get('/previous?by=model'))[1]), omitTime(v2));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await platform?.close(); f.close();
  }
});

test('three category fits compose full rows, partial coverage and watch in both views', async () => {
  const categories = Object.keys(limits.board.composite);
  const tasks = categories.flatMap((category,c) => Array.from({length:3},(_,i) => ({id:`t${c}-${i}`,category})));
  const f = fixture(tasks);
  try {
    for (const task of tasks) f.vote('ah','b',10,task.id);
    for (const task of tasks.slice(0,3)) f.vote('dh','c',10,task.id);
    f.vote('unknown','pool',21,tasks[0].id);
    for (const by of ['config','model']) {
      const board = await f.arena.leaderboardSnapshot({by,scoring:3});
      assert.equal(board.rows.length,2); assert.equal(board.partial.length,2); assert.equal(board.watch.length,2);
      for (const row of board.rows) {
        assert.equal(Object.keys(row.parts).length,3);
        assert.ok(Math.abs(row.score - Object.values(row.parts).reduce((s,p)=>s+p.aligned,0)/3)<1e-9);
        assert.ok(row.rankLow<=row.rank && row.rankHigh>=row.rank);
      }
      assert.ok(board.partial.every(r=>r.missing.length===2 && !('score' in r) && !('rank' in r)));
      assert.ok(board.watch.every(r=>r.reasons[0]==='coverage' && !('rank' in r)));
      const domain = await f.arena.leaderboardSnapshot({by,scoring:3,domain:'demo'});
      assert.equal(domain.partial.length,0);
      assert.ok(domain.watch.some(r=>r.reasons.includes('tasks')));
      const single = await f.arena.leaderboardSnapshot({by,scoring:3,task:tasks[0].id});
      assert.ok(single.rows.every(r=>r.interval===r.intervalVotes));
    }
  } finally { f.close(); }
});

test('warmup and HTTP scoring defaults share snapshots, including curated override', async () => {
  const f = fixture();
  try {
    f.vote('ah','b',30);
    const normal = await f.arena.leaderboardSnapshot({by:'model'});
    assert.equal(normal, await f.arena.leaderboardSnapshot({by:'model',scoring:2,weightedTrial:false}));
    const curated = await f.arena.leaderboardSnapshot({by:'model',board:'frontend'});
    assert.equal(curated, await f.arena.leaderboardSnapshot({by:'model',board:'frontend',scoring:3,weightedTrial:false}));
    const switched = createArena({ db:f.db,catalog:f.catalog,library:f.library,
      limits:{...limits,board:{...limits.board,scoring:3}} });
    const warmed = await switched.leaderboardSnapshot({by:'model'});
    assert.equal(warmed.scoring.version,3);
    assert.equal(warmed, await switched.leaderboardSnapshot({by:'model',scoring:3,weightedTrial:false}));
  } finally {f.close();}
});
