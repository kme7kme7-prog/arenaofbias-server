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
import { limits } from '../server/config.mjs';
import { CURATED_BOARDS } from '../server/curated-boards.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'curated-ranking-'));
  const selected = CURATED_BOARDS.frontend.taskIds[0];
  const entries = [['ah', 'a', 'High'], ['al', 'a', 'Low'], ['b', 'b', 'High'], ['c', 'c', 'High'],
    ['dh', 'd', 'High'], ['dl', 'd', 'Low'], ['unknown', 'unknown', 'High'], ['pool', 'pool-only', 'High']];
  const tasks = [selected, 'not-selected'].map((id) => ({ id, category: 'design', title: id,
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
  let n = 0;
  const vote = (a, b, count, task = selected, extra = {}) => {
    const identity = (id) => {
      const work = library.work(task, id);
      return JSON.stringify({ ...work, dir: undefined, digest: Object.keys(extra).length ? 'earlier-content' : catalog.snapshot().entryDigest(work),
        modelKey: modelKey(work), configKey: entityKey(work), ...extra });
    };
    for (let i = 0; i < count; i++) {
      const id = `vote-${++n}`;
      db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source, a_identity, b_identity)
        VALUES (?, ?, ?, ?, ?, ?, 'a', ?, 'arena', ?, ?)`).run(id, id, task, a, b, id, n, identity(a), identity(b));
    }
    arena.invalidate();
  };
  return { arena, catalog, library, vote, selected, config, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('an invalidated public fit retries with the current package instead of its captured archive', async () => {
  const f = fixture();
  try {
    const eligible = f.library.eligible, versions = [];
    let changed = false;
    f.library.eligible = (task, snapshot) => {
      versions.push(snapshot.version);
      const pool = eligible.call(f.library, task, snapshot);
      if (!changed) {
        changed = true;
        const file = join(f.config.dist, 'data.json'), data = JSON.parse(readFileSync(file));
        data.title = 'Replacement package'; writeFileSync(file, JSON.stringify(data));
        f.catalog.refresh(); f.arena.invalidate();
      }
      return pool;
    };
    await f.arena.leaderboardSnapshot({ task: f.selected });
    assert.equal(versions.length, 2);
    assert.notEqual(versions[0], versions[1]);
    assert.equal(versions[1], f.catalog.snapshot().version);
  } finally { f.close(); }
});

test('global totals, scopes and units reuse validated ballots until invalidation', async () => {
  const f = fixture();
  try {
    f.vote('ah', 'b', 30);
    let lookups = 0;
    const ballotWork = f.library.ballotWork;
    f.library.ballotWork = (...args) => { lookups++; return ballotWork.apply(f.library, args); };
    assert.equal((await f.arena.totals()).votes, 30);
    const initial = lookups;
    assert.ok(initial > 0);
    const boards = await Promise.all([f.arena.leaderboard({ by: 'model' }), f.arena.leaderboard({}),
      f.arena.leaderboard({ board: 'frontend', by: 'model' })]);
    assert.ok(boards.every((board) => board.totals.votes === 30));
    assert.equal(lookups, initial, 'scope and unit projections must not reread the same work histories');
    f.vote('ah', 'b', 1);
    assert.equal((await f.arena.totals()).votes, 31);
    assert.ok(lookups > initial, 'vote invalidation refreshes the live ballot set');
  } finally { f.close(); }
});

test('curated board uses exactly the selected questions and model-level qualification in both views', async () => {
  assert.equal(CURATED_BOARDS.frontend.taskIds.length, 36);
  assert.equal(new Set(CURATED_BOARDS.frontend.taskIds).size, 36);
  const f = fixture();
  try {
    f.vote('ah', 'b', 15);
    f.vote('al', 'b', 15);
    f.vote('c', 'b', 29);
    f.vote('unknown', 'b', 35);
    f.vote('pool', 'b', 30); // Guessing-game registry presence does not mean Gallery has registered it.
    f.vote('dh', 'dl', 40); // Same-model votes cannot qualify a model.
    f.vote('c', 'b', 100, 'not-selected'); // Full rankings qualify C; this board does not.
    const model = await f.arena.leaderboard({ board: 'frontend', by: 'model' });
    assert.equal(model.board, 'frontend');
    assert.deepEqual(model.scope.taskIds, CURATED_BOARDS.frontend.taskIds);
    assert.equal(model.totals.votes, 124);
    assert.deepEqual(new Set(model.rows.map((r) => r.model)), new Set(['a', 'b']));
    assert.ok(model.rows.every((r) => !r.provisional));
    const reference = await f.arena.leaderboard({ task: f.selected, by: 'model' });
    for (const row of model.rows) assert.equal(row.score, reference.rows.find((r) => r.key === row.key).score, 'excluded opponents remain in the fit');
    assert.ok(reference.rows.some((r) => r.model === 'unknown'));
    assert.ok((await f.arena.leaderboard({ by: 'model' })).rows.some((r) => r.model === 'c' && !r.provisional));
    const config = await f.arena.leaderboard({ board: 'frontend' });
    assert.deepEqual(new Set(config.rows.map((r) => r.key)), new Set(['a|high', 'a|low', 'b|high']));
    assert.equal(config.totals.votes, 164);
    assert.ok(config.rows.filter((r) => r.model === 'a').every((r) => r.provisional), 'a qualified model may have thin configurations');
    assert.deepEqual(config.rows.map((r) => r.rank), [1, 2, 3]);
    assert.ok(config.unranked.every((r) => ['a', 'b'].includes(r.model)));
    f.vote('c', 'b', 1);
    const boundary = await f.arena.leaderboard({ board: 'frontend', by: 'model' });
    assert.ok(boundary.rows.some((r) => r.model === 'c' && r.games === 30 && !r.provisional));
    assert.ok((await f.arena.leaderboard({ board: 'frontend' })).rows.some((r) => r.model === 'c'));
  } finally { f.close(); }
});

test('curated qualification is scoped to source filters and handles empty or invalid requests', async () => {
  const f = fixture();
  try {
    const empty = await f.arena.leaderboard({ board: 'frontend' });
    assert.deepEqual(empty.rows, []);
    assert.deepEqual(empty.unranked, []);
    f.vote('ah', 'b', 30);
    f.vote('al', 'b', 5, f.selected, { harnessId: 'special' });
    const filtered = await f.arena.leaderboard({ board: 'frontend', harness: 'special' });
    assert.equal(filtered.totals.votes, 5);
    assert.deepEqual(filtered.rows, []);
    assert.deepEqual(filtered.unranked, []);
    assert.throws(() => f.arena.leaderboard({ board: 'unknown' }), /精选榜筛选无效/);
    for (const scope of [{ task: f.selected }, { category: 'design' }, { domain: 'test' }])
      assert.throws(() => f.arena.leaderboard({ board: 'frontend', ...scope }), /精选榜筛选无效/);
  } finally { f.close(); }
});

test('leaderboard HTTP API forwards curated scope and rejects conflicting or unknown boards', async () => {
  const f = fixture();
  let platform, server;
  try {
    f.vote('ah', 'b', 30);
    platform = createPlatform({ config: f.config, limits });
    server = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/leaderboard`;
    const response = await fetch(`${base}?board=frontend&by=model`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.board, 'frontend');
    assert.equal(data.rows.length, 2);
    assert.equal(data.by, 'model');
    for (const query of ['board=unknown', 'board=frontend&category=design', `board=frontend&task=${f.selected}`]) {
      const rejected = await fetch(`${base}?${query}`);
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).code, 'invalid_query');
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await platform?.close();
    f.close();
  }
});
