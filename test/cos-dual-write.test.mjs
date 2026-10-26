import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  COS_OPS_ENV_FILE, aws4Authorization, buildCosPut, contentTypeForMedia, createCosMirror, installCosMirror,
  loadCosSettings, localCosEnvFile, mirrorPublicMedia, parseEnvFile, publicMediaKey, resetCosMirror,
} from '../server/cos-dual-write.mjs';

const CREDS = {
  COS_MEDIA_ACCESS_CONTROLLED: '1',
  COS_BUCKET: 'agi-1419403229',
  COS_REGION: 'ap-shanghai',
  COS_SECRET_ID: 'AKIDexample',
  COS_SECRET_KEY: 'secret-key-example',
};
const NO_FILE = { exists: () => false };

function logger() {
  const lines = { log: [], warn: [] };
  return { lines, log: { log: (message) => lines.log.push(message), warn: (message) => lines.warn.push(message) } };
}

function fakeRequest({ status = 200, statuses, error } = {}) {
  const calls = [];
  const request = (options, callback) => {
    const chunks = [];
    const req = {
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end() {
        const call = { options, body: Buffer.concat(chunks) };
        calls.push(call);
        if (error) {
          queueMicrotask(() => req.emit('error', Object.assign(new Error(error), { code: 'ECONNREFUSED' })));
          return;
        }
        const code = statuses ? statuses[calls.length - 1] : status;
        const res = {
          statusCode: code,
          resume() {},
          on(event, fn) {
            if (event === 'end') queueMicrotask(fn);
            return res;
          },
        };
        queueMicrotask(() => callback(res));
      },
      handlers: {},
      on(event, fn) { req.handlers[event] = fn; return req; },
      emit(event, value) { req.handlers[event]?.(value); },
      setTimeout() {},
      destroy(err) { req.handlers.error?.(err); },
    };
    return req;
  };
  return { request, calls };
}

test('public object keys mirror /media/<workId>/<file> and skip private names', () => {
  assert.equal(publicMediaKey('up-abcd1234', 'first.jpg'), 'media/up-abcd1234/first.jpg');
  assert.equal(publicMediaKey('up-abcd1234', 'mobile.jpg'), 'media/up-abcd1234/mobile.jpg');
  assert.equal(publicMediaKey('up-abcd1234', 'cover.webp'), 'media/up-abcd1234/cover.webp');
  assert.equal(publicMediaKey('up-abcd1234', 'cover-mgz3k1a2b3c4d5e6.png'), 'media/up-abcd1234/cover-mgz3k1a2b3c4d5e6.png');
  assert.equal(publicMediaKey('up-abcd1234', 'first-mgz3k1a2b3c4d5e6.jpg'), 'media/up-abcd1234/first-mgz3k1a2b3c4d5e6.jpg');
  assert.equal(publicMediaKey('up-abcd1234', 'preview.sbox'), 'media/up-abcd1234/preview.sbox');
  assert.equal(publicMediaKey('up-abcd1234', 'preview-mgz3k1a2b3c4d5e6.sbox'), 'media/up-abcd1234/preview-mgz3k1a2b3c4d5e6.sbox');
  assert.equal(publicMediaKey('up-abcd1234', 'preview.webp'), 'media/up-abcd1234/preview.webp');
  assert.equal(publicMediaKey('up-abcd1234', 'preview.jpg'), 'media/up-abcd1234/preview.jpg');
  for (const name of ['first-late.jpg', 'mobile-late.jpg', 'recheck-first.jpg', 'preview.json', 'preview-mgz3k1a2b3c4d5e6.json', 'baseline.json', 'history/first.jpg', '../first.jpg', 'first.jpg?v=abc']) {
    assert.equal(publicMediaKey('up-abcd1234', name), null, name);
  }
  assert.equal(publicMediaKey('up-ABCD1234', 'first.jpg'), null);
  assert.equal(publicMediaKey('../media', 'first.jpg'), null);
  assert.equal(contentTypeForMedia('preview.sbox'), 'application/octet-stream');
  assert.equal(contentTypeForMedia('cover.png'), 'image/png');
});

test('SigV4 matches the AWS GET example', () => {
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const signed = aws4Authorization({
    method: 'GET',
    path: '/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash,
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    amzDate: '20130524T000000Z',
  });
  assert.equal(signed.canonical, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    payloadHash,
  ].join('\n'));
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('a successful put is not awaited by the caller and uses the public key', async () => {
  let release;
  const calls = [];
  const request = (options, callback) => {
    const chunks = [];
    return {
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end() { calls.push({ options, body: Buffer.concat(chunks) }); },
      on() { return this; },
      setTimeout() {},
      destroy() {},
      finish() {
        const res = { statusCode: 200, resume() {}, on(event, fn) { if (event === 'end') fn(); return res; } };
        callback(res);
      },
    };
  };
  const wrapped = (options, callback) => {
    const req = request(options, callback);
    release = () => req.finish();
    return req;
  };
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request: wrapped, log, retryDelays: [0, 0, 0], now: () => new Date('2026-10-25T00:00:00Z') });
  let returned = false;
  mirror.put({ workId: 'up-abcd1234', name: 'first.jpg', body: Buffer.from('jpeg-bytes') });
  returned = true;
  assert.equal(returned, true);
  assert.equal(calls.length, 1);
  let settled = false;
  const done = mirror.settled().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const call = calls[0];
  assert.equal(call.options.method, 'PUT');
  assert.equal(call.options.hostname, 'agi-1419403229.cos.ap-shanghai.myqcloud.com');
  assert.equal(call.options.path, '/media/up-abcd1234/first.jpg');
  assert.equal(call.options.headers['Content-Type'], 'image/jpeg');
  assert.equal(call.body.toString(), 'jpeg-bytes');
  assert.match(call.options.headers.Authorization, /Credential=AKIDexample\/20261025\/ap-shanghai\/s3\/aws4_request/);
  assert.match(call.options.headers.Authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  release();
  await done;
  assert.equal(settled, true);
  assert.deepEqual(lines.log, ['COS dual-write ok media/up-abcd1234/first.jpg 10B']);
  assert.deepEqual(lines.warn, []);
});

test('missing credentials skip the put and do not throw', async () => {
  const http = fakeRequest();
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: { COS_REGION: 'ap-shanghai', COS_MEDIA_ACCESS_CONTROLLED: '1' }, ...NO_FILE, request: http.request, log, retryDelays: [0, 0, 0] });
  assert.equal(mirror.settings.ready, false);
  assert.doesNotThrow(() => mirror.put({ workId: 'up-abcd1234', name: 'cover.png', body: Buffer.from('png') }));
  mirror.put({ workId: 'up-abcd1234', name: 'cover.png', body: Buffer.from('png') });
  await mirror.settled();
  assert.equal(http.calls.length, 0);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /COS dual-write skipped/);
  assert.match(lines.warn[0], /COS_BUCKET/);
  assert.match(lines.warn[0], /COS_SECRET_ID/);
  assert.match(lines.warn[0], /COS_SECRET_KEY/);
  assert.doesNotMatch(lines.warn[0], /secret-key/);
});

test('credentials alone cannot publish mutable media without an access-controlled CDN', async () => {
  const http = fakeRequest({ status: 200 });
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: { ...CREDS, COS_MEDIA_ACCESS_CONTROLLED: undefined }, ...NO_FILE, request: http.request, log, retryDelays: [] });
  mirror.put({ workId: 'up-abcd1234', name: 'preview.sbox', body: Buffer.from('sbox') });
  await mirror.settled();
  assert.equal(http.calls.length, 0);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /authorization on every read/);
});

test('put failures retry and do not reject the caller', async () => {
  const http = fakeRequest({ statuses: [503, 500, 403, 500] });
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request: http.request, log, retryDelays: [0, 0, 0] });
  const returned = mirror.put({ workId: 'up-abcd1234', name: 'preview.sbox', body: Buffer.from('model') });
  assert.equal(returned, undefined);
  await mirror.settled();
  assert.equal(http.calls.length, 4);
  assert.equal(http.calls[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(http.calls[0].options.path, '/media/up-abcd1234/preview.sbox');
  assert.equal(lines.log.length, 0);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /COS dual-write failed media\/up-abcd1234\/preview\.sbox after 4 attempts: HTTP 500/);
});

test('a network error retries without escaping the caller', async () => {
  const http = fakeRequest({ error: 'connect ECONNREFUSED' });
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request: http.request, log, retryDelays: [0, 0, 0] });
  assert.doesNotThrow(() => {
    installCosMirror(mirror);
    mirrorPublicMedia({ workId: 'up-abcd1234', name: 'mobile.jpg', file: 'ignored', body: Buffer.from('phone') });
  });
  await mirror.settled();
  assert.equal(http.calls.length, 4);
  assert.match(lines.warn.at(-1), /ECONNREFUSED/);
  resetCosMirror();
});

test('env wins over the ops cos.env, which wins over a relative cos.env', () => {
  const parsed = parseEnvFile('# comment\nexport COS_BUCKET=from-file\nCOS_SECRET_ID="id-1"\nCOS_SECRET_KEY=\'key-1\'\nCOS_REGION=ap-shanghai\n');
  assert.equal(parsed.COS_BUCKET, 'from-file');
  assert.equal(parsed.COS_SECRET_ID, 'id-1');
  assert.equal(parsed.COS_SECRET_KEY, 'key-1');
  const ops = COS_OPS_ENV_FILE;
  const local = localCosEnvFile();
  const reads = [];
  const settings = loadCosSettings({ COS_BUCKET: 'agi-1419403229' }, {
    exists: (path) => path === ops || path === local,
    readFile: (path) => {
      reads.push(path);
      return path === ops
        ? 'COS_BUCKET=from-ops\nCOS_REGION=ap-shanghai\nCOS_SECRET_ID=ops-id\nCOS_SECRET_KEY=ops-key\n'
        : 'COS_BUCKET=from-local\nCOS_SECRET_ID=local-id\nCOS_SECRET_KEY=local-key\n';
    },
  });
  assert.deepEqual(reads, [ops]);
  assert.equal(settings.ready, true);
  assert.equal(settings.bucket, 'agi-1419403229');
  assert.equal(settings.region, 'ap-shanghai');
  assert.equal(settings.secretId, 'ops-id');
  assert.equal(settings.secretKey, 'ops-key');
  const localOnly = loadCosSettings({}, {
    exists: (path) => path === local,
    readFile: () => 'COS_BUCKET=agi-1419403229\nCOS_SECRET_ID=local-id\nCOS_SECRET_KEY=local-key\n',
  });
  assert.equal(localOnly.ready, true);
  assert.equal(localOnly.region, 'ap-shanghai');
  assert.equal(localOnly.secretId, 'local-id');
  assert.equal(localOnly.filePath, local);
  const built = buildCosPut({
    bucket: settings.bucket, region: settings.region, secretId: settings.secretId, secretKey: settings.secretKey,
    key: 'media/up-abcd1234/cover.jpg', body: Buffer.from('x'), contentType: 'image/jpeg',
    now: new Date('2026-10-25T00:00:00Z'),
  });
  assert.equal(built.hostname, 'agi-1419403229.cos.ap-shanghai.myqcloud.com');
  assert.equal(built.path, '/media/up-abcd1234/cover.jpg');
  const bad = loadCosSettings({}, { ...NO_FILE, fileText: 'COS_BUCKET=not a bucket\nCOS_SECRET_ID=sid\nCOS_SECRET_KEY=skey\n' });
  assert.equal(bad.ready, false);
  assert.ok(bad.missing.includes('COS_BUCKET'));
});

test('capture-style file reads enqueue the bytes that landed on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-media-'));
  const file = join(root, 'first.jpg');
  writeFileSync(file, 'from-disk');
  const http = fakeRequest({ status: 200 });
  const { log } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request: http.request, log, retryDelays: [] });
  mirror.put({ workId: 'up-abcd1234', name: 'first.jpg', file });
  await mirror.settled();
  assert.equal(http.calls[0].body.toString(), 'from-disk');
  rmSync(root, { recursive: true, force: true });
});

test('mirrorPublicMedia ignores a throwing mirror and private filenames', () => {
  let calls = 0;
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  installCosMirror({ put() { calls += 1; throw new Error('boom'); } });
  try {
    assert.doesNotThrow(() => mirrorPublicMedia({ workId: 'up-abcd1234', name: 'first.jpg', body: Buffer.from('x') }));
    assert.doesNotThrow(() => mirrorPublicMedia({ workId: 'up-abcd1234', name: 'first-late.jpg', body: Buffer.from('late') }));
    assert.equal(calls, 1);
    assert.match(warnings[0], /COS dual-write skipped: boom/);
  } finally {
    console.warn = warn;
    resetCosMirror();
  }
});

test('a stalled COS response has a total deadline even when its socket stays active', async () => {
  let destroyed = 0;
  const request = () => ({
    write() {}, end() {}, on() { return this; }, setTimeout() {}, destroy() { destroyed++; },
  });
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request, log, timeoutMs: 20, retryDelays: [] });
  mirror.put({ workId: 'up-abcd1234', name: 'first.jpg', body: Buffer.from('image') });
  await mirror.settled();
  assert.equal(destroyed, 1);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /timed out/);
});

test('slow COS writes have bounded pending jobs and bytes and release their capacity', async () => {
  const completions = [];
  const request = (_, callback) => ({
    write() {}, on() { return this; }, setTimeout() {}, destroy() {},
    end() { completions.push(() => callback({ statusCode: 200, resume() {}, on(event, fn) { if (event === 'end') queueMicrotask(fn); return this; } })); },
  });
  const { log, lines } = logger();
  const mirror = createCosMirror({ env: CREDS, ...NO_FILE, request, log, maxPending: 2, maxPendingBytes: 6, retryDelays: [] });
  const put = (name, text) => mirror.put({ workId: 'up-abcd1234', name, body: Buffer.from(text) });
  put('first.jpg', 'aaa'); put('mobile.jpg', 'bbb'); put('cover.png', 'x');
  assert.equal(completions.length, 1, 'only one network write runs at a time');
  assert.match(lines.warn[0], /pending job limit/);
  completions.shift()(); await new Promise(setImmediate);
  assert.equal(completions.length, 1);
  completions.shift()(); await mirror.settled();
  put('preview.sbox', 'toolarge');
  assert.match(lines.warn[1], /pending byte limit/);
  put('cover.png', 'ok'); assert.equal(completions.length, 1);
  completions.shift()(); await mirror.settled();
  assert.equal(lines.log.length, 3);
});
