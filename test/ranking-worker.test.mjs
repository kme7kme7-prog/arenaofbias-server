import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { rankEntries, rankWorks } from '../server/ranking.mjs';

test('worker ranking preserves Bradley–Terry scores and intervals', async () => {
  const work = (key) => ({ taskId: 'one', configKey: key, modelKey: key, modelId: key, modelName: key, effort: '' });
  const entries = ['a', 'b', 'c', 'd'].map(work);
  const votes = Array.from({ length: 600 }, (_, i) => ({ a: entries[i % 4], b: entries[(i + 1) % 4],
    choice: i % 3 === 0 ? 'tie' : i % 3 === 1 ? 'a' : 'b', userId: `u${i}` }));
  const limits = { provisionalGames: 30 };
  const expected = rankEntries(votes, (entry) => entry.configKey, limits);
  const worker = new Worker(new URL('../server/ranking-worker.mjs', import.meta.url), { workerData: { votes, by: 'config', limits } });
  const exit = once(worker, 'exit');
  const [actual] = await once(worker, 'message');
  assert.deepEqual(actual, expected);
  assert.equal((await exit)[0], 0);
});

test('worker computes the same hierarchical work scores above the entry threshold', async () => {
  const works = Array.from({ length: 205 }, (_, i) => ({ id: `w${i}`, configKey: `config${i % 3}` }));
  const votes = works.map((work, i) => ({ a: work, b: works[(i + 1) % works.length], choice: i % 3 ? 'a' : 'tie' }));
  const expected = rankWorks(votes, (work) => work.configKey);
  const worker = new Worker(new URL('../server/ranking-worker.mjs', import.meta.url), { workerData: { votes, by: 'work' } });
  const exit = once(worker, 'exit');
  const [actual] = await once(worker, 'message');
  assert.deepEqual(actual, expected);
  assert.equal((await exit)[0], 0);
});
