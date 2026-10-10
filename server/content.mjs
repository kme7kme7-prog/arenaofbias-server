// The content server: runs submitted works away from the site. Each work, match side and
// draft is reached through its own host name ({token}.<content domain>), so every page gets
// a separate origin and can reach neither the site's session nor another work.
import { readFileSync } from 'node:fs';
import { entertainmentProbeTag } from './work-ready.mjs';
import { THREE_MIRROR_PATH } from './config.mjs';
import { HttpError, resolveInside, streamFile } from './http.mjs';
import { createReadGuard } from './read-guard.mjs';
import { bridgeTags, probeTag, rewriteImportmap, serveBridgeVirtual, validCamera } from './bridge.mjs';
import { APEX_ASSET, APEX_CAMERA_PATH, adaptApexCamera, apexDocument, adaptApexDocument } from './apex-camera.mjs';
import { TESSERA_ASSET, TESSERA_CAMERA_PATH, adaptTesseraCamera, tesseraDocument, adaptTesseraDocument } from './tessera-camera.mjs';
import { entertainmentMatches, entertainmentOptions, entertainmentCamera, entertainmentDocument, entertainmentModule, entertainmentProfile } from './entertainment-calibration.mjs';

import { extendStageTable } from './playground-surface.mjs';

const stageBridge = readFileSync(new URL('./playground-bridge.js', import.meta.url));
const stageRender = body => Buffer.from(body.toString('latin1').replace(/(window\.__AOB__\?\.prepareCamera\?\.\([\w$.]+\),)([\w$.]+)\.render\(\s*([\w$.]+)\s*,\s*([\w$.]+)\s*\)/g, '$1window.__objectStageRender($2,$3,$4)').replaceAll('aob=entertainment-camera', 'aob=entertainment-camera&aob=playground'), 'latin1');

// Scripts the content server adds to a page: the trial-load probe for drafts, the panel
// fold for blind-comparison frames and public pages that opt in with ?aob=fold.
const SCRIPTS = {
  draft: { path: '/__sp_probe.js', body: readFileSync(new URL('./probe.js', import.meta.url)) },
  match: { path: '/__sp_fold.js', body: readFileSync(new URL('./fold.js', import.meta.url)) },
  arena: { path: '/__aob_fold.js', body: readFileSync(new URL('./arena-fold.js', import.meta.url)) },
};

function errorPage(res, status, title, detail, headers = {}) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  title = escape(title);
  detail = escape(detail);
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + '<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121211;color:#ecebe6;font:15px/1.7 system-ui,sans-serif;text-align:center}b{display:block;font:600 22px "Songti SC","Noto Serif SC",serif;letter-spacing:.04em}span{color:#8d8a82;font-size:13px}</style>'
    + `<main><b>${title}</b><span>${detail}</span></main>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

// Adds markup as the first thing inside a page's <head>. latin1 keeps the bytes of any
// page encoding intact because the inserted markup is plain ASCII.
function withHeadTags(buffer, tags) {
  const html = buffer.toString('latin1');
  let out;
  if (/<head\b[^>]*>/i.test(html)) out = html.replace(/<head\b[^>]*>/i, (tag) => tag + tags);
  else if (/<html\b[^>]*>/i.test(html)) out = html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${tags}</head>`);
  else out = tags + html;
  return Buffer.from(out, 'latin1');
}

const scriptTag = (path) => `<script src="${path}"></script>`;

export function createContentHandler({ config, library, arena, siteOrigins, readGuard = createReadGuard(config) }) {
  // jsdelivr is limited to npm: its GitHub paths follow a repository that can change after review.
  const cdn = config.cdn.map((host) => host === 'cdn.jsdelivr.net' ? 'https://cdn.jsdelivr.net/npm/'
    : `https://${host}${host === 'registry.npmmirror.com' ? THREE_MIRROR_PATH : ''}`).join(' ');
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
    readGuard.file(req);
    const key = String(req.headers.host ?? '').split('.')[0].toLowerCase();
    if (!/^[wmdpc][0-9a-f]{32}$/.test(key)) return errorPage(res, 404, '作品地址无效', '请从展厅重新打开作品。');

    let target = null;
    let work = null;
    if (key[0] === 'd') {
      const draft = library.draftByToken(key);
      if (draft) target = { dir: draft.dir, entry: draft.entry, draft: true };
    } else if (key[0] === 'm') {
      work = arena.workForToken(key);
      if (library.isEligible(work)) target = { dir: work.dir, entry: work.entry ?? 'index.html' };
    } else if (key[0] === 'c') {
      work = library.curatedByKey(key);
      if (library.publicCuratedContent(work)) target = { dir: work.dir, entry: work.entry ?? 'index.html', private: true };
    } else if (key[0] === 'p') {
      work = library.previewByKey(key);
      if (work) target = { dir: work.dir, entry: work.entry ?? 'index.html', private: true };
    } else {
      work = library.byContentKey(key);
      if (library.publicContent(work)) target = { dir: work.dir, entry: work.entry, private: work.moderation.status !== 'legacy' };
    }
    if (!target) return errorPage(res, 410, '作品已不可用', key[0] === 'm' ? '这一组比较已经结束，请开始新的一组。' : '作品尚未公开、已被删除，或预览地址已过期。');

    const url = new URL(req.url, 'http://content.invalid');
    const { pathname } = url;
    const playground = !target.draft && key[0] !== 'm' && url.searchParams.getAll('aob').includes('playground');
    const stageParent = playground && siteOrigins.includes(url.searchParams.get('parent')) ? url.searchParams.get('parent') : null;
    const headers = {
      'Content-Security-Policy': policy,
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
      'Cache-Control': target.draft || target.private || key[0] === 'm' ? 'no-store' : 'private, max-age=600',
    };
    if (pathname === '/__playground.js' && !target.draft) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': stageBridge.length });
      return res.end(req.method === 'HEAD' ? undefined : stageBridge);
    }
    const fold = key[0] === 'm' || (!target.draft && url.searchParams.getAll('aob').includes('fold'));
    const arenaFold = !target.draft && url.searchParams.getAll('aob').includes('arena-fold');
    const inject = pathname === SCRIPTS.arena.path ? SCRIPTS.arena : pathname === SCRIPTS.match.path ? SCRIPTS.match : target.draft ? SCRIPTS.draft : null;
    if (inject && pathname === inject.path) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': inject.body.length });
      return res.end(req.method === 'HEAD' ? undefined : inject.body);
    }
    // A pinned bundled work adapter is served dynamically; stored assets stay intact.
    if (!target.draft && pathname === APEX_CAMERA_PATH) {
      const asset = resolveInside(target.dir, APEX_ASSET);
      const body = asset && adaptApexCamera(readFileSync(asset.file));
      if (!body) return errorPage(res, 404, '取景适配不可用', '作品版本已变化，请使用原作预览。');
      res.writeHead(200, { ...headers, 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    // Bridge forwarding modules for rewritten importmaps, ahead of any real file lookup.
    if (!target.draft && pathname === TESSERA_CAMERA_PATH) {
      const asset = resolveInside(target.dir, TESSERA_ASSET);
      const body = asset && adaptTesseraCamera(readFileSync(asset.file));
      if (!body) return errorPage(res, 404, '取景适配不可用', '作品版本已变化，请使用原作预览。');
      res.writeHead(200, { ...headers, 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const virtual = serveBridgeVirtual(pathname, url.searchParams);
    if (virtual) {
      if (virtual.error) return errorPage(res, virtual.error, '作品地址无效', '转发目标无法解析。');
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(virtual.body) });
      return res.end(req.method === 'HEAD' ? undefined : virtual.body);
    }
    const found = resolveInside(target.dir, pathname === '/' ? `/${target.entry}` : pathname);
    if (!found) return errorPage(res, 404, '找不到文件', pathname.slice(0, 120));
    if (!target.draft && key[0] !== 'm' && url.searchParams.getAll('aob').includes('entertainment-camera') && /\.m?js$/i.test(found.file)) {
      let body = entertainmentModule(readFileSync(found.file), work, pathname);
      if (body && playground) {
        const source = extendStageTable(body.toString('latin1'), { workId: work.taskId === 'desk-lamp' ? `dp-021-${work.id}` : work.id, modules: entertainmentProfile(work)?.modules }, pathname);
        body = stageRender(Buffer.from(source, 'latin1'));
      }
      if (body) {
        res.writeHead(200, { ...headers, 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
    }
    if (/\.html?$/i.test(found.file)) {
      readGuard.page(req);
      // Match sides get the fold plus the ready probe (the arena transition gate listens
      // for aob:work-ready); the camera bridge restores or captures per bridgePlan.
      const head = [];
      // Start the readiness clock before any parser-blocking injected script.
      if (!stageParent && (key[0] === 'm' || key[0] === 'c' || url.searchParams.getAll('aob').includes('prev'))) {
        head.push(arenaFold && key[0] !== 'm'
          ? entertainmentProbeTag(url.searchParams.getAll('aob').includes('arena-scene')) : probeTag());
      }
      if (target.draft) head.push(scriptTag(SCRIPTS.draft.path));
      if (arenaFold) head.push(scriptTag(SCRIPTS.arena.path));
      else if (fold) head.push(scriptTag(SCRIPTS.match.path));
      let body = readFileSync(found.file);
      let bridge = bridgePlan(key, work, url, body);
      const entertainmentCurrent = entertainmentMatches(body, work);
      const entertainmentSettings = entertainmentOptions(work, body);
      const arenaCamera = !target.draft && key[0] !== 'm' &&
        (url.searchParams.getAll('aob').includes('arena-scene') ||
          (url.searchParams.get('face') === 'arena' && url.searchParams.getAll('aob').includes('bridge')));
      if (arenaCamera && apexDocument(body)) {
        const asset = resolveInside(target.dir, APEX_ASSET);
        if (asset && adaptApexCamera(readFileSync(asset.file))) {
          body = adaptApexDocument(body);
          bridge ??= [bridgeTags(null, false)];
        }
      }
      if (arenaCamera && tesseraDocument(body)) {
        const asset = resolveInside(target.dir, TESSERA_ASSET);
        if (asset && adaptTesseraCamera(readFileSync(asset.file))) {
          body = adaptTesseraDocument(body);
          bridge ??= [bridgeTags(null, false)];
        }
      }
      if (arenaCamera && entertainmentCurrent) {
        body = entertainmentDocument(body, work, pathname);
        bridge ??= [bridgeTags(null, false)];
        head.push('<script>window.__AOB_ENTERTAINMENT__=' + JSON.stringify(entertainmentSettings) + '</script>');
      }
      if (bridge) {
        body = rewriteImportmap(body, pathname);
        head.push(...bridge);
      }
      if (stageParent) {
        if (arenaCamera && entertainmentCurrent) body = stageRender(body);
        const paperWorks = { 'mechanical-keyboard': ['gpt-6-sol-high', 'mimo-v2.6-pro', 'gpt-6-astra-high', 'gpt-5.6-sol-max'], 'desk-lamp': ['gpt-6-sol-high', 'gpt-6-astra-high', 'gpt-6-sol-max', 'gpt-6-astra-max'] };
        const paper = entertainmentCurrent && !!paperWorks[work.taskId]?.includes(work.id);
        head.unshift('<script>window.__PLAYGROUND_ORIGIN__=' + JSON.stringify(stageParent) + ';window.__OBJECT_STAGE_CAMERA__=' + JSON.stringify(entertainmentCamera(work, readFileSync(found.file))) + ';window.__OBJECT_STAGE_PAPER__=' + JSON.stringify(paper) + '</script><script src="/__playground.js"></script>');
      }
      if (head.length) body = withHeadTags(body, head.join(''));
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    return streamFile(req, res, found, headers);
  }

  // Which bridge tags a document gets. Match sides restore the saved arena camera and
  // never capture (blind comparison stays pure). Public and preview documents restore a
  // saved camera when one exists; ?aob=bridge additionally enables capture for the admin
  // calibration panel, with ?face= picking which side's camera to start from.
  function bridgePlan(key, work, url, source) {
    if (!work || key[0] === 'd') return null;
    const cameraOf = (face) => {
      const camera = library.calibrationOf?.(work, face)?.camera ?? null;
      return camera && validCamera(camera) ? camera : null;
    };
    if (key[0] === 'm') {
      const camera = cameraOf('arena');
      return camera ? [bridgeTags(camera, false)] : null;
    }
    const capture = url.searchParams.getAll('aob').includes('bridge');
    const faceParam = url.searchParams.get('face');
    const face = faceParam === 'arena' || faceParam === 'gallery' ? faceParam : null;
    const entertainment = key[0] !== 'm' && (url.searchParams.getAll('aob').includes('arena-scene') || (capture && face === 'arena'));
    const camera = (entertainment ? entertainmentCamera(work, source) : null) ?? (face
      ? (cameraOf(face) ?? cameraOf(face === 'arena' ? 'gallery' : 'arena'))
      : (cameraOf('arena') ?? cameraOf('gallery')));
    return capture || camera ? [bridgeTags(camera, capture)] : null;
  }

  return async (req, res) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      return await serve(req, res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return errorPage(res, error.status, error.message, '请稍后从展厅重新打开作品。',
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      if (error.code === 'ERR_INVALID_URL') return errorPage(res, 400, '作品地址无效', '请求路径无法解析。');
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return errorPage(res, 404, '找不到文件', '作品资源已不可用。');
      console.error('Content request failed:', error);
      return errorPage(res, 500, '作品暂时不可用', '请稍后再试。');
    }
  };
}
