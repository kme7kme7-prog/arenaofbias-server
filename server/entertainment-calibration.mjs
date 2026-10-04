import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validCamera } from './bridge.mjs';

const profiles = JSON.parse(readFileSync(new URL('./entertainment-calibration.json', import.meta.url), 'utf8'));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
export function entertainmentProfile(work) {
  return work && profiles.works[`${work.taskId}/${work.id}`] || null;
}
export function entertainmentCamera(work, buffer) {
  if (!buffer || !entertainmentMatches(buffer, work)) return null;
  const camera = entertainmentProfile(work)?.camera;
  return validCamera(camera) ? camera : null;
}
export function entertainmentMatches(buffer, work) {
  return hash(buffer) === entertainmentProfile(work)?.entrySha256;
}
function instrument(body) {
  const register = ',queueMicrotask(()=>window.__AOB__&&window.__AOB__.register(this))';
  return body.replace(/this\.minDistance\s*=\s*0\s*,\s*this\.maxDistance\s*=\s*(?:1\s*\/\s*0|Infinity)(?=\s*[,;])/g, match => match + register)
    .replace(/([\w$]+)\(this,["']minDistance["'],0\),\1\(this,["']maxDistance["'],(?:1\/0|Infinity)\)/g, match => match + register)
    .replace(/(?<![\w$.#])([\w$]+(?:\.[\w$]+)*)\.render\(\s*([\w$]+(?:\.[\w$]+)*)\s*,\s*([\w$]+(?:\.[\w$]+)*)\s*\)/g,
      (match, renderer, scene, camera) => '(' + camera + '?.isCamera&&window.__AOB__?.prepareCamera?.(' + camera + '),' + match + ')');
}
function adaptScript(body, adapter) {
  if (adapter === 'seed-orbit') {
    const orbit = 'Wt.position.x=Math.cos(i)*55,Wt.position.z=Math.sin(i)*55,Wt.position.y=40,Wt.lookAt(0,5,0)';
    body = body.replace(orbit, 'window.__AOB__?.saved||(' + orbit + ')');
  }
  if (adapter === 'dots-orbit') body = body.replace('Io&&(', 'Io&&!window.__AOB__?.saved&&(');
  if (adapter === 'muse-spherical') body += ';queueMicrotask(()=>window.__AOB__?.register({object:ui,target:Ft,update(){di=false;const x=ui.position.x-Ft.x,z=ui.position.z-Ft.z,y=ui.position.y;fi=Math.hypot(x,y,z);_n=Math.atan2(x,z);hi=Math.asin(y/fi);Fn()}}));';
  if (adapter === 'luna-spherical') body += ';queueMicrotask(()=>window.__AOB__?.register({object:Qi,target:Bt.target,update(){const d=Qi.position.clone().sub(Bt.target),r=d.length();Bt.distance=Bt.targetDistance=r;Bt.yaw=Bt.targetYaw=Math.atan2(d.x,d.z);Bt.pitch=Bt.targetPitch=Math.asin(d.y/r);Kc(true)}}));';
  return body;
}
export function entertainmentOptions(work, buffer) {
  const profile = entertainmentProfile(work);
  if (!buffer || !entertainmentMatches(buffer, work)) return null;
  return profile?.fov >= 20 && profile.fov <= 100 ? { fov: profile.fov } : true;
}
export function entertainmentDocument(buffer, work, pathname = '/', profile = entertainmentProfile(work)) {
  if (!profile || hash(buffer) !== profile.entrySha256) return buffer;
  // Keep module URLs in their original directory so relative imports still resolve.
  let body = buffer.toString('latin1').replace(/(<script\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi, (match, start, src, end) => {
    const url = new URL(src, `http://work.local${pathname}`);
    if (url.origin !== 'http://work.local' || !profile.modules.some(module => module.path === url.pathname)) return match;
    url.searchParams.append('aob', 'entertainment-camera');
    return start + url.pathname + url.search + url.hash + end;
  });
  body = body.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (match, start, source, end) =>
    /\bsrc\s*=/.test(start) ? match : start + instrument(source) + end);
  return Buffer.from(body, 'latin1');
}
export function entertainmentModule(buffer, work, pathname, profile = entertainmentProfile(work)) {
  const module = profile?.modules.find(item => item.path === pathname);
  if (!module || hash(buffer) !== module.sha256) return null;
  let body = adaptScript(instrument(buffer.toString('latin1')), profile.adapter);
  // Embedded OrbitControls constructors initialise these two documented fields.
  // Registration runs after the module completes its own setup, not halfway through it.
  const flagged = src => src + (src.includes('?') ? '&' : '?') + 'aob=entertainment-camera';
  body = body.replace(/((?:from|import)\s*["'])(\.{1,2}\/[^"']+\.m?js)(["'])/g, (_, start, src, end) => start + flagged(src) + end)
    .replace(/(import\(\s*["'])(\.{1,2}\/[^"']+\.m?js)(["'])/g, (_, start, src, end) => start + flagged(src) + end);
  return Buffer.from(body, 'latin1');
}
