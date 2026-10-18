// Trusted fixed-origin shell. Never evaluates work source or gives the child a
// normal origin. Storage and messages are scoped to this exact iframe instance.
(() => {
  'use strict';
  const { work, source, parents } = document.body.dataset;
  const origins = new Set(JSON.parse(parents));
  const namespace = `aob-work:${work}`;
  const read = type => {
    try {
      const value = JSON.parse(window[`${type}Storage`].getItem(namespace) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const stores = { local: read('local'), session: read('session') };
  const frame = document.createElement('iframe');
  frame.title = '作品';
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads');
  frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-write');
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'no-referrer';
  frame.name = JSON.stringify({ aobStorage: stores });
  const persist = type => {
    try { window[`${type}Storage`].setItem(namespace, JSON.stringify(stores[type])); } catch { /* Browser storage may be disabled. */ }
  };
  addEventListener('message', event => {
    if (event.source === frame.contentWindow && event.origin === 'null') {
      if (event.data?.source === 'aob-storage') {
        const { type, op, key, value } = event.data;
        if (!['local', 'session'].includes(type)) return;
        if (op === 'clear') stores[type] = {};
        else if (typeof key === 'string' && key.length <= 4096) {
          if (op === 'remove') delete stores[type][key];
          else if (op === 'set' && typeof value === 'string' && value.length <= 65536) {
            const next = { ...stores[type], [key]: value };
            if (JSON.stringify(next).length > 65536) return;
            stores[type] = next;
          } else return;
        } else return;
        persist(type);
        return;
      }
      // Preserve the existing fold, draft probe, readiness and camera protocols.
      // The site still receives a normal content origin and checks this window.
      if (parent !== window) parent.postMessage(event.data, '*');
    } else if (event.source === parent && parent !== window && origins.has(event.origin)) {
      frame.contentWindow?.postMessage(event.data, '*');
    }
  });
  frame.src = source;
  document.body.append(frame);
})();
