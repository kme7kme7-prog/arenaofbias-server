import assert from 'node:assert/strict';
import test from 'node:test';
import { startLeaderboardWarmup, WARM_BOARDS } from '../server/leaderboard-warmup.mjs';
import { LEADERBOARD_INTERVAL_MS } from '../server/leaderboard-cache.mjs';

test('warmup is serial, retries on the next cadence and closes without leaving a timer', async () => {
  const timers = [], calls = [], errors = [];
  let active = 0, max = 0;
  const worker = startLeaderboardWarmup({
    schedule: (run, delay) => { const timer = { run, delay }; timers.push(timer); return timer; },
    cancel: (timer) => { timers.splice(timers.indexOf(timer), 1); },
    onError: () => errors.push('failed'),
    read: async (options) => {
      active++; max = Math.max(max, active); calls.push(options);
      await Promise.resolve(); active--;
      if (calls.length === 2) throw new Error('fit failure');
    },
  });
  assert.equal(timers[0].delay, 0);
  await timers.shift().run();
  assert.equal(max, 1);
  assert.deepEqual(calls, WARM_BOARDS);
  assert.deepEqual(errors, ['failed']);
  assert.equal(timers[0].delay, LEADERBOARD_INTERVAL_MS);
  await worker.close();
  assert.equal(timers.length, 0);
});

test('close waits for the active fit and never starts the remaining boards', async () => {
  let run, finish, calls = 0, stopped = false;
  const worker = startLeaderboardWarmup({ schedule: (next) => { run = next; return {}; }, cancel: () => {},
    read: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const pending = run();
  const closing = worker.close().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish(); await pending; await closing;
  assert.equal(calls, 1);
  assert.equal(stopped, true);
});
