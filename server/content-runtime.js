// Compatibility inside an opaque work document. This code is not a security
// boundary: CSP, the sandbox and the shell's source checks enforce isolation.
(() => {
  'use strict';
  const route = /^\/c\/[wmdpc][0-9a-f]{32}\//.exec(location.pathname);
  if (!route) return;
  const prefix = route[0], host = location.origin;
  const rebase = value => {
    if (typeof value !== 'string' && !(value instanceof URL)) return value;
    const url = new URL(String(value), document.baseURI);
    if (url.origin === host && !url.pathname.startsWith(prefix) && !/^\/[vc]\//.test(url.pathname))
      url.pathname = prefix + url.pathname.slice(1);
    return url.href;
  };
  let initial = {};
  try { initial = JSON.parse(window.name).aobStorage || {}; } catch { /* Direct sandbox URLs start with empty storage. */ }
  const snapshots = { local: initial.local || {}, session: initial.session || {} };
  for (const type of ['local', 'session']) {
    const values = new Map(Object.entries(snapshots[type]).map(([k, v]) => [k, String(v)]));
    const send = (op, key, value) => {
      snapshots[type] = Object.fromEntries(values);
      window.name = JSON.stringify({ aobStorage: snapshots });
      parent.postMessage({ source: 'aob-storage', type, op, key, value }, '*');
    };
    const storage = {
      get length() { return values.size; },
      key(index) { return [...values.keys()][Number(index)] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) {
        key = String(key); value = String(value);
        const next = Object.fromEntries([...values, [key, value]]);
        if (key.length > 4096 || JSON.stringify(next).length > 65536) throw new DOMException('Work storage quota exceeded', 'QuotaExceededError');
        values.set(key, value); send('set', key, value);
      },
      removeItem(key) { key = String(key); values.delete(key); send('remove', key); },
      clear() { values.clear(); send('clear'); },
    };
    const proxy = new Proxy(storage, {
      get(target, key) { return Reflect.has(target, key) ? Reflect.get(target, key) : typeof key === 'string' ? target.getItem(key) ?? undefined : undefined; },
      set(target, key, value) { target.setItem(key, value); return true; },
      deleteProperty(target, key) { target.removeItem(key); return true; },
      ownKeys() { return [...values.keys()]; },
      getOwnPropertyDescriptor(target, key) { return values.has(key) ? { configurable: true, enumerable: true, writable: true, value: values.get(key) } : undefined; },
    });
    Object.defineProperty(window, `${type}Storage`, { value: proxy, configurable: true });
  }
  const nativeFetch = window.fetch;
  window.fetch = (input, options) => nativeFetch(input instanceof Request ? new Request(rebase(input.url), input) : rebase(input), { ...options, credentials: 'omit' });
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) { return open.call(this, method, rebase(url), ...args); };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (['src', 'href', 'poster', 'action', 'data'].includes(String(name).toLowerCase())) value = rebase(String(value));
    if (this instanceof HTMLImageElement && name === 'src') this.crossOrigin = 'anonymous';
    return setAttribute.call(this, name, value);
  };
  for (const [Ctor, property] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'],
    [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLIFrameElement, 'src']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, property);
    if (!descriptor?.set) continue;
    Object.defineProperty(Ctor.prototype, property, { ...descriptor, set(value) {
      if (this instanceof HTMLImageElement) this.crossOrigin = 'anonymous';
      return descriptor.set.call(this, rebase(String(value)));
    } });
  }
  // Blob workers inherit this document's CSP and opaque origin. Their module or
  // classic entry is still fetched from the current work's capability path.
  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options = {}) {
        options ??= {};
        const target = rebase(String(url));
        if (/^(blob:|data:)/.test(target) && options.type !== 'module') { super(target, options); return; }
        // WebKit rejects module Worker entry blobs owned by an opaque origin.
        // Start a classic blob and evaluate the real entry as a module instead.
        // Hold early messages until that module (including top-level await) has
        // installed its listeners, matching native module-worker startup order.
        const setup = `
          const entry=${JSON.stringify(target)},root=${JSON.stringify(prefix)},host=${JSON.stringify(host)};
          const resolveResource=value=>{
            const u=new URL(String(value),entry);
            if(u.origin===host&&!u.pathname.startsWith(root)&&!/^\\/[vc]\\//.test(u.pathname))u.pathname=root+u.pathname.slice(1);
            return u.href;
          };
          const nativeFetch=self.fetch;
          self.fetch=(input,options)=>nativeFetch(input instanceof Request?new Request(resolveResource(input.url),input):resolveResource(input),{...options,credentials:'omit'});
          const nativeImportScripts=self.importScripts;
          self.importScripts=(...urls)=>nativeImportScripts(...urls.map(resolveResource));
        `;
        const code = setup + (options.type === 'module' ? `
          const queue=[];
          const hold=e=>{queue.push(e);e.stopImmediatePropagation()};
          addEventListener('message',hold,true);
          import(${JSON.stringify(target)}).then(()=>{
            removeEventListener('message',hold,true);
            for(const e of queue)dispatchEvent(new MessageEvent('message',{data:e.data,ports:e.ports,origin:e.origin,lastEventId:e.lastEventId}));
          }).catch(error=>setTimeout(()=>{throw error}));
        ` : `importScripts(${JSON.stringify(target)});`);
        const blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        super(blob, { ...options, type: 'classic', credentials: 'omit' });
        setTimeout(() => URL.revokeObjectURL(blob), 60000);
      }
    };
  }
})();
