import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createModerationRelay } from '../scripts/moderation-relay.mjs';

test('review relay restricts credentials and Flex requests, preserving upstream responses', async (t) => {
  const received = [];
  let upstreamStatus = 200;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(upstreamStatus === 200 ? { status: 'completed', service_tier: 'flex' } : { error: { code: 'resource_unavailable' } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  const relay = createModerationRelay({ apiKey: 'test-key', request: (url, options, callback) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return request(upstreamUrl, options, callback);
  } });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([relay, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const base = `http://127.0.0.1:${relay.address().port}`;
  const payload = { model: 'gpt-6-luna', service_tier: 'flex', store: false, input: [{ role: 'user', content: 'safe fixture' }] };
  const send = (body, key = 'test-key') => fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
  });
  assert.equal((await send(JSON.stringify(payload), 'wrong-key')).status, 401);
  assert.equal((await send('{')).status, 400);
  assert.equal((await send(JSON.stringify({ ...payload, model: 'other-model' }))).status, 400);
  assert.equal((await send(JSON.stringify({ ...payload, service_tier: 'default' }))).status, 400);
  assert.equal((await send(JSON.stringify({ ...payload, store: true }))).status, 400);
  assert.equal((await send(JSON.stringify({ ...payload, stream: true }))).status, 400);
  assert.equal((await fetch(`${base}/v1/models`)).status, 404);
  assert.equal(received.length, 0);
  const result = await send(JSON.stringify(payload));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { status: 'completed', service_tier: 'flex' });
  assert.deepEqual(received[0], { authorization: 'Bearer test-key', body: JSON.stringify(payload) });
  upstreamStatus = 429;
  const busy = await send(JSON.stringify(payload));
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: { code: 'resource_unavailable' } });
  assert.equal(received.length, 2);
  await new Promise((resolve) => upstream.close(resolve));
  const unavailable = await send(JSON.stringify(payload));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: { code: 'upstream_unavailable' } });
});
