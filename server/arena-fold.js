// Optional Arena presentation adapter. Never alters the stored work or its controls.
(() => {
  const root = document.documentElement;
  const controls = 'button,input,select,textarea,[role="button"],[role="slider"],summary';
  const marked = new Set();
  const annotations = new Set();
  const style = document.createElement('style');
  style.textContent = 'html[data-aob-fold] [data-aob-fold-panel],html[data-aob-fold] [data-aob-fold-labels]{display:none!important}';
  root.append(style);
  root.setAttribute('data-aob-fold', '');
  const sceneOnly = new URL(location.href).searchParams.getAll('aob').includes('arena-scene');
  let isolatedCanvas = null;
  const sceneStyle = document.createElement('style');
  sceneStyle.textContent = `
    html[data-aob-scene],html[data-aob-scene] body{width:100%!important;height:100%!important;overflow:hidden!important;margin:0!important;padding:0!important}
    html[data-aob-scene] [data-aob-scene-hidden]{display:none!important}
    html[data-aob-scene] [data-aob-scene-path]{display:block!important;position:relative!important;inset:auto!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;transform:none!important;overflow:hidden!important;aspect-ratio:auto!important}
    html[data-aob-scene] [data-aob-scene-path]::before,html[data-aob-scene] [data-aob-scene-path]::after{display:none!important}
  `;
  root.append(sceneStyle);
  function isolateScene() {
    if (!sceneOnly || !document.body) return;
    if (!isolatedCanvas?.isConnected) {
      root.removeAttribute('data-aob-scene');
      for (const node of document.querySelectorAll('[data-aob-scene-path],[data-aob-scene-hidden]')) {
        node.removeAttribute('data-aob-scene-path');
        node.removeAttribute('data-aob-scene-hidden');
      }
      // Multiple substantial canvases may be different views. Do not choose arbitrarily.
      const candidates = [...document.querySelectorAll('canvas')].filter(canvas => {
        const r = canvas.getBoundingClientRect();
        return r.width >= 150 && r.height >= 120;
      });
      if (candidates.length !== 1) return;
      isolatedCanvas = candidates[0];
      root.setAttribute('data-aob-scene', '');
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        window.dispatchEvent(new Event('resize'));
      });
    }
    // Keep the original nodes and event handlers. Only presentation changes; the
    // work's own resize handler / observer updates its renderer and camera aspect.
    for (let branch = isolatedCanvas; branch && branch !== root; branch = branch.parentElement) {
      branch.removeAttribute('data-aob-fold-panel');
      branch.setAttribute('data-aob-scene-path', '');
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && !sibling.matches('head,script,style,link,meta,title')) sibling.setAttribute('data-aob-scene-hidden', '');
      }
    }
  }
  const report = () => parent.postMessage({ source: 'sp-fold', count: marked.size }, '*');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) };
  };
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const overlaps = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

  // Projected part labels share a non-interactive overlay. Their class names vary;
  // require the geometry and all children to agree instead of hiding every .tag.
  function scanAnnotations(scenes) {
    const groups = new Map();
    for (const node of [...document.querySelectorAll('div,span')].slice(0, 2000)) {
      if (node.children.length || !node.textContent.trim() || node.textContent.length > 120) continue;
      const css = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (css.position !== 'absolute' || css.pointerEvents !== 'none' || r.width > Math.min(600, innerWidth * .9) || r.height > 80) continue;
      const layer = node.parentElement;
      if (!layer || layer === root || layer === document.body || annotations.has(layer)) continue;
      const layerCss = getComputedStyle(layer);
      if (!/^(fixed|absolute)$/.test(layerCss.position) || layerCss.pointerEvents !== 'none' ||
          layer.querySelector('canvas,svg,img,video,iframe,a,h1,h2,h3,' + controls) ||
          !scenes.some(scene => overlaps(rect(layer), rect(scene)))) continue;
      if (!groups.has(layer)) groups.set(layer, []);
      groups.get(layer).push(node);
    }
    for (const [layer, labels] of groups) {
      // A mixed HUD may contain instructions or a title; leave such containers intact.
      if (labels.length < 3 || labels.length !== layer.children.length) continue;
      layer.setAttribute('data-aob-fold-labels', '');
      annotations.add(layer);
    }
  }
  function scan() {
    if (!document.body) return;
    isolateScene();
    for (const box of marked) if (!box.isConnected) marked.delete(box);
    for (const layer of annotations) if (!layer.isConnected) annotations.delete(layer);
    const viewport = innerWidth * innerHeight;
    const scenes = [...document.querySelectorAll('canvas')].filter(el => area(rect(el)) > viewport * .4);
    if (!scenes.length) { report(); return; }
    scanAnnotations(scenes);
    const found = new Set();
    for (const control of [...document.querySelectorAll(controls)].slice(0, 500)) {
      if (!control.getClientRects().length || [...marked].some(box => box.contains(control))) continue;
      let candidate = null;
      for (let el = control; el && el !== document.body && el !== root; el = el.parentElement) {
        if (el.querySelector('canvas,video,iframe')) break;
        // Entry screens, prose and data-entry forms are part of the work, not tuning UI.
        if (el.matches('header,form,article') || (el.matches('[aria-live],[aria-labelledby]') && el.querySelector('p')) || el.querySelector('input[type="password"],input[type="email"],textarea') ||
            /开始体验|进入体验|点击开始|start experience|enter experience/i.test(el.textContent)) { candidate = null; break; }
        const r = rect(el);
        if (area(r) > viewport * .6) break;
        if (el !== control && /^(fixed|absolute)$/.test(getComputedStyle(el).position) && area(r) > 100 &&
            scenes.some(scene => overlaps(rect(scene), r))) candidate = el;
      }
      if (candidate && (candidate.querySelectorAll(controls).length >= 2 || candidate.querySelector('input[type="range"],select,[role="slider"]'))) found.add(candidate);
    }
    const fresh = [...found].filter(box => ![...found, ...marked].some(other => other !== box && other.contains(box)));
    if (marked.size + fresh.length <= 6 && fresh.reduce((sum, box) => sum + area(rect(box)), 0) <= viewport * .65) {
      for (const box of fresh) { box.setAttribute('data-aob-fold-panel', ''); marked.add(box); }
    }
    report();
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.source !== 'sp-arena' || typeof event.data.fold !== 'boolean') return;
    root.toggleAttribute('data-aob-fold', event.data.fold);
  });
  let pending;
  const schedule = () => { if (!pending) pending = setTimeout(() => { pending = null; scan(); }, 200); };
  function start() {
    scan();
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', schedule);
    for (const delay of [600, 1800, 4000]) setTimeout(scan, delay);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
