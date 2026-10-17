import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeaderboardCache, LEADERBOARD_INTERVAL_MS } from '../server/leaderboard-cache.mjs';

test('public boards share pending work and retain new votes until the ten-minute boundary', async () => {
  let now = 0, votes = 1, calls = 0, finish;
  const cache = createLeaderboardCache({ now: () => now });
  const calculate = async () => {
    calls++;
    if (calls === 1) await new Promise((resolve) => { finish = resolve; });
    return { totals: { votes }, updatedAt: new Date(now).toISOString() };
  };
  const first = cache.get('all/config', calculate);
  assert.strictEqual(cache.get('all/config', calculate), first);
  await Promise.resolve(); finish();
  const initial = await first;
  assert.equal(calls, 1);
  assert.equal(initial.refreshIntervalSeconds, 600);
  assert.equal(Date.parse(initial.nextUpdateAt), LEADERBOARD_INTERVAL_MS);
  votes = 2;
  now = LEADERBOARD_INTERVAL_MS - 1;
  assert.strictEqual(cache.get('all/config', calculate), first);
  assert.equal((await first).totals.votes, 1);
  now++;
  const refreshed = await cache.get('all/config', calculate);
  assert.equal(refreshed.totals.votes, 2);
  assert.equal(calls, 2);
  assert.equal(Date.parse(refreshed.nextUpdateAt), now + LEADERBOARD_INTERVAL_MS);
  assert.notStrictEqual(await cache.get('frontend/model', calculate), refreshed, 'scopes have separate snapshots');
});

test('a failed fit can retry and moderation invalidation cannot resurrect an older pending board', async () => {
  const cache = createLeaderboardCache({ now: () => 0 });
  await assert.rejects(cache.get('one', () => { throw new Error('fit failed'); }), /fit failed/);
  assert.equal((await cache.get('one', () => ({ rows: ['retry'] }))).rows[0], 'retry');
  let finish;
  const old = cache.get('other', () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  const current = cache.get('other', () => ({ rows: ['after moderation'] }));
  await current;
  finish({ rows: ['old'] }); await old;
  assert.strictEqual(cache.get('other', () => { assert.fail('current snapshot must be retained'); }), current);
});
