import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptTesseraCamera, tesseraDocument, adaptTesseraDocument } from '../server/tessera-camera.mjs';

test('Tessera camera adaptation rejects unknown revisions without rewriting other documents', () => {
  assert.equal(adaptTesseraCamera(Buffer.from('this.controls.minDistance=1')), null);
  const other = Buffer.from('<title>键盘</title><script src="other.js"></script>');
  assert.equal(tesseraDocument(other), false);
  assert.deepEqual(adaptTesseraDocument(other), other);
  const known = Buffer.from('<title>键盘</title><script src="./assets/index-DDOgn9oK.js"></script>');
  assert.ok(tesseraDocument(known));
  assert.equal(adaptTesseraDocument(known).toString(), '<title>键盘</title><script src="/__aob_tessera_camera.mjs"></script>');
});
