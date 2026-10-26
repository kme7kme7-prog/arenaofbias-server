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
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

export function publicMediaKey(workId, name) {
  if (!WORK_ID.test(workId ?? '') || !PUBLIC_FILE.test(name ?? '')) return null;
  return `media/${workId}/${name}`;
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
  return {
    ready: missing.length === 0,
    bucket, region, secretId, secretKey, service: SIGN_SERVICE,
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

  function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) {
      settle();
      return;
    }
    running = true;
    send(job).finally(() => {
      pending -= 1;
      pendingBytes -= job.body.length;
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
        queue.push({ key, body, contentType: contentTypeForMedia(spec.name) });
        pump();
      } catch (error) {
        log.warn(`COS dual-write skipped: ${brief(error)}`);
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
