// Small HTTP toolkit shared by the platform and content servers: errors, JSON, bodies,
// cookies, a pattern router, rate limits and safe static file responses.
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) fail(413, `内容超过 ${formatBytes(limit)} 上限`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, `内容超过 ${formatBytes(limit)} 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 64 * 1024) {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) fail(415, '请求格式无效');
  try {
    const body = JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) fail(400, '请求内容必须是对象');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, '请求内容无法解析');
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
      catch { /* Skip malformed cookies without losing the remaining valid ones. */ }
    }
  }
  return cookies;
}

export function uniqueCookie(header = '', name) {
  let value;
  let count = 0;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    if (++count > 1) return null;
    try { value = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { return null; }
  }
  return value ?? null;
}

export function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || 'unknown';
  // TRUST_PROXY covers one local reverse proxy. It appends the actual client IP;
  // any prefix supplied by the client must not become a rate-limit identity.
  const localProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const forwarded = trustProxy && localProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim() : '';
  return isIP(forwarded) ? forwarded : remote;
}

// Trust complete origins, including their scheme and port. Proxy headers affect the
// local origin only when the operator has explicitly enabled TRUST_PROXY.
export function isTrustedOrigin(req, { siteOrigins = [], trustProxy = false } = {}) {
  const origin = req.headers.origin;
  try { if (new URL(origin).origin !== origin) return false; } catch { return false; }
  if (siteOrigins.includes(origin)) return true;
  const protocol = trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.socket.encrypted ? 'https' : 'http';
  return origin === `${protocol}://${req.headers.host}`;
}

export function assertSameOrigin(req, config) {
  if (!isTrustedOrigin(req, config)) fail(403, '请求来源无效');
}

export function createRouter() {
  const routes = [];
  return {
    on(method, pattern, handler) {
      const keys = [];
      const source = pattern.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; });
      routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    },
    match(method, path) {
      let allowed = false;
      for (const route of routes) {
        const found = route.regex.exec(path);
        if (!found) continue;
        if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) { allowed = true; continue; }
        const params = {};
        route.keys.forEach((key, i) => {
          try { params[key] = decodeURIComponent(found[i + 1]); }
          catch { fail(400, '路径参数编码无效'); }
        });
        return { handler: route.handler, params };
      }
      return allowed ? { methodNotAllowed: true } : null;
    },
  };
}

// Fixed-window counters per key; enough to blunt scripted abuse on a single server.
export function rateLimit(windowMs, max, message = '操作太频繁，请稍后再试', code = '') {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      hits.set(key, bucket);
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    if (bucket.count >= max) {
      const error = new HttpError(429, message, code);
      error.retryAfter = Math.ceil((bucket.reset - now) / 1000);
      throw error;
    }
    bucket.count++;
    // A caller reserving a delivery can refund it if delivery fails. Keep the original
    // bucket so a late failure never refunds a request in a newer window.
    let reserved = true;
    return () => { if (reserved) { bucket.count--; reserved = false; } };
  };
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8',
  '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.ktx2': 'image/ktx2', '.basis': 'application/octet-stream',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.csv': 'text/csv; charset=utf-8', '.sbox': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

// Resolves a URL path inside base without escaping it; directories map to index.html.
export function resolveInside(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const root = resolve(base);
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      const index = resolve(target, 'index.html');
      return statSync(index).isFile() ? { file: index, size: statSync(index).size } : null;
    }
    return stat.isFile() ? { file: target, size: stat.size } : null;
  } catch {
    return null;
  }
}

export async function streamFile(req, res, found, headers = {}) {
  const responseHeaders = {
    'Content-Type': MIME[extname(found.file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': found.size,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  try {
    const stream = createReadStream(found.file);
    await new Promise((resolve, reject) => {
      stream.once('open', resolve);
      stream.once('error', reject);
    });
    res.writeHead(200, responseHeaders);
    if (req.method === 'HEAD') { stream.destroy(); return res.end(); }
    await pipeline(stream, res);
  } catch (error) {
    if (!res.headersSent) return sendJson(res, 404, { error: '文件不存在' });
    res.destroy(error);
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
