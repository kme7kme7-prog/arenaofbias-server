// Response compression for JSON. Bodies are compressed off the main thread with
// node:zlib; the Accept-Encoding header picks br or gzip. Nginx and EdgeOne pass
// an encoded response through instead of compressing it again.
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
export const MIN_COMPRESS_BYTES = 1024;

// The best of br and gzip the client accepts, or null. q=0 refuses; `*` stands for both.
export function pickEncoding(header = '') {
  const weights = new Map();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map((item) => item.trim());
    if (!name) continue;
    const q = params.find((item) => item.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weightOf = (name) => weights.get(name) ?? (weights.has('*') ? weights.get('*') : 0);
  const br = weightOf('br');
  const gz = Math.max(weightOf('gzip'), weights.has('x-gzip') ? weights.get('x-gzip') : 0);
  if (br > 0 && br >= gz) return 'br';
  if (gz > 0) return 'gzip';
  return null;
}

// br quality 5 is within 2% of quality 9 on the bootstrap body at under half the CPU.
export function compress(body, encoding) {
  if (encoding === 'br') {
    return brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
  }
  return gzipAsync(body, { level: 6 });
}

// Add a token to the Vary header already set on the response (CORS sets Origin).
export function withVary(res, token) {
  const current = String(res.getHeader?.('Vary') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!current.some((item) => item.toLowerCase() === token.toLowerCase() || item === '*')) current.push(token);
  return current.join(', ');
}

// One strong ETag per representation: "<hash>", "<hash>-br", "<hash>-gzip".
export const etagFor = (hash, encoding) => `"${hash}${encoding ? `-${encoding}` : ''}"`;

// A validator matches the content whatever encoding it was issued with; nginx may also weaken it.
export function etagMatches(header, hash) {
  return String(header ?? '').split(',').some((value) => {
    const tag = value.trim().replace(/^W\//, '');
    if (tag === '*') return true;
    const bare = tag.replace(/^"|"$/g, '').replace(/-(?:br|gzip)$/, '');
    return bare === hash;
  });
}
