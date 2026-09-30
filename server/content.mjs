// The content server: runs submitted works away from the site. Each work, match side and
// draft is reached through its own host name ({token}.<content domain>), so every page gets
// a separate origin and can reach neither the site's session nor another work.
import { readFileSync } from 'node:fs';
import { resolveInside, streamFile } from './http.mjs';

// Scripts the content server adds to a page: the trial-load probe for drafts, the panel
// fold for blind-comparison frames. Stored works are otherwise served as uploaded.
const SCRIPTS = {
  draft: { path: '/__sp_probe.js', body: readFileSync(new URL('./probe.js', import.meta.url)) },
  match: { path: '/__sp_fold.js', body: readFileSync(new URL('./fold.js', import.meta.url)) },
};

function errorPage(res, status, title, detail) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + '<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121211;color:#ecebe6;font:15px/1.7 system-ui,sans-serif;text-align:center}b{display:block;font:600 22px "Songti SC","Noto Serif SC",serif;letter-spacing:.04em}span{color:#8d8a82;font-size:13px}</style>'
    + `<main><b>${title}</b><span>${detail}</span></main>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

// Adds a script as the first one of an HTML page. latin1 keeps the bytes of any page
// encoding intact because the inserted tag is plain ASCII.
function withScript(buffer, path) {
  const html = buffer.toString('latin1');
  const script = `<script src="${path}"></script>`;
  let out;
  if (/<head\b[^>]*>/i.test(html)) out = html.replace(/<head\b[^>]*>/i, (tag) => tag + script);
  else if (/<html\b[^>]*>/i.test(html)) out = html.replace(/<html\b[^>]*>/i, (tag) => tag + script);
  else out = html.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + script);
  return Buffer.from(out, 'latin1');
}

export function createContentHandler({ config, library, arena, siteOrigins }) {
  const cdn = config.cdn.map((host) => `https://${host}`).join(' ');
  const policy = [
    'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads',
    "default-src 'self' data: blob:",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${cdn}`,
    `style-src 'self' 'unsafe-inline' ${cdn}`,
    `img-src 'self' data: blob: ${cdn}`,
    `font-src 'self' data: ${cdn}`,
    `media-src 'self' data: blob: ${cdn}`,
    `connect-src 'self' data: blob: ${cdn}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    `frame-ancestors ${siteOrigins.join(' ')}`,
  ].join('; ');

  function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    const key = String(req.headers.host ?? '').split('.')[0].toLowerCase();
    if (!/^[wmdp][0-9a-f]{32}$/.test(key)) return errorPage(res, 404, '作品地址无效', '请从展厅重新打开作品。');

    let target = null;
    if (key[0] === 'd') {
      const draft = library.draftByToken(key);
      if (draft) target = { dir: draft.dir, entry: draft.entry, draft: true };
    } else if (key[0] === 'm') {
      const work = arena.workForToken(key);
      if (library.isEligible(work)) target = { dir: work.dir, entry: work.entry ?? 'index.html' };
    } else if (key[0] === 'p') {
      const work = library.previewByKey(key);
      if (work) target = { dir: work.dir, entry: work.entry, private: true };
    } else {
      const work = library.byContentKey(key);
      if (library.contentAllowed(work)) target = { dir: work.dir, entry: work.entry, private: work.moderation.status !== 'legacy' };
    }
    if (!target) return errorPage(res, 410, '作品已不可用', key[0] === 'm' ? '这一组比较已经结束，请开始新的一组。' : '作品尚未公开、已被删除，或预览地址已过期。');

    const { pathname } = new URL(req.url, 'http://content.invalid');
    const headers = {
      'Content-Security-Policy': policy,
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
      'Cache-Control': target.draft || target.private || key[0] === 'm' ? 'no-store' : 'private, max-age=600',
    };
    const inject = target.draft ? SCRIPTS.draft : key[0] === 'm' ? SCRIPTS.match : null;
    if (inject && pathname === inject.path) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': inject.body.length });
      return res.end(req.method === 'HEAD' ? undefined : inject.body);
    }
    const found = resolveInside(target.dir, pathname === '/' ? `/${target.entry}` : pathname);
    if (!found) return errorPage(res, 404, '找不到文件', pathname.slice(0, 120));
    if (inject && /\.html?$/i.test(found.file)) {
      const body = withScript(readFileSync(found.file), inject.path);
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    return streamFile(req, res, found, headers);
  }

  return async (req, res) => {
    try {
      return await serve(req, res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error.code === 'ERR_INVALID_URL') return errorPage(res, 400, '作品地址无效', '请求路径无法解析。');
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return errorPage(res, 404, '找不到文件', '作品资源已不可用。');
      console.error('Content request failed:', error);
      return errorPage(res, 500, '作品暂时不可用', '请稍后再试。');
    }
  };
}
