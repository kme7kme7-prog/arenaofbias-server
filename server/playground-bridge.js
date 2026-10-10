// Opt-in playground lifecycle controls; uploaded files remain unchanged.
(() => {
  const host = window.__PLAYGROUND_ORIGIN__;
  if (!host || parent === window) return;
  let active = true;
  let dragging = false;
  let start = null;
  let initial = null;
  let rendered = false;
  let cameraAnnounced = false;
  let cameraGrace;
  let svgObserver;
  let domReady = false;
  let workReady = false;
  let stable = 0;
  let readinessTimer;
  function hasLoadingOverlay() {
    for (const node of document.querySelectorAll('[id],[class],[role="progressbar"],[aria-busy="true"]')) {
      const name = (node.id + ' ' + (typeof node.className === 'string' ? node.className : '')).toLowerCase();
      if (!/(?:load|preload|splash|boot)/.test(name) && node.getAttribute('aria-busy') !== 'true' && node.getAttribute('role') !== 'progressbar') continue;
      const bounds = node.getBoundingClientRect();
      if (bounds.width < innerWidth * .35 || bounds.height < innerHeight * .25) continue;
      const style = getComputedStyle(node);
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .05 && ['fixed', 'absolute'].includes(style.position)) return true;
    }
    return false;
  }
  function settleReadiness() {
    if (workReady) return;
    stable = domReady && rendered && !hasLoadingOverlay() ? stable + 1 : 0;
    if (stable >= 2) { workReady = true; parent.postMessage('aob:work-ready', host); return; }
    readinessTimer = setTimeout(settleReadiness, 80);
  }
  // Observe real draws for uncalibrated/inline works too. Camera support is a
  // capability, not a prerequisite for an otherwise rendered fixed-view work.
  function markRendered(canvas, size = canvas) {
    if (rendered || !canvas?.isConnected || size.width < innerWidth * .2 || size.height < innerHeight * .2) return;
    const bounds = canvas.getBoundingClientRect?.();
    if (bounds && (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= innerHeight || bounds.left >= innerWidth)) return;
    rendered = true;
    svgObserver?.disconnect();
    send('rendered');
    cameraGrace = setTimeout(() => {
      if (!cameraAnnounced) { cameraAnnounced = true; send('camera-ready', { available: setupCamera() }); }
    }, 1200);
  }
  // WebGPU does not call the WebGL draw methods. Wait for a submission after
  // acquiring a presentation texture rather than treating setup as rendering.
  if (window.GPUCanvasContext && window.GPUQueue) {
    const pending = new Set();
    // oxlint-disable-next-line typescript/unbound-method -- wrapped native method retains its context through apply
    const texture = GPUCanvasContext.prototype.getCurrentTexture;
    // oxlint-disable-next-line typescript/unbound-method -- wrapped native method retains its context through apply
    const submit = GPUQueue.prototype.submit;
    GPUCanvasContext.prototype.getCurrentTexture = function (...args) {
      const result = texture.apply(this, args); pending.add(this.canvas); return result;
    };
    GPUQueue.prototype.submit = function (...args) {
      const result = submit.apply(this, args);
      for (const canvas of pending) markRendered(canvas);
      pending.clear(); return result;
    };
  }
  function inspectSvgScene() {
    if (rendered) return;
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,line,use,image').length < 4) continue;
      markRendered(svg, svg.getBoundingClientRect());
      if (rendered) break;
    }
  }
  addEventListener('DOMContentLoaded', () => {
    domReady = true;
    if (!readinessTimer) settleReadiness();
    requestAnimationFrame(inspectSvgScene);
    if (!rendered) {
      svgObserver = new MutationObserver(inspectSvgScene);
      svgObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    }
  });
  for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Type) continue;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const base = Type.prototype[name];
      if (typeof base !== 'function') continue;
      Type.prototype[name] = function (...args) {
        if (!active || document.hidden) return;
        const result = base.apply(this, args); markRendered(this.canvas); return result;
      };
    }
  }
  if (window.CanvasRenderingContext2D) for (const name of ['drawImage', 'putImageData', 'fillRect', 'stroke', 'fill']) {
    const base = CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name] = function (...args) {
      const result = base.apply(this, args); markRendered(this.canvas); return result;
    };
  }
  const themedScenes = new WeakSet();
  window.__objectStageRender = (renderer, scene, camera) => {
    // The existing instrumentation also matches internal render(a,b) methods.
    // Only a genuine scene/camera renderer participates in exhibit lifecycle.
    if (!scene?.isScene || !camera?.isCamera || !renderer.domElement) return renderer.render(scene, camera);
    if (!active || document.hidden) return;
    if (scene && !themedScenes.has(scene)) {
      themedScenes.add(scene);
      if (window.__OBJECT_STAGE_PAPER__) {
        if (scene.background?.isColor) scene.background.set('#f2efe7');
        else if (!scene.background) renderer.setClearColor?.('#f2efe7', 1);
      }
    }
    const result = renderer.render(scene, camera);
    if (!renderer.isWebGPURenderer) markRendered(renderer.domElement);
    return result;
  };
  function send(type, extra = {}) { parent.postMessage({ stage: type, ...extra }, host); }
  function setupCamera() {
    const api = window.__AOB__;
    if (!api?.getState()) return false;
    initial = structuredClone(window.__OBJECT_STAGE_CAMERA__ || api.getState());
    api.setState(initial);
    for (const controls of api.controls) controls.autoRotate = false;
    return true;
  }
  let checks = 0;
  const readyTimer = setInterval(() => {
    if (setupCamera()) {
      clearInterval(readyTimer); clearTimeout(cameraGrace);
      cameraAnnounced = true; send('camera-ready', { available: true });
    }
    else if (++checks >= 100) clearInterval(readyTimer);
  }, 100);
  addEventListener('pointerdown', event => {
    if (event.target.tagName !== 'CANVAS') return;
    dragging = true;
    start = { x: event.clientX, y: event.clientY };
    // Stop the existing delayed calibration retries from undoing a user's drag.
    const api = window.__AOB__;
    if (api) { initial ||= api.saved || api.getState(); api.saved = null; api.manual = true; }
  }, true);
  addEventListener('pointermove', event => {
    if (dragging && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) {
      send('interacted'); start = null;
    }
  }, true);
  addEventListener('pointerup', () => { dragging = false; start = null; }, true);
  addEventListener('pointercancel', () => { dragging = false; start = null; }, true);
  addEventListener('wheel', event => { if (event.target.tagName === 'CANVAS') send('interacted'); }, { capture: true, passive: true });
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== host) return;
    if (event.data?.stage === 'active') active = Boolean(event.data.value);
    if (event.data?.stage === 'reset' && initial) {
      const api = window.__AOB__;
      if (api) {
        // Consume remaining drag inertia before applying the exact resting view.
        for (const controls of api.controls) {
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update?.();
          controls.enableDamping = damping;
        }
        api.manual = false;
        api.setState(initial);
      }
      send('reset');
    }
    if (event.data?.stage === 'escape') send('escape');
  });
  addEventListener('keydown', event => { if (event.key === 'Escape') send('escape'); });
  addEventListener('pagehide', () => { clearInterval(readyTimer); clearTimeout(cameraGrace); clearTimeout(readinessTimer); svgObserver?.disconnect(); active = false; });
})();
