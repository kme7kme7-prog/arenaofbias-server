// Arena fold. Blind-comparison frames and public viewers can opt into this script.
// It hides a work's own floating control panels (small fixed / absolute boxes holding
// buttons or inputs, plus the
// common GUI libraries) so both sides are compared on the work itself. The arena toolbar
// shows them again; hidden panels keep their DOM and state.
// Protocol for the parent arena toolbar (default: hidden):
// Child -> parent: {source:'sp-fold', count} once at startup (possibly 0), then
// once per newly hidden batch. count is cumulative and never decreases.
// Parent -> child: {source:'sp-arena', fold:boolean}; true hides, false shows.
// Only messages whose source is this window's parent are accepted.
(() => {
  const root = document.documentElement;
  const LIBS = '.lil-gui.root, .dg.main, .tp-dfwv';
  const CONTROLS = 'button, input, select, textarea, [role="button"], [role="slider"], summary';
  const SCENE = 'canvas, video, iframe, svg[role="img"]';
  const marked = new Set();

  root.setAttribute('data-sp-fold', '');
  const style = document.createElement('style');
  style.textContent = 'html[data-sp-fold] [data-sp-fold-ui]{display:none!important}';
  root.appendChild(style);

  const report = () => {
    try { parent.postMessage({ source: 'sp-fold', count: marked.size }, '*'); } catch { /* detached */ }
  };

  // Real works mix tuning controls with navigation, descriptions and an activation
  // button. Keep those regions intact rather than hiding their contents together.
  function isContent(el) {
    if (el.matches('header') || (el.matches('[aria-live], [aria-labelledby]') && el.querySelector('p'))) return true;
    if (el.matches('section') && el.querySelector('strong + p')) return true;
    if ([...el.querySelectorAll('li')].some((item) => item.textContent.trim() && !item.matches(CONTROLS) && !item.querySelector(CONTROLS))) return true;
    const buttons = el.matches('button, [role="button"]') ? [el] : el.querySelectorAll('button, [role="button"]');
    return [...buttons].some((button) => /键盘体验/.test(`${button.textContent} ${button.getAttribute('aria-label') ?? ''}`));
  }

  // The outermost small positioned box, or a small static card in a full-page overlay.
  function panelOf(control, limit) {
    let best = null;
    let small = null;
    for (let el = control; el && el !== document.body && el !== root; el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      if (el.querySelector(SCENE)) break;
      if (isContent(el)) return null;
      const positioned = /^(fixed|absolute|sticky)$/.test(getComputedStyle(el).position);
      if (rect.width * rect.height > limit) {
        if (positioned && !best && small !== control) best = small;
        break;
      }
      // A positioned checkbox/radio may only be a visually hidden input behind a
      // label, not a panel. Hiding it removes native focus and inflates the count.
      if (positioned && (el !== control || !el.matches('input, select, textarea'))) best = el;
      small = el;
    }
    return best;
  }

  function scan() {
    if (!document.body) return;
    const area = innerWidth * innerHeight;
    const found = new Set(document.querySelectorAll(LIBS));
    for (const control of document.body.querySelectorAll(CONTROLS)) {
      if (!control.getClientRects().length || [...found].some((box) => box.contains(control))) continue;
      const box = panelOf(control, area * 0.35);
      if (box) found.add(box);
    }
    const all = [...found, ...marked];
    const fresh = [...found].filter((box) => !marked.has(box) && !all.some((other) => other !== box && other.contains(box)));
    // Many boxes, or boxes covering much of the page, are the work itself (a keyboard of
    // positioned keys, a control-driven layout): leave those works untouched.
    const covered = fresh.reduce((sum, box) => { const r = box.getBoundingClientRect(); return sum + r.width * r.height; }, 0);
    if (marked.size + fresh.length > 6 || covered > area * 0.4) return;
    for (const box of fresh) {
      box.setAttribute('data-sp-fold-ui', '');
      marked.add(box);
    }
    if (fresh.length) report();
  }

  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.source !== 'sp-arena') return;
    root.toggleAttribute('data-sp-fold', Boolean(event.data.fold));
  });
  // Panels built by module scripts or after assets arrive show up late.
  function start() {
    report();
    scan();
    for (const wait of [600, 1800, 4000]) setTimeout(scan, wait);
  }
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
})();
