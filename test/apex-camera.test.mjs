import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptApexCamera, apexDocument, adaptApexDocument } from '../server/apex-camera.mjs';

test('APEX adapter refuses unknown or revised bundles', () => {
  for (const source of ['', 'this.controls.maxDistance=220', 'this.controls.minDistance=50,this.controls.maxDistance=220,this.controls.maxPolarAngle=Math.PI/2.1,this.controls.target.set(0,15,0),this.controls.update()']) {
    assert.equal(adaptApexCamera(Buffer.from(source)), null);
  }
});

test('APEX document adapter preserves other assets and non-ASCII bytes', () => {
  const original = Buffer.from('<title>键盘</title><script src="./assets/index-KBcdZwxF.js"></script><script src="other.js"></script>');
  assert.ok(apexDocument(original));
  assert.equal(adaptApexDocument(original).toString(), '<title>键盘</title><script src="/__aob_apex_camera.mjs"></script><script src="other.js"></script>');
  const other = Buffer.from('<script src="other.js"></script>');
  assert.equal(apexDocument(other), false);
  assert.deepEqual(adaptApexDocument(other), other);
});
