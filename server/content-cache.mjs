// Public work bytes may be kept by a browser, but never reused without a fresh
// access check. Shared caches and stale/offline responses remain disallowed.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { etagMatches } from './compress.mjs';
import { HttpError, MIME } from './http.mjs';

export const CONTENT_REVALIDATE = 'private, no-cache, max-age=0, must-revalidate';
const validator = hash => `W/"${hash}"`;

function unchanged(req, res, hash, headers) {
  if (!etagMatches(req.headers['if-none-match'], hash)) return false;
  // A 304 has no body; a Content-Length for the 200 representation must not be
  // copied here. CSP/CORS and the cache policy still apply to the cached bytes.
  const { 'Content-Length': length, ...rest } = headers;
  res.writeHead(304, { ...rest, ETag: validator(hash) });
  res.end();
  return true;
}

export function sendRevalidatedBody(req, res, body, headers) {
  const hash = createHash('sha256').update(body).digest('hex');
  if (unchanged(req, res, hash, headers)) return;
  res.writeHead(200, { ...headers, ETag: validator(hash), 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function streamRevalidatedFile(req, res, found, headers, stillAllowed) {
  const file = await open(found.file, 'r');
  try {
    const before = await file.stat();
    const hash = createHash('sha256');
    // Bound memory even for large models/videos. Keep the same file descriptor
    // for the fingerprint and response, including across an atomic replacement.
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new HttpError(503, '作品文件正在更新，请重试');
    // Hashing yields to I/O: a withdrawal during that read must beat both 304
    // and 200, rather than letting the browser reuse now-private content.
    if (!stillAllowed()) throw new HttpError(410, '作品已不可用');
    const responseHeaders = { ...headers, 'Content-Type': MIME[extname(found.file).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff' };
    const digest = hash.digest('hex');
    if (unchanged(req, res, digest, responseHeaders)) return;
    res.writeHead(200, { ...responseHeaders, ETag: validator(digest), 'Content-Length': after.size });
    if (req.method === 'HEAD') return res.end();
    await pipeline(file.createReadStream({ start: 0, autoClose: false }), res);
  } finally {
    await file.close();
  }
}
