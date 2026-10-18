// Fixed-host content transport. Only the small shell has a normal origin; uploaded
// documents always run in an opaque sandbox, including when opened directly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY = '[wmdpc][0-9a-f]{32}';
const ROUTE = new RegExp(`^/(v|c)/(${KEY})(/.*)$`);
const shellScript = readFileSync(new URL('./content-shell.js', import.meta.url), 'utf8');
const shellHash = createHash('sha256').update(shellScript).digest('base64');
export const contentRuntime = readFileSync(new URL('./content-runtime.js', import.meta.url));
export const contentRuntimePath = `/_aob/content-runtime.${createHash('sha256').update(contentRuntime).digest('hex').slice(0, 20)}.js`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function validateContentOrigin(value, sites = []) {
  if (!value) return '';
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      sites.some(site => new URL(site).hostname === url.hostname)) throw new Error('CONTENT_PATH_ORIGIN must use a dedicated HTTPS hostname (HTTP loopback is allowed for development)');
  return value;
}

export const contentUrl = (config, key) => config.contentPathOrigin
  ? `${config.contentPathOrigin}/v/${key}` : config.contentTemplate.replace('{token}', key);

export function contentRoute(config, req) {
  if (!config.contentPathOrigin) return null;
  const base = new URL(config.contentPathOrigin);
  if (String(req.headers.host).toLowerCase() !== base.host.toLowerCase()) return null;
  const url = new URL(req.url, base);
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  return { shell: match[1] === 'v', key: match[2], path: match[3], origin: base.origin,
    prefix: `/c/${match[2]}/`, url };
}

export function shellResponse(route, sites) {
  const source = `${route.prefix.slice(0, -1)}${route.path}${route.url.search}`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>作品预览</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}iframe{display:block}</style></head><body data-work="${route.key}" data-source="${escape(source)}" data-parents="${escape(JSON.stringify(sites))}"><script>${shellScript}</script></body></html>`;
  const policy = ["default-src 'none'", `script-src 'sha256-${shellHash}'`, "style-src 'unsafe-inline'",
    `frame-src ${route.origin}${route.prefix}`, `frame-ancestors ${sites.join(' ') || "'none'"}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  return { body: Buffer.from(body), policy };
}

// Root-relative HTML and CSS references must stay inside the work's capability.
// JavaScript import URLs are handled by the import map; fetch/XHR/DOM setters by
// the runtime. Stored source files are never modified.
export function rebaseCss(source, prefix) {
  return source.replace(/(url\(\s*["']?)(\/(?!\/)[^\s)'";]*)/gi, (_, lead, path) => `${lead}${path.startsWith(prefix) ? path : prefix + path.slice(1)}`)
    .replace(/(@import\s+["'])(\/(?!\/)[^"']*)/gi, (_, lead, path) => `${lead}${path.startsWith(prefix) ? path : prefix + path.slice(1)}`);
}

export function pathDocument(buffer, route, pathname) {
  let html = buffer.toString('latin1');
  const reference = value => /^\/(?!\/)/.test(value) && !value.startsWith(route.prefix)
    ? route.prefix + value.slice(1) : value;
  const tag = source => {
    let result = source.replace(/(\s(?:src|href|poster|action|data|srcset|style)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (_, lead, double, single, plain) => {
        const value = double ?? single ?? plain, quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
        const next = /^\s*style\s*=/i.test(lead) ? rebaseCss(value, route.prefix)
          : /^\s*srcset\s*=/i.test(lead) ? value.replace(/(^|,\s*)(\/(?!\/)[^,\s]+)/g, (match, start, url) => start + reference(url))
            : reference(value);
        return lead + quote + next + quote;
      });
    // Local images used as WebGL/canvas textures need CORS in an opaque document.
    if (/^<img\b/i.test(result) && !/\bcrossorigin\s*(?:=|\s|>)/i.test(result)) result = result.replace(/^<img\b/i, '<img crossorigin="anonymous"');
    return result;
  };
  // Leave script bodies and comments byte-for-byte intact; HTML-looking strings
  // inside JavaScript must not be mistaken for real source attributes.
  html = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi, source => {
    if (source.startsWith('<!--')) return source;
    if (/^<script\b/i.test(source)) return source.replace(/^<script\b[^>]*>/i, tag);
    if (/^<style\b/i.test(source)) return rebaseCss(source, route.prefix);
    return tag(source);
  });
  const base = `${route.origin}${route.prefix}`;
  let hasMap = false;
  html = html.replace(/<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, (tag, json) => {
    try {
      const map = JSON.parse(json);
      map.imports ??= {};
      for (const [key, value] of Object.entries(map.imports)) if (typeof value === 'string' && /^\/(?!\/)/.test(value))
        map.imports[key] = value.startsWith(route.prefix) ? value : route.prefix + value.slice(1);
      map.imports[`${route.origin}/`] = base;
      map.imports[base] = base;
      hasMap = true;
      return `<script type="importmap">${JSON.stringify(map).replaceAll('<', '\\u003c')}</script>`;
    } catch { return tag; }
  });
  const directory = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
  const head = `<base href="${escape(base + directory.replace(/^\//, ''))}"><script src="${contentRuntimePath}"></script>`
    + (hasMap ? '' : `<script type="importmap">${JSON.stringify({ imports: { [`${route.origin}/`]: base, [base]: base } })}</script>`);
  const insert = /<head\b[^>]*>/i;
  if (insert.test(html)) html = html.replace(insert, tag => tag + head);
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${head}</head>`);
  else html = html.replace(/^(\s*<!doctype[^>]*>)?/i, start => `${start}<head>${head}</head>`);
  return Buffer.from(html, 'latin1');
}

export function pathPolicy(route, cdn, sites) {
  const own = `${route.origin}${route.prefix}`;
  return [
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads',
    `default-src ${own} data: blob:`,
    `script-src ${own} ${route.origin}${contentRuntimePath} 'unsafe-inline' 'unsafe-eval' blob: ${cdn}`,
    `style-src ${own} 'unsafe-inline' ${cdn}`,
    `img-src ${own} data: blob: ${cdn}`, `font-src ${own} data: ${cdn}`,
    `media-src ${own} data: blob: ${cdn}`, `connect-src ${own} data: blob: ${cdn}`,
    `worker-src ${own} blob:`, `frame-src ${own} blob: data:`, "object-src 'none'",
    `base-uri ${own}`, "form-action 'none'", `frame-ancestors ${[...new Set([...sites, route.origin])].join(' ')}`,
  ].join('; ');
}
