import { finishViewing } from './helpers/arena.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { ASPECTS, pickAspect, trialScores, trialStandings } from '../server/aspects.mjs';

test('guided pairs are staff-only trials that ask one aspect question and stay off every board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guided-trial-'));
  const dist = join(root, 'dist');
  const tasks = [['tower', '建模'], ['page', '静态网页']].map(([id, category]) => ({ id, title: id, summary: 'Summary', prompt: 'Build',
    category, domains: ['建筑'], results: ['a', 'b'].map((model) => {
      const scene = `results/${id}/${model}/`;
      mkdirSync(join(dist, scene), { recursive: true });
      writeFileSync(join(dist, scene, 'index.html'), `<title>${id}</title>`);
      return { id: model, model, effort: 'High', scene, generationMode: 'single-turn', humanIntervention: 'none' };
    }) }));
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false }, limits });
  const { arena, db } = platform;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const guided = (user, task) => arena.createMatch(user, task, null, undefined, false, null, null, true);
  try {
    const [member, admin, moderator] = [['member', 'user'], ['admin', 'admin'], ['moderator', 'moderator']].map(([id, role]) => ({ id, name: id, role }));
    for (const user of [member, admin, moderator]) db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.name, 'unused', 'unused', 1);

    // Ordinary pairs are unchanged and take no trial fields.
    const plain = await arena.createMatch(admin, 'tower');
    assert.deepEqual(['aspect' in plain, 'guided' in plain, plain.counted], [false, false, true]);
    finishViewing(db, plain.id);
    assert.throws(() => arena.vote(admin, plain.id, 'tie', { tieKind: 'good' }), { status: 400 });

    await assert.rejects(guided(member, 'tower'), { status: 403, code: 'guided-staff-only' });
    const page = await guided(admin, 'page');
    assert.deepEqual([page.guided, page.aspect, page.counted, page.countableFor], [true, null, false, { public: false, curated: false }]);

    const first = await guided(admin, 'tower');
    assert.ok(ASPECTS['建模'].some((aspect) => aspect.id === first.aspect.id && aspect.question === first.aspect.question));
    finishViewing(db, first.id);
    assert.throws(() => arena.vote(admin, first.id, 'a', { tieKind: 'good' }), { status: 400 });
    assert.throws(() => arena.vote(admin, first.id, 'a', { aspect: { id: 'other', choice: 'a' } }), { status: 400 });
    const result = arena.vote(admin, first.id, 'tie', { tieKind: 'bad', aspect: { id: first.aspect.id, choice: 'tie', tieKind: 'good' } });
    assert.deepEqual([result.counted, result.reason, result.tieKind, result.aspect], [false, 'trial', 'bad', { id: first.aspect.id, choice: 'tie', tieKind: 'good' }]);
    assert.ok(result.a && result.b, 'a trial ballot still reveals the pair');

    // The next trial pair asks a question with fewer answers; leaving it out skips only that question.
    const second = await guided(moderator, 'tower');
    assert.notEqual(second.aspect.id, first.aspect.id);
    finishViewing(db, second.id);
    const secondResult = arena.vote(moderator, second.id, 'b');
    assert.equal(secondResult.reason, 'trial');
    const rows = db.prepare('SELECT user_id, choice, tie_kind, aspect_id, aspect_choice, aspect_tie_kind FROM guided_trial_votes ORDER BY created_at, rowid').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { user_id: 'admin', choice: 'tie', tie_kind: 'bad', aspect_id: first.aspect.id, aspect_choice: 'tie', aspect_tie_kind: 'good' },
      { user_id: 'moderator', choice: 'b', tie_kind: null, aspect_id: second.aspect.id, aspect_choice: null, aspect_tie_kind: null },
    ]);
    assert.equal(count('votes'), 0);
    assert.equal((await arena.leaderboard({ task: 'tower' })).totals.votes, 0);

    // The ordinary ballot still counts as before.
    assert.equal(arena.vote(admin, plain.id, 'a').counted, true);
    assert.deepEqual([count('votes'), count('guided_trial_votes')], [1, 2]);

    // The staff dimension chart counts the trial pairs that carried an aspect question, per model or configuration.
    await assert.rejects(arena.guidedDimensions(member), { status: 403, code: 'guided-staff-only' });
    const dimension = ASPECTS['建模'].find((aspect) => aspect.id === first.aspect.id).dimension;
    const chart = await arena.guidedDimensions(moderator);
    assert.deepEqual([chart.by, chart.categories, chart.totals.pairs, chart.totals.answered, chart.totals.voters], ['model', ['建模'], 2, 1, 2]);
    assert.strictEqual(await arena.guidedDimensions(moderator), chart, 'unchanged reads reuse the fitted result');
    assert.notStrictEqual(await arena.guidedDimensions(admin), chart, 'senior visibility has a separate cache');
    assert.notStrictEqual(await arena.guidedDimensions(moderator, 'config'), chart, 'configuration view has a separate cache');
    const entry = Object.fromEntries(chart.entries.map((row) => [row.model, row]));
    assert.deepEqual([entry[secondResult.b.model].overall, entry[secondResult.a.model].overall],
      [{ win: 1, tie: 1, loss: 0, n: 2 }, { win: 0, tie: 1, loss: 1, n: 2 }]);
    for (const row of chart.entries) {
      const { score, interval, thin, ...counts } = row.dimensions[dimension];
      assert.ok(Number.isFinite(score) && interval > 0 && thin);
      assert.deepEqual(counts, { win: 0, tie: 1, loss: 0, n: 1, aspects: { [first.aspect.id]: { win: 0, tie: 1, loss: 0, n: 1 } } });
      assert.equal(Object.values(row.dimensions).reduce((sum, cell) => sum + cell.n, 0), 1);
    }
    assert.deepEqual((await arena.guidedDimensions(admin, 'config')).entries.map((row) => row.effort), ['High', 'High']);

    // Restricted works stay out of a non-senior staff member's chart, as on the boards.
    platform.library.restricted.add('x:secret', 'Secret', 'test');
    const sample = db.prepare('SELECT a_identity, b_identity FROM guided_trial_votes LIMIT 1').get();
    const secret = JSON.stringify({ ...JSON.parse(sample.a_identity), modelId: null, modelName: 'Secret', modelKey: 'x:secret' });
    db.prepare('INSERT INTO guided_trial_votes (id, match_id, user_id, task_id, a_work, b_work, choice, aspect_id, aspect_choice, a_identity, b_identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('secret', 'secret-match', 'admin', 'tower', 'x', 'y', 'a', first.aspect.id, 'a', secret, sample.b_identity, Date.now());
    const fresh = await arena.guidedDimensions(moderator);
    assert.notStrictEqual(fresh, chart, 'a new row invalidates without an explicit clear');
    assert.equal(fresh.totals.pairs, 2);
    arena.invalidate();
    assert.notStrictEqual(await arena.guidedDimensions(moderator), fresh, 'prior/attribution invalidation also clears fitted results');
    assert.deepEqual((await arena.guidedDimensions(admin)).entries.find((row) => row.key === 'x:secret')?.dimensions[dimension].win, 1);

    // Release the fixture's sole ordinary pair for the following isolated trial checks.
    db.prepare('DELETE FROM votes').run();
    // Senior-only settings replace the off set and affect subsequent draws.
    assert.throws(() => arena.taskAspects(moderator, 'tower'), { status: 403 });
    assert.throws(() => arena.taskAspects(admin, 'missing'), { status: 404, code: 'not_found' });
    assert.throws(() => arena.taskAspects(admin, 'tower', { off: ['invalid'] }), { status: 400, code: 'invalid_aspects' });
    const off = ASPECTS['建模'].filter(aspect => aspect.id !== 'floating').map(aspect => aspect.id);
    assert.deepEqual(arena.taskAspects(admin, 'tower', { off }).off, [...off].sort());
    const previousOrder = process.env.GUIDED_ASPECT_ORDER;
    try {
      for (const mode of ['after', 'before', 'random']) {
        process.env.GUIDED_ASPECT_ORDER = mode;
        const match = await guided(admin, 'tower');
        assert.equal(match.aspect.id, 'floating');
        assert.ok(['after', 'before'].includes(match.aspectOrder));
        if (mode !== 'random') assert.equal(match.aspectOrder, mode);
        finishViewing(db, match.id);
        arena.vote(admin, match.id, 'a', { aspect: { id: match.aspect.id, choice: 'b' } });
        assert.equal(db.prepare('SELECT aspect_order FROM guided_trial_votes WHERE match_id=?').get(match.id).aspect_order, match.aspectOrder);
      }
    } finally {
      if (previousOrder === undefined) delete process.env.GUIDED_ASPECT_ORDER;
      else process.env.GUIDED_ASPECT_ORDER = previousOrder;
    }
    arena.taskAspects(admin, 'tower', { off: ASPECTS['建模'].map(aspect => aspect.id) });
    assert.equal((await guided(admin, 'tower')).aspect, null);

    const skipped = await guided(admin, 'tower');
    assert.throws(() => arena.skipReason(admin, skipped.id, 'broken'), { status: 409, code: 'match_not_skipped' });
    finishViewing(db, skipped.id);
    arena.vote(admin, skipped.id, 'skip');
    assert.throws(() => arena.skipReason(moderator, skipped.id, 'broken'), { status: 404 });
    assert.throws(() => arena.skipReason(admin, skipped.id, 'other'), { status: 400, code: 'invalid_skip_reason' });
    assert.deepEqual(arena.skipReason(admin, skipped.id, 'broken'), { ok: true });
    assert.throws(() => arena.skipReason(admin, skipped.id, 'unsure'), { status: 409, code: 'skip_reason_exists' });
    const saved = db.prepare('SELECT * FROM skip_reasons WHERE match_id=?').get(skipped.id);
    assert.ok(saved.a_identity && saved.b_identity);
    const visitor = await arena.createMatch(null, 'tower', null, undefined, false, null, 'visitor');
    finishViewing(db, visitor.id);
    arena.vote(null, visitor.id, 'skip', { visitorHash: 'visitor' });
    assert.throws(() => arena.skipReason(null, visitor.id, 'recognized', 'outsider'), { status: 404 });
    assert.throws(() => arena.skipReason(admin, visitor.id, 'recognized', 'visitor'), { status: 404 });
    assert.deepEqual(arena.skipReason(null, visitor.id, 'recognized', 'visitor'), { ok: true });
    assert.throws(() => arena.skipReasonStats(moderator), { status: 403 });
    const stats = arena.skipReasonStats(admin);
    assert.equal(stats.tasks.find(row => row.task === 'tower').n, 2);
    assert.equal(stats.broken.length, 2);
    db.prepare('DELETE FROM matches WHERE id=?').run(visitor.id);
    assert.ok(db.prepare('SELECT 1 FROM skip_reasons WHERE match_id=?').get(visitor.id));
  } finally {
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dimension chart skips pairs without an aspect question and pairs within one entry', () => {
  const work = (modelKey) => ({ modelKey, modelName: modelKey });
  const ballots = [
    { a: work('m1'), b: work('m2'), choice: 'a', aspectId: 'lighting', aspectChoice: 'b', userId: 'u1', createdAt: 2000 },
    { a: work('m1'), b: work('m1'), choice: 'a', aspectId: 'lighting', aspectChoice: 'a', userId: 'u2', createdAt: 3000 },
    { a: work('m2'), b: work('m1'), choice: 'tie', aspectId: null, aspectChoice: null, userId: 'u2', createdAt: 1000 },
    { a: work('m2'), b: work('m3'), choice: 'b', aspectId: 'floating', aspectChoice: null, userId: 'u3', createdAt: 4000 },
  ];
  const chart = trialStandings(ballots, (identity) => identity.modelKey, (identity) => ({ modelName: identity.modelName, effort: '' }));
  assert.deepEqual(chart.dimensions.map((dimension) => dimension.id), ['aesthetic', 'craft', 'logic', 'fit', 'diverge']);
  assert.deepEqual(chart.dimensions[0].aspects.map((aspect) => aspect.id), ['atmosphere', 'lighting', 'material']);
  assert.deepEqual(chart.totals, { pairs: 2, answered: 1, voters: 2, since: new Date(2000).toISOString(), until: new Date(4000).toISOString() });
  const entry = Object.fromEntries(chart.entries.map((row) => [row.key, row]));
  assert.deepEqual(chart.entries.map((row) => row.key), ['m2', 'm1', 'm3']);
  assert.deepEqual([entry.m1.overall, entry.m2.overall, entry.m3.overall],
    [{ win: 1, tie: 0, loss: 0, n: 1 }, { win: 0, tie: 0, loss: 2, n: 2 }, { win: 1, tie: 0, loss: 0, n: 1 }]);
  assert.deepEqual(entry.m1.dimensions.aesthetic, { win: 0, tie: 0, loss: 1, n: 1, aspects: { lighting: { win: 0, tie: 0, loss: 1, n: 1 } } });
  assert.deepEqual(entry.m2.dimensions.aesthetic.aspects, { lighting: { win: 1, tie: 0, loss: 0, n: 1 } });
  assert.equal(entry.m3.dimensions.craft.n, 0);
});

test('dimension-first rotation balances 10,000 answers and respects disabled aspects', () => {
  const counts = new Map(), dimensions = new Map();
  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 10000; i++) {
    const aspect = pickAspect({ category: '建模' }, [...counts].map(([aspect_id, n]) => ({ aspect_id, n })), random);
    counts.set(aspect.id, (counts.get(aspect.id) ?? 0) + 1);
    dimensions.set(aspect.dimension, (dimensions.get(aspect.dimension) ?? 0) + 1);
  }
  assert.equal(dimensions.size, 4);
  for (const n of dimensions.values()) assert.ok(n >= 2300 && n <= 2700);
  const off = new Set(['floating', 'atmosphere', 'material']);
  for (let i = 0; i < 1000; i++) assert.ok(!off.has(pickAspect({ category: '建模' }, [], random, off).id));
  assert.equal(pickAspect({ category: '建模' }, [], random, new Set(ASPECTS['建模'].map(a => a.id))), null);
});

test('anchored dimension scores use category priors and health separates presentation order', () => {
  const a = { id: 'a', taskId: 't', modelKey: 'a' }, b = { id: 'b', taskId: 't', modelKey: 'b' };
  const ballots = Array.from({ length: 60 }, (_, i) => ({ a, b, choice: 'a', aspectChoice: i < 30 ? 'a' : 'tie',
    aspectId: 'fidelity', aspectOrder: i < 30 ? 'before' : 'after', userId: `u${i}`, createdAt: i }));
  const chart = trialScores(ballots, w => w.modelKey, () => ({}), new Map([['a', 1300], ['b', 1200]]));
  const left = chart.entries.find(row => row.key === 'a');
  assert.equal(left.prior, 1300);
  assert.equal(left.dimensions.craft.score, 1300, 'no answers stays at its category prior');
  assert.equal(left.dimensions.craft.thin, true);
  assert.equal(left.dimensions.fit.n, 60);
  assert.equal(left.dimensions.fit.thin, false);
  assert.ok(left.dimensions.fit.score > left.dimensions.craft.score);
  assert.ok(chart.boards.fit[0].score > chart.boards.fit[1].score);
  const health = chart.health.find(row => row.id === 'fidelity');
  assert.deepEqual(health.byOrder.before.flags, ['same-side']);
  assert.deepEqual(health.byOrder.after.flags, ['ties']);
  assert.equal(health.byOrder.before.agreementRate, 1);
  assert.equal(health.byOrder.after.sameSideRate, null);
  const thin = trialScores(ballots.slice(0, 19), w => w.modelKey, () => ({}));
  assert.deepEqual(thin.health.find(row => row.id === 'fidelity').flags, []);
  assert.equal(thin.entries[0].prior, null);
});

test('v56 preserves old trial order and reruns idempotently', async () => {
  const { MIGRATIONS, openDatabase } = await import('../server/db.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(tmpdir(), 'guided-v56-'));
  const file = join(root, 'platform.db');
  try {
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys=ON');
    for (const step of MIGRATIONS.slice(0, 55)) typeof step === 'function' ? step(old) : old.exec(step);
    old.exec('PRAGMA user_version=55');
    old.prepare("INSERT INTO guided_trial_votes (id,match_id,task_id,a_work,b_work,choice,created_at) VALUES ('old','old','t','a','b','a',1)").run();
    old.close();
    const db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.equal(db.prepare("SELECT aspect_order FROM guided_trial_votes WHERE id='old'").get().aspect_order, 'before');
    MIGRATIONS[55](db);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('agreement aggregates duplicate voters, flipped sides and missing voters without pair enumeration', () => {
  const a = { id: 'a', taskId: 't', modelKey: 'a' }, b = { id: 'b', taskId: 't', modelKey: 'b' };
  const rows = [
    ['u1', 'a', false], ['u1', 'b', false], ['u2', 'b', true],
    ['u2', 'tie', true], ['u3', 'tie', false], [null, 'a', false],
  ].map(([userId, aspectChoice, flip], i) => ({ a: flip ? b : a, b: flip ? a : b,
    userId, choice: 'a', aspectChoice, aspectId: 'floating', createdAt: i }));
  let expectedN = 0, expectedSame = 0;
  const pick = row => row.aspectChoice === 'tie' ? 'tie' : row[row.aspectChoice].id;
  rows.forEach((row, i) => rows.slice(0, i).forEach(other => {
    if (row.userId && other.userId && row.userId !== other.userId) {
      expectedN++; if (pick(row) === pick(other)) expectedSame++;
    }
  }));
  const health = trialScores(rows, w => w.modelKey, () => ({})).health[0];
  assert.equal(health.agreementN, expectedN);
  assert.equal(health.agreementRate, expectedSame / expectedN);
  const many = Array.from({ length: 20000 }, (_, i) => ({ ...rows[0], userId: `u${i}` }));
  const large = trialScores(many, w => w.modelKey, () => ({})).health[0];
  assert.equal(large.agreementN, 199990000);
  assert.equal(large.agreementRate, 1);
});

test('dimension rank ranges reflect tied scores and are deterministic for a fixed snapshot', () => {
  const a = { id: 'a', modelKey: 'a' }, b = { id: 'b', modelKey: 'b' };
  const rows = [{ a, b, choice: 'tie', aspectId: 'floating', aspectChoice: 'tie', createdAt: 1 }];
  const read = () => trialScores(rows, w => w.modelKey, () => ({}), new Map(), { seedKey: 'model|false|fixed-trial-revision' });
  const first = read(), second = read();
  assert.deepEqual(first.boards, second.boards);
  assert.deepEqual(first.boards.craft.map(row => [row.rankLow, row.rankHigh]), [[1, 2], [1, 2]]);
  assert.deepEqual(first.boards.aesthetic, []);
});
