import { createHash } from 'node:crypto';

// This bundle embeds OrbitControls, so importmap hooks cannot reach its camera.
// Pin the exact bundle; a future work revision must be reviewed before adapting it.
export const APEX_ASSET = '/assets/index-KBcdZwxF.js';
export const APEX_CAMERA_PATH = '/__aob_apex_camera.mjs';
const HASH = 'e640a0abf0c464482ae0dfe19cf9982ad96251e37038b846a4d0983dfcfbb50c';
const INIT = 'this.controls.minDistance=50,this.controls.maxDistance=220,this.controls.maxPolarAngle=Math.PI/2.1,this.controls.target.set(0,15,0),this.controls.update()';

export function adaptApexCamera(buffer) {
  if (createHash('sha256').update(buffer).digest('hex') !== HASH) return null;
  const source = buffer.toString('utf8');
  if (!source.includes(INIT)) return null;
  return Buffer.from(source.replace(INIT,
    INIT.replace('maxDistance=220,', 'maxDistance=2200,')
    + ',window.__AOB__&&window.__AOB__.register(this.controls)'));
}

export function apexDocument(buffer) {
  return buffer.toString('latin1').includes('src="./assets/index-KBcdZwxF.js"');
}

export function adaptApexDocument(buffer) {
  return Buffer.from(buffer.toString('latin1').replace('src="./assets/index-KBcdZwxF.js"',
    `src="${APEX_CAMERA_PATH}"`), 'latin1');
}
