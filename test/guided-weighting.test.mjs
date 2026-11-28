import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { trialScores, trialStandings } from '../server/aspects.mjs';
import { fitBradleyTerry, rankRanges } from '../server/ranking.mjs';

const modelKey = work => work.modelId;
const configKey = work => `${work.modelId}|${work.effort}`;
const describe = work => ({ modelName: work.modelId, effort: work.effort });
const work = (modelId, effort = 'default') => ({ id: `${modelId}-${effort}`, modelId, effort, taskId: 'task' });
const A = work('a'), B = work('b');
const SEED = 'guided-weighting', BASIS_ID = 'basis-user-id';
const RANGES = { draws: 2000, level: 0.95 };
const NOW = Date.parse('2026-11-19T00:00:00Z');
const votes = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  a: A, b: B, choice: 'a', aspectId: 'lighting', aspectChoice: 'a',
  userId: 'frequent', createdAt: NOW, ...(typeof extra === 'function' ? extra(i) : extra),
}));
const scores = (ballots, options = {}, keyOf = modelKey) => trialScores(
  ballots, keyOf, describe, new Map(), { seedKey: SEED, rankRange: RANGES, ...options });
const weighted = (ballots, w = 1) => ballots.map(vote => ({ vote, w }));

// Expected weights are supplied explicitly by each fixture, not recomputed from voter volumes.
function expectFit(result, dimension, expected, keyOf = modelKey) {
  const indexes = new Map(result.entries.map((row, i) => [row.key, i]));
  const fitted = fitBradleyTerry(result.entries.length, expected.map(({ vote, w }) => ({
    a: indexes.get(keyOf(vote.a)), b: indexes.get(keyOf(vote.b)),
    y: { a: 1, b: 0, tie: 0.5 }[vote.aspectChoice], w,
  })), result.entries.map(() => ({ mean: 0, variance: 1 })), { anchored: true });
  const board = [];
  result.entries.forEach((row, i) => {
    const score = Math.round(fitted[i].score), interval = Math.round(fitted[i].interval);
    const cell = row.dimensions[dimension];
    assert.equal(cell.score, score, `${dimension}/${row.key}: score`);
    assert.equal(cell.interval, interval, `${dimension}/${row.key}: interval`);
    assert.equal(cell.thin, cell.n < 10);
    if (cell.n) board.push({ key: row.key, score, interval, n: cell.n, thin: cell.n < 10 });
  });
  board.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  board.forEach((row, i) => { row.rank = i + 1; });
  const seed = createHash('sha256').update(`${SEED}|${dimension}`).digest().readUInt32BE(0);
  const ranges = rankRanges(board, { ...RANGES, seed });
  board.forEach((row, i) => { [row.rankLow, row.rankHigh] = ranges[i]; });
  assert.deepEqual(result.boards[dimension], board, `${dimension}: board and rank ranges`);
}

for (const [n, w] of [[20, 1], [21, Math.sqrt(20 / 21)], [80, 0.5]]) {
  test(`${n} answers by one voter use weight ${w}`, () => {
    const ballots = votes(n);
    const result = scores(ballots);
    expectFit(result, 'aesthetic', weighted(ballots, w));
    assert.equal(result.totals.answered, n);
    assert.ok(result.boards.aesthetic.every(row => row.n === n));
  });
}

test('80 answers from one voter differ from four voters with 20 each', () => {
  const single = votes(80);
  const multiple = votes(80, i => ({ userId: `user-${Math.floor(i / 20)}`, username: 'same-name' }));
  const one = scores(single), many = scores(multiple);
  expectFit(one, 'aesthetic', weighted(single, 0.5));
  expectFit(many, 'aesthetic', weighted(multiple));
  assert.notDeepEqual(one.boards.aesthetic, many.boards.aesthetic);
  assert.equal(one.totals.voters, 1);
  assert.equal(many.totals.voters, 4);
});

test('only the explicitly designated ID is exempt, not its name or administrator status', () => {
  for (const [identity, w] of [
    [{ userId: BASIS_ID, username: 'renamed-basis' }, 1],
    [{ userId: 'lookalike', username: 'arenagalleri-basis' }, 0.5],
    [{ userId: 'admin', username: 'administrator', role: 'admin', isAdmin: true }, 0.5],
  ]) {
    const ballots = votes(80, identity);
    expectFit(scores(ballots, { fullWeightUserId: BASIS_ID }), 'aesthetic', weighted(ballots, w));
  }
  const ballots = votes(80, { userId: BASIS_ID, username: 'arenagalleri-basis' });
  expectFit(scores(ballots), 'aesthetic', weighted(ballots, 0.5));
});

test('basis ballots remain full weight without exempting other voters in the same fit', () => {
  const basis = votes(80, { userId: BASIS_ID });
  const ordinary = votes(80, { userId: 'ordinary', aspectChoice: 'b' });
  const result = scores([...basis, ...ordinary], { fullWeightUserId: BASIS_ID });
  expectFit(result, 'aesthetic', [...weighted(basis), ...weighted(ordinary, 0.5)]);
  assert.equal(result.totals.answered, 160);
  assert.equal(result.totals.voters, 2);
});

test('dimensions are isolated while different aspects in one dimension share volume', () => {
  const lighting = votes(15);
  const material = votes(10, { aspectId: 'material', aspectChoice: 'b' });
  const craft = votes(80, { aspectId: 'floating' });
  const result = scores([...lighting, ...material, ...craft]);
  expectFit(result, 'aesthetic', weighted([...lighting, ...material], Math.sqrt(20 / 25)));
  expectFit(result, 'craft', weighted(craft, 0.5));
  assert.equal(result.entries[0].dimensions.aesthetic.n, 25);
  assert.equal(result.entries[0].dimensions.craft.n, 80);
});

test('category filtering precedes volume aggregation, including shared dimensions', () => {
  const modeling = votes(20);
  const web = votes(80, { aspectId: 'palette', aspectChoice: 'b' });
  const ballots = [...modeling, ...web];
  const selected = scores(ballots, { category: '建模' });
  expectFit(selected, 'aesthetic', weighted(modeling));
  assert.equal(selected.totals.answered, 20);
  assert.ok(selected.health.every(row => row.id !== 'palette'));
  expectFit(scores(ballots, { category: '静态网页' }), 'aesthetic', weighted(web, 0.5));
  expectFit(scores(ballots), 'aesthetic', weighted(ballots, Math.sqrt(20 / 100)));
});

test('configurations share underlying-model volume and use the larger side in either orientation', () => {
  // A has 80 comparisons across four configurations; each opponent has only 20.
  const ballots = ['b', 'c', 'd', 'e'].flatMap((opponent, i) => votes(20, i % 2
    ? { a: work(opponent), b: work('a', String(i)), aspectChoice: 'b' }
    : { a: work('a', String(i)), b: work(opponent) }));
  expectFit(scores(ballots, { voterModelKey: modelKey }, configKey),
    'aesthetic', weighted(ballots, 0.5), configKey);
  expectFit(scores(ballots), 'aesthetic', weighted(ballots, 0.5));
  // Without the override, voterModelKey defaults to the selected entry key.
  expectFit(scores(ballots, {}, configKey), 'aesthetic', weighted(ballots), configKey);
});

test('two configurations of the same model increment that model once per comparison', () => {
  const ballots = votes(80, { a: work('a', 'low'), b: work('a', 'high') });
  expectFit(scores(ballots, { voterModelKey: modelKey }, configKey),
    'aesthetic', weighted(ballots, 0.5), configKey); // N = 80, not 160.
  assert.equal(scores(ballots).totals.answered, 0);
});

test('unanswered, unknown and same-entry comparisons do not inflate volume', () => {
  const valid = votes(20);
  const ignored = [
    ...votes(80, { aspectChoice: null }),
    ...votes(80, { aspectId: 'unknown-aspect' }),
    ...votes(80, { b: { ...A, id: 'another-work-of-a' } }),
  ];
  const result = scores([...ignored, ...valid]);
  expectFit(result, 'aesthetic', weighted(valid));
  assert.deepEqual(result.boards.aesthetic, scores(valid).boards.aesthetic);
  assert.equal(result.totals.answered, 20);
  assert.equal(result.totals.pairs, 100);
});

for (const [label, userId] of [['null', null], ['missing', undefined]]) {
  test(`historical ${label} user IDs do not collapse into a shared voter`, () => {
    const known = votes(80);
    const historical = votes(80, { userId, aspectChoice: 'b' });
    const result = scores([...known, ...historical], { fullWeightUserId: BASIS_ID });
    expectFit(result, 'aesthetic', [...weighted(known, 0.5), ...weighted(historical)]);
    assert.equal(result.totals.voters, 1);
    assert.equal(result.totals.answered, 160);
  });
}

test('base weight stays one: neither timestamps nor public identity multipliers affect fits', () => {
  const old = votes(80, { createdAt: Date.parse('2018-01-01T00:00:00Z'), publicWeight: 1.25 });
  const other = votes(12, { userId: 'other', aspectChoice: 'b', publicWeight: 0.5 });
  const ballots = [...old, ...other];
  const result = scores(ballots);
  expectFit(result, 'aesthetic', [...weighted(old, 0.5), ...weighted(other)]);
  const refreshed = scores(ballots.map(vote => ({ ...vote, createdAt: NOW })));
  assert.deepEqual(result.boards, refreshed.boards);
  assert.deepEqual(result.health, refreshed.health);
  assert.notEqual(result.totals.since, refreshed.totals.since);
});

test('ties count toward volume; weighting preserves raw tallies, thin status and health', () => {
  const answered = [...votes(60), ...votes(10, { aspectChoice: 'b' }), ...votes(10, { aspectChoice: 'tie' })];
  const ballots = [...answered, ...votes(5, { aspectChoice: null })];
  const result = scores(ballots);
  expectFit(result, 'aesthetic', weighted(answered, 0.5));
  const raw = trialStandings(ballots, modelKey, describe);
  const entries = result.entries.map(({ prior, dimensions, ...row }) => ({ ...row,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([id, { score, interval, thin, ...cell }]) => [id, cell])),
  }));
  assert.deepEqual(entries, raw.entries);
  assert.deepEqual(result.totals, raw.totals);
  assert.deepEqual(result.entries.find(row => row.key === 'a').dimensions.aesthetic.aspects.lighting,
    { win: 60, tie: 10, loss: 10, n: 80 });
  assert.deepEqual(result.health, scores(ballots, { fullWeightUserId: 'frequent' }).health);
  const { pairs, n, skipped, skipRate, tieRate, sameSideN, sameSideRate } = result.health.find(row => row.id === 'lighting');
  assert.deepEqual([pairs, n, skipped, skipRate, tieRate, sameSideN, sameSideRate],
    [85, 80, 5, 5 / 85, 10 / 80, 70, 60 / 70]);
});
