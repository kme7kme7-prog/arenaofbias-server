import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSharedRead } from '../server/shared-read.mjs';

test('public reads share pending work, expire, and never publish a revision withdrawn during a build', async () => {
  let revision = 0, now = 0, builds = 0, finish;
  const read = createSharedRead({ revision: () => revision, now: () => now,
    read: () => { builds++; return new Promise(resolve => { finish = resolve; }); } });
  const a = read(), b = read();
  await Promise.resolve(); assert.equal(builds, 1);
  revision++; finish('withdrawn');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(builds, 2);
  finish('current');
  assert.deepEqual(await Promise.all([a, b]), ['current', 'current']);
  assert.equal(await read(), 'current'); assert.equal(builds, 2);
  now = 5000;
  const expired = read(); await Promise.resolve(); assert.equal(builds, 3);
  finish('renewed'); assert.equal(await expired, 'renewed');
});

test('a failed public read can be retried and is not reused', async () => {
  let calls = 0;
  const read = createSharedRead({ revision: () => 1, read: async () => {
    if (++calls === 1) throw new Error('temporary');
    return 'recovered';
  } });
  await assert.rejects(read(), /temporary/);
  assert.equal(await read(), 'recovered'); assert.equal(calls, 2);
});
