import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSharedJson } from '../server/catalog-response.mjs';

test('a withdrawal during compression cannot send an old shared body or validator', async () => {
  let revision = 0, finish;
  const handler = createSharedJson({ strict: () => revision,
    read: () => ({ works: revision ? [] : ['withdrawn work'], padding: 'x'.repeat(2048) }), cacheControl: 'private, no-cache' });
  const { entry } = await handler.current();
  // Hold the asynchronous representation build at the same boundary as node:zlib.
  entry.variants.set('gzip', new Promise(resolve => { finish = resolve; }));
  const req = { method: 'GET', headers: { 'accept-encoding': 'gzip' } };
  let status, headers, body;
  const response = handler(req, { getHeader() {}, writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } });
  await Promise.resolve();
  revision++;
  finish(gzipSync(entry.body));
  await response;
  assert.equal(status, 200);
  const current = gunzipSync(body);
  assert.deepEqual(JSON.parse(current).works, []);
  assert.equal(headers.ETag, `"${createHash('sha256').update(current).digest('hex')}-gzip"`);
  assert.notEqual(headers.ETag, `"${entry.hash}-gzip"`);
});

test('a failed compressor cannot fall back to shared JSON withdrawn while it was pending', async () => {
  let revision = 0, rejectCompression;
  const handler = createSharedJson({ strict: () => revision,
    read: () => ({ works: revision ? [] : ['withdrawn work'], padding: 'x'.repeat(2048) }), cacheControl: 'public, no-cache' });
  const { entry } = await handler.current();
  entry.variants.set('gzip', new Promise((_, reject) => { rejectCompression = reject; }));
  const req = { method: 'GET', headers: { 'accept-encoding': 'gzip', 'if-none-match': '"unrelated"' } };
  let body;
  const response = handler(req, { getHeader() {}, writeHead(code) { assert.equal(code, 200); }, end(value) { body = value; } });
  await Promise.resolve();
  revision++;
  rejectCompression(new Error('temporary compressor failure'));
  await response;
  assert.deepEqual(JSON.parse(gunzipSync(body)).works, []);
});
