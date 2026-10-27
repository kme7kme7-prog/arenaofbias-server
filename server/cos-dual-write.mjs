// Async dual-write of new public upload media to Tencent COS.
//
// Disk layout is DATA_DIR/media/<workId>/<file>. The public URL path on the API
// host is /media/<workId>/<file>. The COS object key is that path without the
// leading slash: media/<workId>/<file>. Query strings such as ?v= are not part
// of the key. Only names the site actually serves under /media/<workId>/ are
// uploaded, so review-only shots, manifests, and history snapshots stay on the
// origin.
//
// PutObject uses the public AWS Signature Version 4 algorithm (original code,
// not a copy of the AWS SDK or cos-nodejs-sdk). The credential scope service is
// s3, which is what S3-compatible clients send to COS. The host is
// <bucket>.cos.<region>.myqcloud.com. Credentials are COS_BUCKET, COS_REGION,
// COS_SECRET_ID and COS_SECRET_KEY from the environment, or from
// /root/.config/arenaofbias/cos.env, or from ./cos.env beside this repo.
// A missing secret is logged once and never thrown to the upload or capture.
//
// Removal: when a work is deleted, rejected, or swept as an orphan, purgeWorkMedia
// lists media/<workId>/ in the bucket, deletes each object (DeleteObject), then asks
// Tencent Cloud CDN to refresh exactly those object URLs on MEDIA_CDN_PURGE_HOST with
// PurgeUrlsCache (TC3-HMAC-SHA256). Only per-URL refresh is ever sent: never a directory
// or site-wide refresh. Failures are logged and never block removal.
// COS_DELETE_ON_REMOVE=0 turns removal off; MEDIA_CDN_PURGE_HOST=off skips the CDN step.
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COS_OPS_ENV_FILE = '/root/.config/arenaofbias/cos.env';
const SIGN_SERVICE = 's3';
const WORK_ID = /^up-[a-z0-9]{8}$/;
// Same filename whitelist as the /media/<workId>/ route in server/app.mjs.
const PUBLIC_FILE = /^(?:cover(?:-[a-z0-9]{8,24})?\.(?:png|jpg|webp)|first(?:-[a-z0-9]{8,24})?\.jpg|mobile(?:-[a-z0-9]{8,24})?\.jpg|preview\.(?:sbox|webp|jpg)|preview-[a-z0-9]{8,24}\.(?:sbox|webp))$/;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.sbox': 'application/octet-stream' };
const RETRY_DELAYS = [500, 2000, 8000];
export const DEFAULT_CDN_PURGE_HOST = 'media.arenaofbias.icu';
const CDN_API_HOST = 'cdn.tencentcloudapi.com';
// The only CDN action this module sends. Directory and site-wide refreshes are not allowed.
export const CDN_PURGE_ACTION = 'PurgeUrlsCache';
const CDN_API_VERSION = '2018-06-06';
const CDN_URLS_PER_CALL = 100;

export function publicMediaKey(workId, name) {
  if (!WORK_ID.test(workId ?? '') || !PUBLIC_FILE.test(name ?? '')) return null;
  return `media/${workId}/${name}`;
}

// Every object of one work lives under this prefix (dual-write keys and the earlier bulk sync alike).
export function workMediaPrefix(workId) {
  return WORK_ID.test(workId ?? '') ? `media/${workId}/` : null;
}

export function contentTypeForMedia(name) {
  const dot = name.lastIndexOf('.');
  return TYPES[dot >= 0 ? name.slice(dot) : ''] ?? 'application/octet-stream';
}

export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function localCosEnvFile() {
  return join(ROOT, 'cos.env');
}

// Ops file first, then ./cos.env. The first one that exists wins; they are not merged.
function readEnvFile({ readFile = readFileSync, exists = existsSync } = {}) {
  for (const candidate of [COS_OPS_ENV_FILE, localCosEnvFile()]) {
    let present = false;
    try { present = exists(candidate); } catch { present = false; }
    if (!present) continue;
    try {
      return { values: parseEnvFile(readFile(candidate, 'utf8')), path: candidate };
    } catch {
      return { values: {}, path: candidate, problem: `无法读取 ${candidate}` };
    }
  }
  return { values: {}, path: '' };
}

function pick(env, file, name) {
  const fromEnv = env[name];
  if (fromEnv != null && String(fromEnv) !== '') return String(fromEnv).trim();
  return (file[name] ?? '').trim();
}

function credential(value) {
  if (!value || /\s/.test(value)) return '';
  return value;
}

// Process environment wins for each key. Gaps are filled from the ops file or ./cos.env.
// Values are not copied back into process.env. COS_REGION defaults to ap-shanghai.
export function loadCosSettings(env = process.env, { fileText, readFile, exists } = {}) {
  const file = fileText != null ? { values: parseEnvFile(fileText), path: '' } : readEnvFile({ readFile, exists });
  const bucket = pick(env, file.values, 'COS_BUCKET');
  const region = (pick(env, file.values, 'COS_REGION') || 'ap-shanghai').toLowerCase();
  const secretId = credential(pick(env, file.values, 'COS_SECRET_ID'));
  const secretKey = credential(pick(env, file.values, 'COS_SECRET_KEY'));
  const missing = [];
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) missing.push('COS_BUCKET');
  if (!/^[a-z0-9-]{1,32}$/.test(region)) missing.push('COS_REGION');
  if (!secretId) missing.push('COS_SECRET_ID');
  if (!secretKey) missing.push('COS_SECRET_KEY');
  if (file.problem && missing.length) missing.push(file.problem);
  const deleteOnRemove = pick(env, file.values, 'COS_DELETE_ON_REMOVE') !== '0';
  const purgeRaw = pick(env, file.values, 'MEDIA_CDN_PURGE_HOST');
  const purgeHost = purgeRaw === '' ? DEFAULT_CDN_PURGE_HOST : purgeRaw.toLowerCase();
  const cdnPurgeHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(purgeHost) ? purgeHost : '';
  return {
    ready: missing.length === 0,
    bucket, region, secretId, secretKey, service: SIGN_SERVICE,
    deleteOnRemove, cdnPurgeHost,
    missing, fileProblem: file.problem || '', filePath: file.path || '',
  };
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

export function encodeKey(key) {
  return String(key).split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

// headers: lowercase names. canonicalHeaders already ends with a newline, which
// supplies the blank line required between the headers and SignedHeaders.
export function aws4Authorization({ method, path, query = '', headers, payloadHash, accessKey, secret, region, service, amzDate }) {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim().replace(/ +/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = `${method}\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonical)}`;
  const signature = hmac(signingKey(secret, date, region, service), stringToSign).toString('hex');
  return {
    canonical,
    stringToSign,
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function amzDate(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function cosPutTarget({ bucket, region, key }) {
  const hostname = `${bucket}.cos.${region}.myqcloud.com`;
  return { hostname, port: 443, hostHeader: hostname, path: `/${encodeKey(key)}` };
}

export function buildCosPut({ bucket, region, secretId, secretKey, key, body, contentType, now = new Date() }) {
  const target = cosPutTarget({ bucket, region, key });
  const stamp = amzDate(now);
  const payloadHash = sha256Hex(body);
  const headers = {
    'content-type': contentType,
    host: target.hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  };
  const signed = aws4Authorization({
    method: 'PUT', path: target.path, headers, payloadHash,
    accessKey: secretId, secret: secretKey, region, service: SIGN_SERVICE, amzDate: stamp,
  });
  return {
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    headers: {
      Host: target.hostHeader,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      Authorization: signed.authorization,
    },
    signed,
  };
}

function encodeQueryPart(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(params = {}) {
  return Object.keys(params).sort().map((name) => `${encodeQueryPart(name)}=${encodeQueryPart(params[name])}`).join('&');
}

// Signed GET (bucket listing) or DELETE (one object) with an empty body.
export function buildCosRequest({ bucket, region, secretId, secretKey, method, key = '', query = {}, now = new Date() }) {
  const hostname = `${bucket}.cos.${region}.myqcloud.com`;
  const path = `/${key ? encodeKey(key) : ''}`;
  const queryString = canonicalQuery(query);
  const stamp = amzDate(now);
  const payloadHash = sha256Hex('');
  const headers = { host: hostname, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const signed = aws4Authorization({
    method, path, query: queryString, headers, payloadHash,
    accessKey: secretId, secret: secretKey, region, service: SIGN_SERVICE, amzDate: stamp,
  });
  return {
    method,
    url: `https://${hostname}${path}${queryString ? `?${queryString}` : ''}`,
    headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp, Authorization: signed.authorization },
    signed,
  };
}

function xmlText(value) {
  return value.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (all, name, dec, hex) => (
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
      : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name.toLowerCase()] ?? all));
}

export function parseListBucket(xml) {
  const text = String(xml ?? '');
  const objects = [];
  for (const [, block] of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const size = /<Size>(\d+)<\/Size>/.exec(block);
    if (key) objects.push({ key: xmlText(key[1]), size: size ? Number(size[1]) : 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(text);
  const next = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(text);
  return { objects, truncated, nextMarker: next ? xmlText(next[1]) : (objects.at(-1)?.key ?? '') };
}

// Tencent Cloud API 3.0 signature (TC3-HMAC-SHA256) for a JSON POST.
export function tc3Request({ secretId, secretKey, service, host, action, version, payload, timestamp }) {
  const body = JSON.stringify(payload);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\n${sha256Hex(body)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256Hex(canonical)}`;
  const key = hmac(hmac(hmac(`TC3${secretKey}`, date), service), 'tc3_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    url: `https://${host}/`,
    body,
    canonical,
    stringToSign,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'Content-Type': contentType,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
    },
  };
}

export function buildCdnPurge({ secretId, secretKey, urls, now = new Date() }) {
  return tc3Request({
    secretId, secretKey, service: 'cdn', host: CDN_API_HOST, action: CDN_PURGE_ACTION, version: CDN_API_VERSION,
    payload: { Urls: urls }, timestamp: Math.floor(now.getTime() / 1000),
  });
}

function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

function brief(error) {
  return String(error?.message || error || 'unknown').split('\n')[0].slice(0, 200);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCosMirror({
  env = process.env,
  fileText,
  readFile,
  exists,
  request = https.request,
  log = console,
  retryDelays = RETRY_DELAYS,
  timeoutMs = 20_000,
  now = () => new Date(),
  readBytes = readFileSync,
  maxPending = 64,
  maxPendingBytes = 64 * 1024 * 1024,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const settings = loadCosSettings(env, { fileText, readFile, exists });
  // File names do not imply public visibility. Only an operator who has put
  // current authorization checks in front of every CDN read may opt back in.
  const accessControlled = env.COS_MEDIA_ACCESS_CONTROLLED === '1';
  const queue = [];
  let running = false;
  let pending = 0;
  let pendingBytes = 0;
  const idle = [];
  let warned = false;

  function warnSkip() {
    if (warned) return;
    warned = true;
    const parts = settings.missing.length ? settings.missing.join('、') : '配置无效';
    log.warn(`COS dual-write skipped: 缺少 ${parts}。上传和截图仍会成功，不会写入 COS。请在环境变量或 ${COS_OPS_ENV_FILE}（或安装目录 cos.env）中配置 COS_BUCKET、COS_REGION、COS_SECRET_ID、COS_SECRET_KEY。`);
  }

  function settle() {
    if (pending === 0 && !running) {
      for (const resolve of idle.splice(0)) resolve();
    }
  }

  function bytesOf(spec, key) {
    const inline = asBuffer(spec.body);
    if (inline) return inline;
    if (typeof spec.file !== 'string' || !spec.file) {
      log.warn(`COS dual-write skipped ${key}: no bytes`);
      return null;
    }
    try {
      return readBytes(spec.file);
    } catch (error) {
      log.warn(`COS dual-write skipped ${key}: ${error.code || brief(error)}`);
      return null;
    }
  }

  function putOnce(job) {
      const built = buildCosPut({
      bucket: settings.bucket, region: settings.region,
      secretId: settings.secretId, secretKey: settings.secretKey,
      key: job.key, body: job.body, contentType: job.contentType, now: now(),
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(deadline); fn(value); } };
      let req;
      const deadline = setTimeout(() => {
        const error = Object.assign(new Error('COS put timed out'), { code: 'timeout' });
        finish(reject, error);
        req?.destroy(error);
      }, timeoutMs);
      try {
        req = request({
          protocol: 'https:',
          hostname: built.hostname,
          port: built.port,
          method: 'PUT',
          path: built.path,
          headers: built.headers,
          servername: built.hostname,
        }, (res) => {
          res.on('error', (error) => finish(reject, error));
          res.on('end', () => finish(resolve, res.statusCode || 0));
          if (typeof res.resume === 'function') res.resume();
        });
      } catch (error) {
        finish(reject, error);
        return;
      }
      req.on('error', (error) => finish(reject, error));
      if (typeof req.setTimeout === 'function') req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('COS put timed out'), { code: 'timeout' })));
      try {
        if (typeof req.write === 'function') req.write(job.body);
        req.end();
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function send(job) {
    const attempts = retryDelays.length + 1;
    let last = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const status = await putOnce(job);
        if (status >= 200 && status < 300) {
          log.log(`COS dual-write ok ${job.key} ${job.body.length}B`);
          return;
        }
        last = `HTTP ${status}`;
      } catch (error) {
        last = brief(error);
      }
      if (attempt < attempts) await wait(retryDelays[attempt - 1]);
    }
    log.warn(`COS dual-write failed ${job.key} after ${attempts} attempts: ${last}`);
  }

  async function call(build, what) {
    const attempts = retryDelays.length + 1;
    let last = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const req = build();
        const res = await fetchImpl(req.url, { method: req.method ?? 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        if (res.status >= 200 && res.status < 300) return text;
        last = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (error) {
        last = brief(error);
      }
      if (attempt < attempts) await wait(retryDelays[attempt - 1]);
    }
    throw new Error(`${what}: ${last}`);
  }

  const cosArgs = () => ({ bucket: settings.bucket, region: settings.region, secretId: settings.secretId, secretKey: settings.secretKey, now: now() });

  async function listWork(prefix) {
    const objects = [];
    let marker = '';
    for (let page = 0; page < 100; page++) {
      const query = { 'max-keys': '1000', prefix, ...(marker ? { marker } : {}) };
      const xml = await call(() => buildCosRequest({ ...cosArgs(), method: 'GET', query }), `list ${prefix}`);
      const result = parseListBucket(xml);
      objects.push(...result.objects.filter((item) => item.key.startsWith(prefix)));
      if (!result.truncated || !result.nextMarker || result.nextMarker === marker) break;
      marker = result.nextMarker;
    }
    return objects;
  }

  async function purgeCdn(keys) {
    if (!keys.length || !settings.cdnPurgeHost) return;
    const urls = keys.map((key) => `https://${settings.cdnPurgeHost}/${encodeKey(key)}`);
    for (let start = 0; start < urls.length; start += CDN_URLS_PER_CALL) {
      const batch = urls.slice(start, start + CDN_URLS_PER_CALL);
      try {
        const text = await call(() => buildCdnPurge({ secretId: settings.secretId, secretKey: settings.secretKey, urls: batch, now: now() }), CDN_PURGE_ACTION);
        let reply = {};
        try { reply = JSON.parse(text)?.Response ?? {}; } catch { reply = {}; }
        if (reply.Error) log.warn(`CDN purge failed ${batch.length} urls: ${reply.Error.Code ?? 'error'} ${String(reply.Error.Message ?? '').slice(0, 160)}`);
        else log.log(`CDN purge ok ${batch.length} urls task ${reply.TaskId ?? '?'}`);
      } catch (error) {
        log.warn(`CDN purge failed ${batch.length} urls: ${brief(error)}`);
      }
    }
  }

  async function removeWork(workId) {
    const prefix = workMediaPrefix(workId);
    let objects;
    try {
      objects = await listWork(prefix);
    } catch (error) {
      log.warn(`COS purge failed ${prefix}: ${brief(error)}`);
      return;
    }
    const removed = [];
    for (const { key } of objects) {
      try {
        await call(() => buildCosRequest({ ...cosArgs(), method: 'DELETE', key }), `delete ${key}`);
        removed.push(key);
      } catch (error) {
        log.warn(`COS purge failed ${brief(error)}`);
      }
    }
    log.log(`COS purge ${prefix}: deleted ${removed.length}/${objects.length} objects`);
    await purgeCdn(removed);
  }

  function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) {
      settle();
      return;
    }
    running = true;
    (job.type === 'purge' ? removeWork(job.workId) : send(job)).finally(() => {
      pending -= 1;
      if (job.type !== 'purge') pendingBytes -= job.body.length;
      running = false;
      pump();
    });
  }

  return {
    settings,
    put(spec) {
      try {
        const key = publicMediaKey(spec?.workId, spec?.name);
        if (!key) return;
        if (!accessControlled) {
          if (!warned) log.warn('COS dual-write disabled: uploaded media requires authorization on every read; configure gated CDN access before setting COS_MEDIA_ACCESS_CONTROLLED=1.');
          warned = true;
          return;
        }
        if (!settings.ready) {
          warnSkip();
          return;
        }
        if (pending >= maxPending) {
          log.warn(`COS dual-write skipped ${key}: pending job limit`);
          return;
        }
        const body = bytesOf(spec, key);
        if (!body) return;
        if (body.length > maxPendingBytes - pendingBytes) {
          log.warn(`COS dual-write skipped ${key}: pending byte limit`);
          return;
        }
        pending += 1;
        pendingBytes += body.length;
        queue.push({ type: 'put', key, body, contentType: contentTypeForMedia(spec.name) });
        pump();
      } catch (error) {
        log.warn(`COS dual-write skipped: ${brief(error)}`);
      }
    },
    // Queued behind earlier puts, so a capture that finished just before removal is deleted too.
    purge(workId) {
      try {
        if (!workMediaPrefix(workId)) return;
        if (!settings.ready) {
          warnSkip();
          return;
        }
        if (!settings.deleteOnRemove) return;
        pending += 1;
        queue.push({ type: 'purge', workId });
        pump();
      } catch (error) {
        log.warn(`COS purge skipped: ${brief(error)}`);
      }
    },
    settled() {
      if (pending === 0 && !running) return Promise.resolve();
      return new Promise((resolve) => idle.push(resolve));
    },
  };
}

let installed;
let shared;

export function installCosMirror(mirror) {
  installed = mirror;
  return mirror;
}

export function resetCosMirror() {
  installed = undefined;
  shared = undefined;
}

function activeMirror() {
  if (installed) return installed;
  if (!shared) shared = createCosMirror();
  return shared;
}

// Fire-and-forget. Never throws and never returns the put promise.
// Private names (late shots, manifests, history) return before the mirror runs.
export function mirrorPublicMedia(spec) {
  try {
    if (!publicMediaKey(spec?.workId, spec?.name)) return;
    activeMirror().put(spec);
  } catch (error) {
    console.warn(`COS dual-write skipped: ${brief(error)}`);
  }
}

// Fire-and-forget removal of every object under media/<workId>/ plus a per-URL CDN refresh.
export function purgeWorkMedia(workId) {
  try {
    if (!workMediaPrefix(workId)) return;
    activeMirror().purge(workId);
  } catch (error) {
    console.warn(`COS purge skipped: ${brief(error)}`);
  }
}

// Puts the public files still on disk back into COS (a rejected work reopened for review).
export function remirrorWorkMedia(workId, dir, list = readdirSync) {
  try {
    if (!workMediaPrefix(workId)) return;
    for (const name of list(dir)) if (publicMediaKey(workId, name)) mirrorPublicMedia({ workId, name, file: join(dir, name) });
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`COS dual-write skipped: ${brief(error)}`);
  }
}
