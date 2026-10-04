import { createHash } from 'node:crypto';

export const TESSERA_ASSET = '/assets/index-DDOgn9oK.js';
export const TESSERA_CAMERA_PATH = '/__aob_tessera_camera.mjs';
const HASH = 'fd378f3fda7bfd95211c523f9b4cba1de5d73027b0a7a904cd145f5bf5d0d75b';

// Hidden page chrome must not reserve camera space in a scene-only preview.
// This is deliberately pinned to the reviewed bundle, not a general minified-JS rewrite.
export function adaptTesseraCamera(buffer) {
  if (createHash('sha256').update(buffer).digest('hex') !== HASH) return null;
  const replacements = [
    ['setInsetsProvider(e){this.insetsProvider=e,this.resize()}',
      'setInsetsProvider(e){this.insetsProvider=()=>({top:0,right:0,bottom:0,left:0}),this.resize()}'],
    ['this.controls.minDistance=this.baseRadius*.42*this.applied.scale,this.controls.maxDistance=this.baseRadius*1.9*this.applied.scale',
      'this.controls.minDistance=this.baseRadius*.08*this.applied.scale,this.controls.maxDistance=this.baseRadius*10*this.applied.scale'],
    ['e.playIntro(),t.ripple(performance.now(),1100)',
      'e.userMoved=!!(window.__AOB__&&window.__AOB__.saved),e.tween=null,window.__AOB__&&window.__AOB__.register(e.controls),t.ripple(performance.now(),1100)'],
  ];
  let source = buffer.toString('utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) return null;
    source = source.replace(before, after);
  }
  return Buffer.from(source);
}

export function tesseraDocument(buffer) {
  return buffer.toString('latin1').includes('src="./assets/index-DDOgn9oK.js"');
}

export function adaptTesseraDocument(buffer) {
  return Buffer.from(buffer.toString('latin1').replace('src="./assets/index-DDOgn9oK.js"',
    `src="${TESSERA_CAMERA_PATH}"`), 'latin1');
}
