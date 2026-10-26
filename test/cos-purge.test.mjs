import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CDN_PURGE_ACTION, buildCdnPurge, buildCosRequest, createCosMirror, installCosMirror, loadCosSettings,
  parseListBucket, purgeWorkMedia, remirrorWorkMedia, resetCosMirror, tc3Request, workMediaPrefix,
} from '../server/cos-dual-write.mjs';

const CREDS = { COS_BUCKET: 'agi-1419403229', COS_REGION: 'ap-shanghai', COS_SECRET_ID: 'AKIDexample', COS_SECRET_KEY: 'secret-key-example' };
const NO_FILE = { exists: () => false };

function logger() {
  const lines = { log: [], warn: [] };
  return { lines, log: { log: (message) => lines.log.push(message), warn: (message) => lines.warn.push(message) } };
}

function listXml(keys, { truncated = false, next } = {}) {
  const items = keys.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`).join('');
  return `<?xml version="1.0"?><ListBucketResult><Name>agi-1419403229</Name><IsTruncated>${truncated}</IsTruncated>${next ? `<NextMarker>${next}</NextMarker>` : ''}${items}</ListBucketResult>`;
}

// Mock fetch: answers COS list/delete and the CDN API by URL and method.
function fakeFetch({ pages, deleteStatus = () => 204, cdn = () => ({ Response: { TaskId: 'task-1', RequestId: 'r' } }) }) {
  const calls = [];
  let page = 0;
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const reply = (status, text) => ({ status, text: async () => text });
    const parsed = new URL(call.url);
    if (parsed.hostname === 'cdn.tencentcloudapi.com') return reply(200, JSON.stringify(cdn(JSON.parse(call.body))));
    if (call.method === 'GET') return reply(200, pages[Math.min(page++, pages.length - 1)]);
    if (call.method === 'DELETE') return reply(deleteStatus(decodeURIComponent(parsed.pathname.slice(1))), '');
    return reply(405, '');
  };
  return { fetch, calls };
}

const mirrorWith = (env, fetch, log, extra = {}) => createCosMirror({ env, ...NO_FILE, fetch, log, retryDelays: [], ...extra });

test('a removed work lists its prefix, deletes every object, then refreshes exactly those CDN URLs', async () => {
  const { lines, log } = logger();
  const { fetch, calls } = fakeFetch({ pages: [listXml([['media/up-abcd1234/first.jpg', 10], ['media/up-abcd1234/first-late.jpg', 20], ['media/up-abcd1234/preview.sbox', 30]])] });
  const mirror = mirrorWith(CREDS, fetch, log);
  assert.equal(mirror.purge('up-abcd1234'), undefined, 'fire-and-forget');
  await mirror.settled();

  const list = new URL(calls[0].url);
  assert.equal(list.hostname, 'agi-1419403229.cos.ap-shanghai.myqcloud.com');
  assert.equal(list.searchParams.get('prefix'), 'media/up-abcd1234/');
  assert.match(calls[0].headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDexample\/\d{8}\/ap-shanghai\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname);
  assert.deepEqual(deletes, ['/media/up-abcd1234/first.jpg', '/media/up-abcd1234/first-late.jpg', '/media/up-abcd1234/preview.sbox']);

  const cdnCalls = calls.filter((call) => call.url === 'https://cdn.tencentcloudapi.com/');
  assert.equal(cdnCalls.length, 1);
  assert.equal(cdnCalls[0].headers['X-TC-Action'], 'PurgeUrlsCache');
  assert.equal(cdnCalls[0].headers['X-TC-Version'], '2018-06-06');
  assert.match(cdnCalls[0].headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDexample\/\d{4}-\d{2}-\d{2}\/cdn\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(cdnCalls[0].body), { Urls: [
    'https://media.arenaofbias.icu/media/up-abcd1234/first.jpg',
    'https://media.arenaofbias.icu/media/up-abcd1234/first-late.jpg',
    'https://media.arenaofbias.icu/media/up-abcd1234/preview.sbox',
  ] });
  assert.ok(lines.log.some((line) => line.includes('deleted 3/3')));
  assert.ok(lines.log.some((line) => line.includes('CDN purge ok 3 urls task task-1')));
  assert.deepEqual(lines.warn, []);
});

test('only per-URL refresh exists: no directory or site-wide purge action anywhere', () => {
  assert.equal(CDN_PURGE_ACTION, 'PurgeUrlsCache');
  const source = readFileSync(new URL('../server/cos-dual-write.mjs', import.meta.url), 'utf8');
  assert.ok(!/PurgePathCache|PushUrlsCache|PurgeAll/.test(source.replace(/\/\/.*$/gm, '')));
  const built = buildCdnPurge({ secretId: 'id', secretKey: 'key', urls: ['https://media.arenaofbias.icu/media/up-abcd1234/first.jpg'], now: new Date(0) });
  assert.equal(built.headers['X-TC-Action'], 'PurgeUrlsCache');
  assert.deepEqual(Object.keys(JSON.parse(built.body)), ['Urls']);
});

test('listing pages follow NextMarker and keys outside the prefix are ignored', async () => {
  const { log } = logger();
  const { fetch, calls } = fakeFetch({ pages: [
    listXml([['media/up-abcd1234/a.jpg', 1]], { truncated: true, next: 'media/up-abcd1234/a.jpg' }),
    listXml([['media/up-abcd1234/b.jpg', 2], ['media/up-abcd12345/x.jpg', 3]]),
  ] });
  const mirror = mirrorWith(CREDS, fetch, log);
  mirror.purge('up-abcd1234');
  await mirror.settled();
  const lists = calls.filter((call) => call.method === 'GET').map((call) => new URL(call.url).searchParams.get('marker'));
  assert.deepEqual(lists, [null, 'media/up-abcd1234/a.jpg']);
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname), ['/media/up-abcd1234/a.jpg', '/media/up-abcd1234/b.jpg']);
});

test('failures are logged and never thrown; a failed delete is not refreshed on the CDN', async () => {
  const { lines, log } = logger();
  const { fetch, calls } = fakeFetch({
    pages: [listXml([['media/up-abcd1234/first.jpg', 1], ['media/up-abcd1234/cover.png', 2]])],
    deleteStatus: (key) => (key.endsWith('cover.png') ? 403 : 204),
    cdn: () => ({ Response: { Error: { Code: 'UnauthorizedOperation.CdnCamUnauthorized', Message: 'no permission' }, RequestId: 'r' } }),
  });
  const mirror = mirrorWith(CREDS, fetch, log);
  mirror.purge('up-abcd1234');
  await mirror.settled();
  const cdnBody = JSON.parse(calls.find((call) => call.url.startsWith('https://cdn.')).body);
  assert.deepEqual(cdnBody.Urls, ['https://media.arenaofbias.icu/media/up-abcd1234/first.jpg']);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 2, '403 is not retried');
  assert.ok(lines.warn.some((line) => line.includes('COS purge failed delete media/up-abcd1234/cover.png: HTTP 403')));
  assert.ok(lines.warn.some((line) => line.includes('CDN purge failed 1 urls: UnauthorizedOperation.CdnCamUnauthorized')));

  const broken = logger();
  const offline = mirrorWith(CREDS, async () => { throw new Error('ECONNRESET'); }, broken.log, { retryDelays: [0] });
  offline.purge('up-abcd1234');
  await offline.settled();
  assert.ok(broken.lines.warn.some((line) => line.includes('COS purge failed media/up-abcd1234/: list media/up-abcd1234/: ECONNRESET')));
});

test('switches: no credentials, COS_DELETE_ON_REMOVE=0 and MEDIA_CDN_PURGE_HOST=off', async () => {
  let fetched = 0;
  const counting = async () => { fetched++; throw new Error('must not fetch'); };
  const missing = logger();
  const unconfigured = mirrorWith({}, counting, missing.log);
  unconfigured.purge('up-abcd1234');
  await unconfigured.settled();
  assert.equal(fetched, 0);
  assert.match(missing.lines.warn[0], /COS dual-write skipped: 缺少 COS_BUCKET/);

  const disabled = mirrorWith({ ...CREDS, COS_DELETE_ON_REMOVE: '0' }, counting, logger().log);
  disabled.purge('up-abcd1234');
  await disabled.settled();
  assert.equal(fetched, 0);

  const bogus = mirrorWith(CREDS, counting, logger().log);
  for (const id of ['../x', 'up-ABCD1234', '', null]) bogus.purge(id);
  await bogus.settled();
  assert.equal(fetched, 0, 'only up-<8> ids form a prefix');

  const { fetch, calls } = fakeFetch({ pages: [listXml([['media/up-abcd1234/first.jpg', 1]])] });
  const noCdn = mirrorWith({ ...CREDS, MEDIA_CDN_PURGE_HOST: 'off' }, fetch, logger().log);
  noCdn.purge('up-abcd1234');
  await noCdn.settled();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.ok(!calls.some((call) => call.url.startsWith('https://cdn.')));

  assert.equal(loadCosSettings(CREDS, NO_FILE).cdnPurgeHost, 'media.arenaofbias.icu');
  assert.equal(loadCosSettings({ ...CREDS, MEDIA_CDN_PURGE_HOST: 'Img.Example.com' }, NO_FILE).cdnPurgeHost, 'img.example.com');
  assert.equal(loadCosSettings(CREDS, NO_FILE).deleteOnRemove, true);
});

test('purge waits behind queued puts for the same work', async () => {
  const order = [];
  const request = (options, callback) => {
    const req = { on() { return req; }, setTimeout() {}, write() {}, end() {
      order.push(`put ${options.path}`);
      const res = { statusCode: 200, resume() {}, on(event, fn) { if (event === 'end') queueMicrotask(fn); return res; } };
      queueMicrotask(() => callback(res));
    } };
    return req;
  };
  const fetch = async (url, init) => {
    order.push(`${init.method} ${new URL(url).pathname}`);
    return { status: init.method === 'GET' ? 200 : 204, text: async () => (init.method === 'GET' ? listXml([['media/up-abcd1234/first.jpg', 1]]) : '') };
  };
  const mirror = mirrorWith({ ...CREDS, COS_MEDIA_ACCESS_CONTROLLED: '1', MEDIA_CDN_PURGE_HOST: 'off' }, fetch, logger().log, { request });
  mirror.put({ workId: 'up-abcd1234', name: 'first.jpg', body: Buffer.from('x') });
  mirror.purge('up-abcd1234');
  await mirror.settled();
  assert.deepEqual(order, ['put /media/up-abcd1234/first.jpg', 'GET /', 'DELETE /media/up-abcd1234/first.jpg']);
});

test('signed COS GET/DELETE and TC3 follow their documented canonical forms', () => {
  const now = new Date('2026-10-26T06:00:00Z');
  const list = buildCosRequest({ ...{ bucket: 'b-1', region: 'ap-shanghai', secretId: 'id', secretKey: 'key' }, method: 'GET', query: { prefix: 'media/up-abcd1234/', 'max-keys': '1000' }, now });
  assert.equal(list.url, 'https://b-1.cos.ap-shanghai.myqcloud.com/?max-keys=1000&prefix=media%2Fup-abcd1234%2F');
  assert.equal(list.signed.canonical.split('\n').slice(0, 3).join('|'), 'GET|/|max-keys=1000&prefix=media%2Fup-abcd1234%2F');
  const del = buildCosRequest({ bucket: 'b-1', region: 'ap-shanghai', secretId: 'id', secretKey: 'key', method: 'DELETE', key: 'media/up-abcd1234/first.jpg', now });
  assert.equal(del.url, 'https://b-1.cos.ap-shanghai.myqcloud.com/media/up-abcd1234/first.jpg');

  const t = tc3Request({ secretId: 'id', secretKey: 'key', service: 'cdn', host: 'cdn.tencentcloudapi.com', action: 'PurgeUrlsCache', version: '2018-06-06', payload: { Urls: ['u'] }, timestamp: 1792994400 });
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  assert.equal(t.canonical, `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:cdn.tencentcloudapi.com\n\ncontent-type;host\n${hash('{"Urls":["u"]}')}`);
  assert.equal(t.stringToSign, `TC3-HMAC-SHA256\n1792994400\n2026-10-26/cdn/tc3_request\n${hash(t.canonical)}`);
  const h = (k, d) => createHmac('sha256', k).update(d).digest();
  const expected = createHmac('sha256', h(h(h('TC3key', '2026-10-26'), 'cdn'), 'tc3_request')).update(t.stringToSign).digest('hex');
  assert.ok(t.headers.Authorization.endsWith(`Signature=${expected}`));
});

test('list XML parsing decodes entities and reports truncation', () => {
  const parsed = parseListBucket(listXml([['media/up-abcd1234/a&amp;b.jpg', 5]], { truncated: true }));
  assert.deepEqual(parsed, { objects: [{ key: 'media/up-abcd1234/a&b.jpg', size: 5 }], truncated: true, nextMarker: 'media/up-abcd1234/a&b.jpg' });
  assert.equal(workMediaPrefix('up-abcd1234'), 'media/up-abcd1234/');
  assert.equal(workMediaPrefix('a1'), null);
});

test('module helpers hand work to the installed mirror and never throw', () => {
  const seen = [];
  installCosMirror({ put: (spec) => seen.push(['put', spec.name]), purge: (id) => seen.push(['purge', id]) });
  const dir = mkdtempSync(join(tmpdir(), 'cos-remirror-'));
  try {
    for (const name of ['first.jpg', 'first-late.jpg', 'preview.sbox', 'manifest.json']) writeFileSync(join(dir, name), 'x');
    remirrorWorkMedia('up-abcd1234', dir);
    remirrorWorkMedia('up-abcd1234', join(dir, 'missing'));
    purgeWorkMedia('up-abcd1234');
    purgeWorkMedia('not-a-work');
    assert.deepEqual(seen.sort(), [['purge', 'up-abcd1234'], ['put', 'first.jpg'], ['put', 'preview.sbox']]);
    installCosMirror({ purge() { throw new Error('boom'); } });
    assert.doesNotThrow(() => purgeWorkMedia('up-abcd1234'));
  } finally {
    resetCosMirror();
    rmSync(dir, { recursive: true, force: true });
  }
});
