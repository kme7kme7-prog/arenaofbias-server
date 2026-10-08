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
import { createArena, pairKey } from '../server/arena.mjs';
import { fitBradleyTerry, rankEntries, rankWorks } from '../server/ranking.mjs';

const work = (id, model = 'a', extra = {}) => ({ id, model, title: id, effort: 'High',
  scene: `results/one/${id}/`, generationMode: 'single-turn', humanIntervention: 'none', ...extra });
const results = () => [work('a1'), work('a2'), work('b1', 'b'), work('b2', 'b')];

function fixture(entries = results(), textEntries = []) {
  const root = mkdtempSync(join(tmpdir(), 'blind-pool-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
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
    for (const item of entries) library.setFaceSettings({ id: 'reviewer', name: 'reviewer', role: 'admin' }, 'one', item.id, { show_arena: true });
    arena.invalidate();
  };
  let n = 0;
  const vote = (left, right, choice = 'a') => {
    const identity = (id) => {
      const item = library.work('one', id);
      return JSON.stringify({ ...item, digest: item.curated ? catalog.snapshot().entryDigest(item) : item.digest, dir: undefined, configKey: entityKey(item), modelKey: modelKey(item) });
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
    assert.deepEqual(f.arena.poolStats('one'), { works: 5, entries: 2 }, 'curated works start in the pool');
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
    const reviewer = { id: 'reviewer', name: 'reviewer', role: 'admin' };
    const view = (task, id) => f.library.adminWork(f.library.work(task, id));
    for (const [task, id] of [['one', 'a1'], ['one', 'multi'], ['text', 't1']]) f.library.setFaceSettings(reviewer, task, id, { show_arena: true });
    assert.deepEqual([view('text', 't1').arena_eligible, view('text', 't1').arena_generation_ok], [true, true]);
    assert.deepEqual([view('one', 'multi').arena_eligible, view('one', 'multi').arena_generation_ok], [false, false]);
    assert.deepEqual([view('one', 'a1').arena_eligible, view('one', 'a1').arena_generation_ok], [true, true]);
  } finally { f.close(); }
});

test('only staff can draw and count blind votes on their own uploads', async () => {
  for (const role of ['user', 'moderator', 'admin']) {
    const f = fixture([]);
    const user = { id: 'owner', name: 'owner', role, email: 'owner@example.test' };
    try {
      f.db.prepare(`INSERT INTO users (id, name, name_key, role, salt, hash, created_at, email)
        VALUES (?, ?, ?, ?, '', '', 1, ?)`).run(user.id, user.name, user.name, role, user.email);
      const insert = f.db.prepare(`INSERT INTO works (id, task_id, owner_id, title, model_id, model_other,
        content_key, source_name, root, entry, file_count, bytes, digest, checks, created_at, updated_at,
        status, show_arena, generation_mode, human_intervention)
        VALUES (?, 'one', ?, ?, ?, '', ?, 'work.html', '', 'index.html', 1, 1, 'digest', '[]', 1, 1,
          'verified', 1, 'single-turn', 'none')`);
      for (const model of ['a', 'b']) insert.run(`own-${model}`, user.id, model, model, `own-${model}`);
      assert.deepEqual(f.arena.poolStats('one'), { works: 2, entries: 2 });
      if (role === 'user') {
        await assert.rejects(() => f.arena.createMatch(user, 'one'), (error) => error.code === 'insufficient');
        // A role change before voting must also restore the ordinary user's restriction.
        const match = await f.arena.createMatch({ ...user, role: 'admin' }, 'one');
        const result = f.arena.vote(user, match.id, 'a');
        assert.deepEqual([result.counted, result.reason], [false, 'own']);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
      } else {
        const match = await f.arena.createMatch(user, 'one');
        const row = f.db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
        assert.deepEqual([row.a_work, row.b_work].sort(), ['own-a', 'own-b']);
        assert.equal(f.arena.vote(user, match.id, 'tie').counted, true, role);
        assert.equal((await f.arena.leaderboard({ task: 'one' })).totals.votes, 1);
        await assert.rejects(() => f.arena.createMatch(user, 'one'), (error) => error.code === 'exhausted');
      }
    } finally { f.close(); }
  }
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
    for (const id of ['b1', 'b2']) f.library.setFaceSettings({ id: 'reviewer', name: 'reviewer', role: 'admin' }, 'one', id, { show_arena: false });
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
    f.library.setFaceSettings({ id: 'reviewer', name: 'reviewer', role: 'admin' }, 'one', 'b1', { show_arena: false });
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

test('board totals count only comparisons the fit scored', async () => {
  const f = fixture();
  try {
    f.enable();
    f.vote('a1', 'b1');
    f.vote('a1', 'a2');
    for (const by of ['config', 'model']) {
      assert.deepEqual((await f.arena.leaderboard({ by })).totals, { votes: 1, voters: 1, entries: 2, tasks: 1 }, by);
    }
  } finally { f.close(); }
});

const coolingUser = { id: 'cooling-user', name: 'cooling-user', role: 'user' };
function coolingFixture(entries = results()) {
  const f = fixture(entries);
  f.enable();
  f.db.prepare("INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, 'user', '', '', 1)")
    .run(coolingUser.id, coolingUser.name, coolingUser.name);
  f.arena = createArena({ ...f, limits, random: () => 0 });
  let serial = 0;
  f.reveal = ({ task = 'one', a = 'a1', b = 'b1', choice = 'a', created = Date.now() - 1000,
    decided = Date.now() - 500, user = coolingUser.id, expires = Date.now() + 60000 } = {}) => {
    const id = `reveal-${++serial}`;
    f.db.prepare(`INSERT INTO matches (id, user_id, task_id, a_work, b_work, a_token, b_token,
      created_at, expires_at, choice, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, user, task, a, b, `${id}-a`, `${id}-b`, created, expires, choice, decided);
    return id;
  };
  f.draw = (strict = true, user = coolingUser) => f.arena.createMatch(user, 'one', undefined, undefined, strict);
  f.pair = (match) => {
    const row = f.db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
    return [row.a_work, row.b_work].sort();
  };
  return f;
}

test('login cooldown avoids both revealed works for a, b and tie, but excludes skip and undecided rounds', async () => {
  for (const [choice, decided, expected] of [
    ['a', 1, ['a2', 'b2']], ['b', 1, ['a2', 'b2']], ['tie', 1, ['a2', 'b2']],
    ['skip', 1, ['a1', 'b1']], [null, null, ['a1', 'b1']], ['a', null, ['a1', 'b1']], ['b', null, ['a1', 'b1']],
  ]) {
    const f = coolingFixture();
    try {
      f.reveal({ choice, decided: decided ? Date.now() - 500 : null, created: Date.now() - 2000 });
      // A later unsubmitted round avoids different works, independently of reveal cooldown.
      f.reveal({ a: 'a2', b: 'b2', choice: null, decided: null, created: Date.now() - 1000 });
      assert.deepEqual(f.pair(await f.draw()), expected, `${choice}/${decided}`);
    } finally { f.close(); }
  }
});

test('cooldown takes six reveals by creation time across tasks, then applies the fifteen-minute cutoff', async (t) => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = coolingFixture([work('a1'), work('b1', 'b')]);
  try {
    const old = f.reveal({ created: now - 10000, decided: now - 1 });
    for (let i = 0; i < 5; i++) f.reveal({ task: 'other', created: now - 9000 + i, decided: now - 16 * 60e3 });
    f.reveal({ task: 'other', choice: 'skip', created: now - 7000 });
    f.reveal({ task: 'other', choice: null, decided: null, created: now - 6000 });
    await assert.rejects(() => f.draw(), (error) => error.code === 'cooling', 'the sixth reveal still cools');
    f.reveal({ task: 'other', created: now - 8000, decided: now - 16 * 60e3 });
    assert.deepEqual(f.pair(await f.draw()), ['a1', 'b1'], 'six newer cross-task reveals evict it even with older decisions');
    f.db.prepare('DELETE FROM matches WHERE id != ?').run(old);
    f.db.prepare('UPDATE matches SET decided_at = ? WHERE id = ?').run(now - 15 * 60e3, old);
    assert.deepEqual(f.pair(await f.draw()), ['a1', 'b1'], 'cutoff is strict');
    f.db.prepare('UPDATE matches SET decided_at = ? WHERE id = ?').run(now - 16 * 60e3, old);
    assert.deepEqual(f.pair(await f.draw()), ['a1', 'b1'], 'older than fifteen minutes expires');
    f.db.exec('DELETE FROM matches');
    f.reveal({ task: 'other', created: now - 1000, decided: now - 500 });
    assert.deepEqual(f.pair(await f.draw()), ['a1', 'b1'], 'same work ids in another task are not avoided');
  } finally { f.close(); }
});

test('uncounted login reveals cool works for users and staff; skip saves a decision without revealing identities', async () => {
  for (const role of ['user', 'moderator', 'admin']) {
    const f = coolingFixture();
    const user = { ...coolingUser, role };
    try {
      const match = await f.draw(false, user);
      assert.deepEqual(f.pair(match), ['a1', 'b1']);
      const revealed = f.arena.vote(user, match.id, 'a');
      assert.deepEqual([revealed.counted, revealed.reason], [false, 'unbound']);
      assert.ok(revealed.a && revealed.b);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
      const next = await f.draw(true, user);
      assert.deepEqual(f.pair(next), ['a2', 'b2'], role);
      assert.deepEqual(f.arena.vote(user, next.id, 'skip'), {
        choice: 'skip', counted: false, reason: 'skipped', a: null, b: null,
      });
      const saved = f.db.prepare('SELECT choice, decided_at FROM matches WHERE id = ?').get(next.id);
      assert.equal(saved.choice, 'skip');
      assert.ok(saved.decided_at > 0);
      assert.deepEqual(f.pair(await f.draw(true, user)), ['a2', 'b2'], 'skipped works do not cool when previous avoidance must relax');
    } finally { f.close(); }
  }
});

test('strict draws report cooling, default draws fall back, and voted pools remain exhausted', async () => {
  const f = coolingFixture([work('a1'), work('b1', 'b')]);
  try {
    f.reveal();
    await assert.rejects(() => f.draw(), (error) => error.status === 409 && error.code === 'cooling');
    assert.deepEqual(f.pair(await f.arena.createMatch(coolingUser, 'one')), ['a1', 'b1']);
    assert.deepEqual(f.pair(await f.draw(true, null)), ['a1', 'b1'], 'anonymous draws do not use login cooldown');
    f.db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at)
      VALUES ('voted', 'voted-match', ?, 'one', 'a1', 'b1', ?, 'a', ?)`).run(coolingUser.id, pairKey('one', 'a1', 'b1'), Date.now());
    for (const strict of [false, true]) await assert.rejects(() => f.draw(strict), (error) => error.code === 'exhausted');
  } finally { f.close(); }
});

test('cleanup retains expired login decisions without counted votes, including skips, and all voted matches', () => {
  const f = coolingFixture();
  try {
    const expires = Date.now() - 1;
    const retained = ['a', 'b', 'tie', 'skip'].map((choice) => f.reveal({ choice, expires }));
    f.reveal({ choice: null, decided: null, expires });
    f.reveal({ user: null, expires });
    const voted = f.reveal({ user: null, choice: null, decided: null, expires });
    f.db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at)
      VALUES ('saved', ?, 'one', 'a1', 'b1', 'saved', 'a', 1)`).run(voted);
    retained.push(voted);
    assert.equal(f.arena.cleanupExpiredMatches(), 2);
    assert.deepEqual(f.db.prepare('SELECT id FROM matches ORDER BY id').all().map((row) => row.id), retained.sort());
  } finally { f.close(); }
});

test('a senior admin pin keeps its model in every counted pair despite cooling, until its pairs run out', async () => {
  const f = fixture([work('a1'), work('a2'), work('b1', 'b'), work('c1', 'c')]);
  const admin = { id: 'senior', name: 'senior', role: 'admin', email: 'senior@example.test' };
  try {
    f.enable();
    f.db.prepare(`INSERT INTO users (id, name, name_key, role, salt, hash, created_at, email)
      VALUES (?, ?, ?, 'admin', '', '', 1, ?)`).run(admin.id, admin.name, admin.name, admin.email);
    assert.deepEqual(f.arena.poolModels().find((model) => model.key === 'c').tasks, ['one']);
    await assert.rejects(() => f.arena.createMatch({ ...admin, role: 'moderator' }, 'one', undefined, undefined, false, 'c'), (error) => error.status === 403);
    await assert.rejects(() => f.arena.createMatch(admin, 'one', undefined, undefined, false, 'missing'), (error) => error.code === 'pinned-absent');
    const opponents = [];
    let previous;
    for (let i = 0; i < 3; i++) {
      const match = await f.arena.createMatch(admin, 'one', previous, undefined, true, 'c');
      const row = f.db.prepare('SELECT a_work, b_work, pin FROM matches WHERE id = ?').get(match.id);
      assert.equal(row.pin, 'c');
      assert.ok([row.a_work, row.b_work].includes('c1'));
      opponents.push([row.a_work, row.b_work].find((id) => id !== 'c1'));
      const result = f.arena.vote(admin, match.id, 'a');
      assert.deepEqual([result.counted, result.pinned], [true, row.a_work === 'c1' ? 'a' : 'b']);
      previous = match.id;
    }
    assert.deepEqual(opponents.sort(), ['a1', 'a2', 'b1']);
    assert.equal((await f.arena.leaderboard({ task: 'one' })).totals.votes, 3);
    await assert.rejects(() => f.arena.createMatch(admin, 'one', previous, undefined, false, 'c'), (error) => error.code === 'exhausted');
  } finally { f.close(); }
});

test('match HTTP route forwards only a boolean avoidCooling flag', async () => {
  const f = coolingFixture([work('a1'), work('b1', 'b')]);
  let platform, server;
  try {
    f.reveal();
    platform = createPlatform({ config: f.config, limits });
    let cookie;
    platform.auth.startSession({ setHeader: (_name, value) => { cookie = value.split(';')[0]; } }, coolingUser.id);
    server = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const response = await fetch(`${base}/api/arena/matches`, {
        method: 'POST', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'one', ...body }),
      });
      return { status: response.status, data: await response.json() };
    };
    const strict = await post({ avoidCooling: true });
    assert.equal(strict.status, 409);
    assert.equal(strict.data.code, 'cooling');
    for (const body of [{}, { avoidCooling: false }, { avoidCooling: 'true' }]) assert.equal((await post(body)).status, 200);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await platform?.close();
    f.close();
  }
});


test('same package content follows registration and provenance changes while other works stay put', async () => {
  const f = fixture();
  const admin = { id: 'reviewer', name: 'reviewer', role: 'admin' };
  try {
    f.enable();
    f.vote('a1', 'b1');
    f.vote('a2', 'b2');
    const saved = f.db.prepare('SELECT * FROM votes ORDER BY id').all();
    await f.arena.leaderboard();
    f.data.models.push({ id: 'c', name: 'C current', vendor: 'Current vendor' });
    f.data.tasks[0].results[0].model = 'c';
    for (const id of ['a1', 'b1']) Object.assign(f.data.tasks[0].results.find((work) => work.id === id), { harness: 'new-harness', provider: 'official' });
    f.save();
    for (const by of ['config', 'model']) {
      const board = await f.arena.leaderboard({ by });
      assert.equal(board.rows.find((row) => row.model === 'c').games, 1);
      assert.equal(board.rows.find((row) => row.model === 'a').games, 1, 'the other work keeps its original registration');
      assert.equal(board.rows.find((row) => row.model === 'c').vendor, 'Current vendor');
    }
    assert.equal((await f.arena.leaderboard({ harness: 'new-harness', provider: 'official' })).totals.votes, 1);
    assert.equal((await f.arena.leaderboard({ harness: 'unset' })).totals.votes, 1);
    f.data.models.find((model) => model.id === 'c').vendor = 'Renamed vendor';
    f.save();
    assert.equal((await f.arena.leaderboard()).rows.find((row) => row.model === 'c').vendor, 'Renamed vendor');
    f.library.remove(admin, 'one', 'a1');
    f.arena.invalidate();
    assert.equal((await f.arena.leaderboard()).rows.find((row) => row.model === 'c').games, 1, 'withdrawn content follows current attribution');
    writeFileSync(join(f.dist, 'results/one/a1/index.html'), '<title>Replacement</title>');
    f.data.title = 'Next package';
    f.save();
    assert.ok(!(await f.arena.leaderboard()).rows.some((row) => row.model === 'c'), 'changed entry digest keeps the old registration');
    assert.deepEqual(f.db.prepare('SELECT * FROM votes ORDER BY id').all(), saved);
  } finally { f.close(); }
});

test('manual corrections outrank current metadata and historical automatic corrections are ignored', async () => {
  const f = fixture();
  const admin = { id: 'reviewer', name: 'reviewer', role: 'admin' };
  try {
    f.enable();
    f.vote('a1', 'b1');
    const row = f.db.prepare('SELECT * FROM votes').get();
    const automatic = { ...JSON.parse(row.a_identity), modelId: 'auto', modelName: 'Automatic', modelKey: 'auto', configKey: 'auto|high' };
    f.db.prepare('UPDATE votes SET a_correction = ? WHERE id = ?').run(JSON.stringify(automatic), row.id);
    f.db.prepare("INSERT INTO audit (at, actor_name, action, detail) VALUES (1, 'test', 'vote-identity-correction', ?)")
      .run(JSON.stringify({ voteId: row.id, side: 'a', next: automatic, reason: '管理员更正同一上传作品的模型归属或档位' }));
    f.arena.invalidate();
    assert.ok(!(await f.arena.leaderboard()).rows.some((row) => row.model === 'auto'));
    const manual = f.arena.correctVote(admin, row.id, 'a', { modelId: 'manual', modelName: 'Manual' }, 'Explicit correction');
    assert.equal(manual.manual, true);
    f.library.setMeta(admin, 'one', 'a1', { modelId: 'b', effort: 'Max' });
    f.arena.invalidate();
    assert.ok((await f.arena.leaderboard()).rows.some((row) => row.key === 'manual|high'));
    delete manual.manual;
    f.db.prepare('UPDATE votes SET a_correction = ? WHERE id = ?').run(JSON.stringify(manual), row.id);
    f.arena.invalidate();
    assert.ok((await f.arena.leaderboard()).rows.some((row) => row.key === 'manual|high'), 'pre-marker manual audit is recognized');
    f.db.prepare('UPDATE votes SET a_correction = ? WHERE id = ?').run(JSON.stringify(automatic), row.id);
    f.db.prepare("INSERT INTO audit (at, actor_name, action, detail) VALUES (1, 'test', 'vote-identity-correction', ?)")
      .run(JSON.stringify({ voteId: row.id, side: 'a', next: automatic, reason: '管理员更正作品的模型归属或档位' }));
    f.arena.invalidate();
    assert.ok((await f.arena.leaderboard()).rows.some((row) => row.key === 'manual|high'), 'later automatic writes do not erase the explicit audit');
  } finally { f.close(); }
});
