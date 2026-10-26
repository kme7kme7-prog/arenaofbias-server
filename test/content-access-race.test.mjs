import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createContentHandler } from '../server/content.mjs';

const key = prefix => prefix + 'a'.repeat(32);
const bytes = Buffer.from('private work asset');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'content-access-race-'));
  writeFileSync(join(root, 'asset.bin'), bytes);
  const state = { active: true, eligible: true, work: { dir: root, entry: 'index.html' }, mutate: null };
  const lookup = () => {
    const work = state.active ? state.work : null;
    // The first lookup succeeds, then the capability changes while the real
    // filesystem open is pending. No timers, fake streams or production writes.
    if (state.mutate) {
      const mutate = state.mutate;
      state.mutate = null;
      queueMicrotask(mutate);
    }
    return work;
  };
  const server = createServer(createContentHandler({
    config: { contentPathOrigin: 'http://content.example.test', cdn: [] },
    siteOrigins: ['http://site.example.test'],
    library: { draftByToken: lookup, previewByKey: lookup, isEligible: work => Boolean(work) && state.eligible },
    arena: { workForToken: lookup }, qualification: { workForToken: lookup },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const read = (prefix, method = 'GET', fixed = true) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, method,
      path: fixed ? `/c/${key(prefix)}/asset.bin` : '/asset.bin',
      headers: { Host: fixed ? 'content.example.test' : `${key(prefix)}.legacy.test`, 'If-None-Match': '*', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { state, read };
}

function denied(response) {
  assert.equal(response.status, 410);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.body.includes(bytes), false, 'revoked capability must not send old file bytes');
}

test('private streamed assets recheck expired draft, preview, match and exam capabilities after opening', async t => {
  const f = await fixture(t);
  for (const prefix of ['d', 'p', 'm', 'e']) for (const fixed of [true, false]) for (const method of ['GET', 'HEAD']) {
    f.state.active = true;
    f.state.mutate = () => { f.state.active = false; };
    denied(await f.read(prefix, method, fixed));
  }
});

test('private match and exam assets recheck eligibility after opening', async t => {
  const f = await fixture(t);
  for (const prefix of ['m', 'e']) {
    f.state.eligible = true;
    f.state.mutate = () => { f.state.eligible = false; };
    denied(await f.read(prefix));
  }
});

test('private streamed assets cannot send bytes from a replaced capability target', async t => {
  const f = await fixture(t);
  const original = f.state.work;
  for (const prefix of ['d', 'p', 'm', 'e']) for (const field of ['dir', 'entry']) {
    f.state.work = original;
    f.state.mutate = () => { f.state.work = { ...original, [field]: `${original[field]}-changed` }; };
    denied(await f.read(prefix));
  }
});

test('unchanged private assets preserve GET, HEAD, CSP and no-store without validators', async t => {
  const f = await fixture(t);
  for (const prefix of ['d', 'p', 'm', 'e']) for (const fixed of [true, false]) {
    const get = await f.read(prefix, 'GET', fixed);
    const head = await f.read(prefix, 'HEAD', fixed);
    assert.equal(get.status, 200); assert.deepEqual(get.body, bytes);
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    for (const response of [get, head]) {
      assert.equal(Number(response.headers['content-length']), bytes.length);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers.etag, undefined);
      assert.match(response.headers['content-security-policy'], /sandbox/);
    }
    assert.equal(head.headers['content-security-policy'], get.headers['content-security-policy']);
  }
});
