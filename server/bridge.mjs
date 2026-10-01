// The camera bridge, ported from the pre-fusion arena server (Show1 decision 102). The
// content server injects it into work HTML at serve time; source files stay untouched.
// The bridge registers a work's OrbitControls instances on window.__AOB__ so an admin
// preview can capture the current camera, and re-applies a saved camera when the arena
// loads the same work. Two hook paths:
//  1. Global UMD three (three.min.js + examples/js OrbitControls): defineProperty
//     intercepts the window.THREE assignment, then the OrbitControls mount, wrapping
//     the constructor so every instance registers itself.
//  2. Importmap ESM (three / three/addons/ pointing at a CDN or the work's own copy):
//     the importmap is rewritten so OrbitControls.js goes through our forwarding
//     module. Relative targets are resolved against the document URL first. The
//     forwarder re-exports both named exports and the default (lil-gui is default-only).
// The pre-fusion server read the controls through the same-origin iframe window; works
// now live on their own content host, so capture mode answers a postMessage handshake
// instead: {aob:'get-camera'} -> {aob:'camera', camera} back to the asking origin.

const VIRTUAL = '/__aob__';

// Ready probe (Show1 decision 096): wait for window load, three rendered frames, then a
// 600ms settle before reporting aob:work-ready; 8s fallback so a broken work cannot hang
// the arena transition. The arena frontend still listens for this exact message.
const PROBE_JS = `(function(){
var posted=false;
function post(){if(posted)return;posted=true;try{parent.postMessage('aob:work-ready','*');}catch(e){}}
function arm(){
  var frames=0;
  function tick(){frames+=1;if(frames>=3)setTimeout(post,600);else requestAnimationFrame(tick);}
  requestAnimationFrame(tick);
}
if(document.readyState==='complete')arm();
else window.addEventListener('load',arm);
setTimeout(post,8000);
})();`;

// Classic script injected at the top of <head>, ahead of every work script. __AOB_SAVED__
// and __AOB_CAPTURE__ (both optional) must be in place before this runtime executes.
const BRIDGE_JS = `(function(){
var A=window.__AOB__={controls:[],three:null,saved:window.__AOB_SAVED__||null};
function wrap(Base){
  if(typeof Base!=='function'||Base.__aobWrapped)return Base;
  var W;
  try{W=class extends Base{constructor(){super(...arguments);try{A.register(this);}catch(e){}}};}
  catch(e){
    try{W=function(){Base.apply(this,arguments);try{A.register(this);}catch(e2){}};W.prototype=Base.prototype;}
    catch(e2){return Base;}
  }
  try{Object.defineProperty(W,'__aobWrapped',{value:true});}catch(e3){}
  return W;
}
A.wrap=wrap;
function setVec(v,a){if(v&&a&&a.length===3){v.x=a[0];v.y=a[1];v.z=a[2];}}
A.register=function(c){if(c&&c.object){A.controls.push(c);A.apply(c);}};
A.apply=function(c){
  var s=A.saved;if(!s||!c||!c.object)return;
  try{
    setVec(c.object.position,s.position);
    if(c.target)setVec(c.target,s.target);
    if(typeof c.update==='function')c.update();
  }catch(e){}
};
A.getState=function(){
  var c=A.controls[A.controls.length-1];if(!c||!c.object)return null;
  var p=c.object.position,t=c.target||{x:0,y:0,z:0};
  return {position:[p.x,p.y,p.z],target:[t.x,t.y,t.z]};
};
A.setState=function(s){A.saved=s;for(var i=0;i<A.controls.length;i++)A.apply(A.controls[i]);};
function applyAll(){for(var i=0;i<A.controls.length;i++)A.apply(A.controls[i]);}
if(A.saved)[50,150,400,900,1600].forEach(function(d){setTimeout(applyAll,d);});
if(window.__AOB_CAPTURE__){
  addEventListener('message',function(e){
    var d=e.data;
    if(d&&d.aob==='get-camera'&&e.source){
      var camera=null;
      try{camera=A.getState();}catch(x){}
      try{e.source.postMessage({aob:'camera',camera:camera},e.origin);}catch(x2){}
    }
  });
}
var real;
try{
  Object.defineProperty(window,'THREE',{
    configurable:true,
    get:function(){return real;},
    set:function(v){
      real=v;A.three=v;
      try{
        var inner=v.OrbitControls,wrapped=wrap(inner);
        Object.defineProperty(v,'OrbitControls',{
          configurable:true,
          get:function(){return wrapped;},
          set:function(C){inner=C;wrapped=wrap(C);}
        });
      }catch(e){}
    }
  });
}catch(e){}
})();`;

/** The ready-probe tag; idempotent like the original (an existing probe is not re-added). */
export function probeTag() {
  return `<script data-aob-probe>${PROBE_JS}</script>`;
}

/**
 * Head tags for the bridge. `camera` is embedded before the runtime so it is read into
 * A.saved during initialisation; `capture` enables the postMessage handshake. Order
 * matters and is fixed here.
 */
export function bridgeTags(camera, capture = false) {
  return `${camera ? `<script>window.__AOB_SAVED__=${JSON.stringify(camera)}</script>` : ''
  }${capture ? '<script>window.__AOB_CAPTURE__=true</script>' : ''
  }<script>${BRIDGE_JS}</script>`;
}

/**
 * Forwarding modules for the virtual route. Named exports go through `export *`; the
 * default export through the namespace's `.default`. Both are required: `export *`
 * excludes default by spec, and lil-gui-like addons are default-only — missing it
 * crashes works before the camera is even created. When the original module has no
 * default, `.default` is undefined instead of a link-time error.
 */
function forward(origUrl) {
  return `export * from ${JSON.stringify(origUrl)};
import * as __AOB_NS from ${JSON.stringify(origUrl)};
export default __AOB_NS.default;
`;
}

/** The OrbitControls wrapper: the local export shadows the `export *` namesake. */
function addonControlsShim(origUrl) {
  return `import { OrbitControls as __Base } from ${JSON.stringify(origUrl)};
${forward(origUrl)}const OrbitControls = window.__AOB__ ? window.__AOB__.wrap(__Base) : __Base;
export { OrbitControls };
`;
}

/** Every other addon / the three entry: plain forward (module instances dedupe by URL). */
function passthroughShim(origUrl, exposeThree) {
  return `${forward(origUrl)}${exposeThree ? `import * as __T from ${JSON.stringify(origUrl)};\nif (window.__AOB__) window.__AOB__.three = __T;\n` : ''}`;
}

const IMPORTMAP_RE = /<script[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/i;

// Importmap targets are either CDN absolute URLs or relative paths inside the work
// directory; relative values resolve against the document URL into same-host paths.
function resolveTarget(docPathname, value) {
  if (/^https?:/i.test(value)) return value;
  try {
    return new URL(value, `http://work.local${docPathname || '/'}`).pathname;
  } catch {
    return null;
  }
}

/** Point an absolute target at the virtual route; directories keep prefix semantics. */
function virtualFor(abs) {
  if (abs.endsWith('/')) return `${VIRTUAL}/ad/${encodeURIComponent(abs)}/`;
  const slash = abs.lastIndexOf('/');
  return `${VIRTUAL}/ad/${encodeURIComponent(abs.slice(0, slash))}/${abs.slice(slash + 1)}`;
}

/**
 * Rewrite the importmap of a work document (latin1 domain: the inserted markup is plain
 * ASCII, so any page encoding survives byte-for-byte). Only rewritable targets move:
 * https CDN URLs and paths on the work's own host. Anything else (data:, protocol
 * relative, off-host) is left alone — better an unhooked work than a broken one. A
 * malformed importmap only skips the rewrite.
 */
export function rewriteImportmap(buffer, docPathname) {
  const html = buffer.toString('latin1');
  const out = html.replace(IMPORTMAP_RE, (match, json) => {
    try {
      const map = JSON.parse(json);
      const imports = map && map.imports;
      if (!imports || typeof imports !== 'object') return match;
      let touched = false;
      // The addons prefix, plus exact keys that hardcode one OrbitControls.js.
      for (const key of Object.keys(imports)) {
        const isPrefix = key === 'three/addons/';
        const isExact = key.endsWith('/OrbitControls.js');
        if (!isPrefix && !isExact) continue;
        const value = imports[key];
        if (typeof value !== 'string') continue;
        const abs = resolveTarget(docPathname, value);
        const own = abs && abs.startsWith('/') && !abs.startsWith('//') && !abs.startsWith(`${VIRTUAL}/`);
        if (!abs || (!/^https:\/\//i.test(abs) && !own)) continue;
        imports[key] = virtualFor(abs);
        touched = true;
      }
      if (typeof imports.three === 'string' && /^https:/.test(imports.three)) {
        imports.three = `${VIRTUAL}/three.mjs?u=${encodeURIComponent(imports.three)}`;
        touched = true;
      }
      return touched
        ? `<script type="importmap">${JSON.stringify(map)}</script>`
        : match;
    } catch {
      return match;
    }
  });
  return Buffer.from(out, 'latin1');
}

/**
 * Serve the bridge's virtual modules. Returns null for non-virtual paths, a body for a
 * valid virtual request, or {error} to reject one. Base targets must be https CDN URLs
 * or own-host paths; path traversal and the virtual prefix itself are refused.
 */
export function serveBridgeVirtual(pathname, searchParams) {
  if (!pathname.startsWith(`${VIRTUAL}/`)) return null;
  const rel = pathname.slice(VIRTUAL.length + 1);
  if (rel.startsWith('three.mjs')) {
    const u = String(searchParams.get('u') ?? '');
    if (!u.startsWith('https://')) return { error: 400 };
    return { body: passthroughShim(u, true) };
  }
  if (rel.startsWith('ad/')) {
    const rest = rel.slice('ad/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return { error: 400 };
    let base;
    try {
      base = decodeURIComponent(rest.slice(0, slash));
    } catch {
      return { error: 400 };
    }
    const sub = rest.slice(slash + 1);
    const own = base.startsWith('/') && !base.startsWith('//') && !base.startsWith(`${VIRTUAL}/`);
    if ((!base.startsWith('https://') && !own)
      || base.includes('..') || base.includes('\\')
      || !/^[\w.@/-]+$/.test(sub) || sub.includes('..')) return { error: 400 };
    const orig = (base.endsWith('/') ? base : `${base}/`) + sub;
    const shim = /(^|\/)OrbitControls\.js$/.test(sub)
      ? addonControlsShim(orig)
      : passthroughShim(orig, false);
    return { body: shim };
  }
  return { error: 404 };
}

/** Camera shape accepted for embedding: position/target are three finite numbers each. */
export function validCamera(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'position' || keys[1] !== 'target') return false;
  const vec = (v) => Array.isArray(v) && v.length === 3
    && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7);
  return vec(value.position) && vec(value.target);
}
