import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildShow1Boards, replayShow1Ratings } from '../server/show1-ranking.mjs';

const prompts = [
  { id: 'web', kind: 'web', weights: [1, 0, 0, 0, 0, 0] },
  { id: 'text', kind: 'text', weights: [0, 0, 0, 1, 0, 0] },
];
const works = ['a', 'b', 'c'].flatMap((modelId) => prompts.map((prompt) => ({
  modelId, modelName: modelId.toUpperCase(), promptId: prompt.id, isDemo: 0,
})));
const vote = (winnerMid, loserMid, extra = {}) => ({ promptId: 'web', winnerMid, loserMid, outcome: 'win', ...extra });

test('Elo matches hand-calculated wins and draws and conserves total strength', () => {
  const votes = [vote('a', 'b'), vote('b', 'c'), vote('a', 'c', { outcome: 'draw' })];
  const { ratings, games } = replayShow1Ratings(votes);
  assert.deepEqual(ratings, { a: 1214.4968829087939, b: 1200.736306793522, c: 1184.766810297684 });
  assert.deepEqual(games, { a: 2, b: 2, c: 2 });
  assert.equal(Object.values(ratings).reduce((sum, value) => sum + value, 0), 3600);
  const { board } = buildShow1Boards(votes, works, prompts).all;
  assert.deepEqual(board.rows.map((row) => row.rating), [1214, 1201, 1185]);
  assert.equal(board.rows.reduce((sum, row) => sum + row.games, 0), votes.length * 2);
  for (const row of board.rows) assert.equal(row.games, row.wins + row.losses + row.draws);
});

test('radar uses saved weights, leaves zero-weight dimensions unchanged and separates categories', () => {
  const votes = [vote('a', 'b', { promptWeights: [0, 1, 0, 0, 0, 0] }),
    vote('b', 'a', { promptId: 'text' })];
  const boards = buildShow1Boards(votes, works, prompts);
  assert.deepEqual(boards.web.radar.profiles.a, [50, 54, 50, 50, 50, 50]);
  assert.deepEqual(boards.text.radar.profiles.a, [50, 50, 50, 46, 50, 50]);
  assert.deepEqual(boards.all.radar.average, Array(6).fill(50));
  assert.equal(boards.all.board.totalVotes, 2);
  assert.equal(boards.web.scopedPromptCount, 1);
  assert.equal(boards.text.board.totalVotes, 1);
  const fallback = buildShow1Boards([vote('a', 'b', { promptId: 'retired', promptKind: 'web' })], works, prompts);
  assert.equal(fallback.web.board.totalVotes, 1, 'retired prompts use their saved category');
  assert.ok(fallback.web.radar.profiles.a.every((value) => Math.abs(value - (50 + 4 / 6)) < 1e-12));
});

test('single-topic entries wait for coverage while retired entries and family names remain defined', () => {
  const roster = [{ modelId: 'a', modelName: 'A', promptId: 'web' },
    { modelId: 'claude-fable-5.x', modelName: 'Claude Fable 5.1', promptId: 'web' },
    { modelId: 'claude-fable-5.x', modelName: 'Claude Fable 5.1', promptId: 'text' }];
  const votes = [vote('a', 'claude-fable-5.x'), vote('retired', 'a', { winnerName: 'Retired Model' })];
  const rows = buildShow1Boards(votes, roster, prompts).all.board.rows;
  assert.equal(rows.some((row) => row.modelId === 'a'), false);
  assert.equal(rows.find((row) => row.modelId === 'retired').retired, true);
  assert.equal(rows.find((row) => row.modelId === 'claude-fable-5.x').name, 'Claude Fable 5.x');
  assert.ok(buildShow1Boards(votes, [...roster, { modelId: 'a', modelName: 'A', promptId: 'text' }], prompts)
    .all.board.rows.some((row) => row.modelId === 'a'));
  const empty = buildShow1Boards([], roster, prompts).all;
  assert.deepEqual(empty.board.rows, []);
  assert.deepEqual(empty.radar.profiles, {});
  assert.deepEqual(empty.radar.average, Array(6).fill(50));
});
