import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpError, createRouter, parseCookies, readJson, resolveInside, streamFile } from '../server/http.mjs';
import { drainServers } from '../server/shutdown.mjs';

test('parseCookies skips malformed values and keeps valid cookies', () => {
  assert.deepEqual(parseCookies('first=hello%20world; broken=%E0%A4%A; last=yes'), { first: 'hello world', last: 'yes' });
});

test('malformed route parameter encoding returns a 400 error', () => {
  const router = createRouter();
  router.on('GET', '/api/works/:id', () => ({}));
  assert.throws(() => router.match('GET', '/api/works/%E0%A4%A'), (error) => error instanceof HttpError && error.status === 400);
});

test('JSON bodies must be objects', async () => {
  for (const value of ['null', '[]', '42', '"text"']) {
    const req = Readable.from([Buffer.from(value)]);
    req.headers = { 'content-type': 'application/json' };
    await assert.rejects(readJson(req), (error) => error.status === 400);
  }
  const req = Readable.from([Buffer.from('{"ok":true}')]);
  req.headers = { 'content-type': 'application/json' };
  assert.deepEqual(await readJson(req), { ok: true });
});

test('a vanished file returns 404 without crashing the server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-race-'));
  const file = join(root, 'file.txt');
  writeFileSync(file, 'demo');
  const found = resolveInside(root, '/file.txt');
  const server = createServer((req, res) => {
    const pending = streamFile(req, res, found);
    unlinkSync(file);
    return pending;
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 404);
  } finally {
    server.closeAllConnections();
    await drainServers([server]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown closes a response that never ends once the grace period passes', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n'); })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const reader = response.body.getReader();
  await reader.read();
  const started = Date.now();
  await drainServers([server], { forceAfterMs: 100 });
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(async () => { for (;;) if ((await reader.read()).done) return; });
});

test('shutdown waits for an active HTTP response', async () => {
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const server = createServer((req, res) => {
    started();
    setTimeout(() => res.end('done'), 50);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Connection: 'close' } });
  await began;
  let drained = false;
  const closing = drainServers([server]).then(() => { drained = true; });
  assert.equal(drained, false);
  assert.equal(await (await request).text(), 'done');
  await closing;
  assert.equal(drained, true);
});
