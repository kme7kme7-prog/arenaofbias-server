import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { entertainmentProbeTag } from '../server/work-ready.mjs';
import { probeTag } from '../server/bridge.mjs';

function probe(scene, overlay = false) {
  const events = [], frames = [], listeners = {};
  let busy = overlay;
  function GL() {}
  GL.prototype.drawArrays = function() { return 7; };
  const node = { id: 'loader', className: 'loading-screen',
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 800, height: 500 }) };
  const document = { readyState: 'loading',
    addEventListener: (name, callback) => { listeners[name] = callback; },
    querySelectorAll: () => [node], querySelector: () => scene ? {} : null };
  const window = { WebGLRenderingContext: GL };
  const context = { window, document, innerWidth: 800, innerHeight: 500,
    parent: { postMessage: data => events.push(data) },
    requestAnimationFrame: cb => frames.push(cb),
    setTimeout: cb => frames.push(cb),
    getComputedStyle: () => ({ display: busy ? 'block' : 'none', visibility: 'visible', opacity: '1', position: 'fixed' }) };
  const body = entertainmentProbeTag(scene).replace(/^<script[^>]*>|<\/script>$/g, '');
  vm.runInNewContext(body, context);
  let stamp = 0;
  return { events, document, gl: new GL(),
    start() { document.readyState = 'interactive'; listeners.DOMContentLoaded(); },
    frame() { stamp += 100; frames.shift()?.(stamp); },
    hide() { busy = false; } };
}

test('entertainment text becomes ready after DOM without waiting for window load', () => {
  const p = probe(false);p.start();p.frame();p.frame();
  assert.equal(p.document.readyState, 'interactive');
  assert.deepEqual(p.events, ['aob:work-loading', 'aob:work-ready']);
  p.frame();assert.equal(p.events.length, 2);
});
test('a scene stays covered until an actual draw and its loading overlay disappears', () => {
  const p = probe(true, true);p.start();
  for (let i = 0; i < 100; i++) p.frame();
  assert.deepEqual(p.events, ['aob:work-loading'], 'elapsed time cannot declare a blank scene ready');
  assert.equal(p.gl.drawArrays(), 7);
  p.frame();p.frame();assert.equal(p.events.length, 1);
  p.hide();p.frame();p.frame();assert.equal(p.events[1], 'aob:work-ready');
});
test('the existing formal probe remains a separate policy', () => {
  assert.match(probeTag(), /setTimeout\(post,8000\)/);
  assert.doesNotMatch(entertainmentProbeTag(true), /setTimeout\(post/);
});
