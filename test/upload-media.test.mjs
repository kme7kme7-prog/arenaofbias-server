import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMediaJobs } from '../scripts/bake-upload-media.mjs';

test('media recipes select the exact task and preserve explicit screenshot fallback', () => {
  const bootstrap = { works: [
    { id: 'up-a1234567', task: 'island', status: 'verified', scene: 'https://example.com/' },
    { id: 'up-b1234567', task: 'plane', status: 'verified', scene: 'https://example.com/' },
    { id: 'up-c1234567', task: 'island', status: 'pending', scene: 'https://example.com/' },
  ] };
  assert.deepEqual(selectMediaJobs(bootstrap, ['up-a1234567', 'up-b1234567'], {
    'island/up-a1234567': { previewMode: 'screenshot' },
    'island/up-b1234567': { previewMode: 'screenshot' },
  }), [
    { id: 'up-a1234567', task: 'island', mode: 'screenshot' },
    { id: 'up-b1234567', task: 'plane', mode: 'model' },
  ]);
  assert.throws(() => selectMediaJobs(bootstrap, ['up-c1234567']), /No verified public work/);
});
