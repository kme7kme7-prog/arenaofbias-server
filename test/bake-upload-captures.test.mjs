import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareCaptureJob, previewManifest } from '../scripts/bake-upload-captures.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('capture baker binds a screenshot manifest to exact public entry and JPEG bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'upload-captures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'sources');
  const captureRoot = join(root, 'captures');
  const id = 'up-abcdefgh';
  const sourceBytes = Buffer.from('<html>verified source</html>');
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  mkdirSync(join(sourceRoot, id), { recursive: true });
  mkdirSync(join(captureRoot, id), { recursive: true });
  writeFileSync(join(sourceRoot, id, 'source.html'), sourceBytes);
  writeFileSync(join(captureRoot, id, 'first.jpg'), jpegBytes);
  const bootstrap = { works: [{ id, task: 'sample-task', status: 'verified',
    scene: 'https://w' + 'a'.repeat(32) + '.w.arenaofbias.icu/' }] };

  const job = prepareCaptureJob({ id, bootstrap, sourceRoot, captureRoot });
  assert.equal(job.sourceRelative, join(id, 'source.html'));
  assert.equal(job.captureRelative, join(id, 'first.jpg'));
  assert.equal(job.sourceDigest, sha256(sourceBytes));
  assert.equal(job.originalCaptureSha, sha256(jpegBytes));
  const outputBytes = Buffer.from([0xff, 0xd8, 0x10, 0xff, 0xd9]);
  assert.deepEqual(previewManifest(job.sourceDigest, outputBytes), {
    schemaVersion: 1, sourceDigest: sha256(sourceBytes), mode: 'screenshot',
    capture: 'preview.jpg', captureSha: sha256(outputBytes),
  });

  assert.throws(() => prepareCaptureJob({ id, sourceRoot, captureRoot,
    bootstrap: { works: [{ ...bootstrap.works[0], scene: 'https://example.com/' }] } }), /non-public/);
});
