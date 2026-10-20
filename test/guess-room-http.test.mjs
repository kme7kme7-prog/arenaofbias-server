import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'guess-friend-http-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Test', tasks: [], models: [] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: '', siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false, trustProxy: false }, limits });
  const server = createServer(platform.handleSite);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const name of ['alice', 'bob', 'charlie']) {
    const u = await platform.auth.register(name, 'test password only');
    platform.auth.startSession({ setHeader: (_, cookie) => { cookies[name] = cookie.split(';')[0]; } }, u.id);
  }
  const call = (user, path, body, headers = {}) => fetch(`${base}/api/guess/friends/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, ...(cookies[user] ? { cookie: cookies[user] } : {}), 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  t.after(async () => {
    await platform.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { call, platform, cookies, base };
}

test('friend catalogue HTTP returns the members room snapshot without affecting other players', async t => {
  const { call, platform } = await fixture(t);
  const { room } = await (await call('alice', 'create', { difficulty: 2 })).json();
  await call('bob', 'join', { code: room.code });
  await call('alice', `${room.code}/ready`, { ready: true });
  await call('bob', `${room.code}/ready`, { ready: true });
  const state = JSON.parse(platform.db.prepare('SELECT state FROM guess_friend_rooms WHERE code=?').get(room.code).state);
  assert.ok(state.catalog.length > 0);
  const id = state.catalog[0].id;
  state.catalog[0].name = 'Frozen room catalogue model';
  platform.db.prepare('UPDATE guess_friend_rooms SET state=? WHERE code=?').run(JSON.stringify(state), room.code);
  for (const user of ['alice', 'bob']) {
    const response = await call(user, 'catalog');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.models.find(m => m.id === id).name, 'Frozen room catalogue model');
    assert.equal('answer' in data, false);
    assert.equal('target' in data, false);
  }
  const outsider = await (await call('charlie', 'catalog')).json();
  assert.notEqual(outsider.models.find(m => m.id === id).name, 'Frozen room catalogue model');
});

test('friend HTTP requires session, trusted origin, bounded payload and server-owned identity', async t => {
  const { call, base, cookies } = await fixture(t);
  for (const path of ['current', 'catalog']) assert.equal((await call(null, path)).status, 401);
  assert.equal((await call(null, 'create', { difficulty: 2 })).status, 401);
  assert.equal((await call('alice', 'create', { difficulty: 2 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('alice', 'current', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('alice', 'create', { difficulty: 2, userId: 'bob' })).status, 400);
  assert.equal((await call('alice', 'create', { difficulty: 2, padding: 'x'.repeat(1100) })).status, 413);
  const created = await call('alice', 'create', { difficulty: 2 });
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { room } = await created.json();
  assert.equal(room.players[0].name, 'alice');
  assert.equal(room.answer, null);
  const catalog = await (await call('alice', 'catalog')).json();
  const reveal = await fetch(`${base}/api/guess/check`, { method: 'POST', headers: { origin: base, cookie: cookies.alice, 'content-type': 'application/json' }, body: JSON.stringify({ gameId: room.code, guessId: catalog.models[0].id, final: true }) });
  assert.equal(reveal.status, 404);
  assert.ok(!('answer' in await reveal.json()));
  assert.equal((await call('bob', `${room.code}/state`)).status, 404);
  assert.equal((await call('bob', `${room.code}/events`)).status, 404);
  assert.equal((await call('bob', `${room.code}/ready`, { ready: true })).status, 404);
  assert.equal((await call('bob', 'join', { code: room.code })).status, 200);
  assert.equal((await call('charlie', 'join', { code: room.code })).status, 404);
  assert.equal((await call('charlie', `${room.code}/state`)).status, 404);
  assert.equal((await call('alice', `${room.code}/guess`, { round: 1, guessId: 'x', requestId: 'legitimate_request', won: true })).status, 400);
  assert.equal((await call('alice', `${room.code}/leave`, {})).status, 200);
  assert.equal((await call('alice', `${room.code}/state`)).status, 404);
});

test('room code enumeration is limited even when every attempt fails', async t => {
  const { call } = await fixture(t);
  for (let i = 0; i < 12; i++) assert.equal((await call('charlie', 'join', { code: 'ZZZZZZZZ' })).status, 404);
  const response = await call('charlie', 'join', { code: 'YYYYYYYY' });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('SSE is private, capped, uncached, and revoked after session logout', async t => {
  const { call, platform, cookies, base } = await fixture(t);
  const { room } = await (await call('alice', 'create', { difficulty: 2 })).json();
  const controllers = [new AbortController(), new AbortController()];
  const streams = [];
  try {
    for (const controller of controllers) {
      const r = await fetch(`${base}/api/guess/friends/${room.code}/events`, { headers: { origin: base, cookie: cookies.alice }, signal: controller.signal });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-accel-buffering'), 'no');
      const reader = r.body.getReader(); streams.push(reader);
      const text = new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: room/);
      const view = JSON.parse(text.split('data: ')[1].split('\n')[0]);
      assert.equal(view.answer, null);
      assert.ok(!('id' in view.players[0]));
    }
    assert.equal((await call('alice', `${room.code}/events`)).status, 429);
    platform.auth.endSession({ headers: { cookie: cookies.alice } }, { setHeader() {} });
    // Joining triggers a push, which must recheck the existing stream's session.
    assert.equal((await call('bob', 'join', { code: room.code })).status, 200);
    for (const reader of streams) {
      // An update queued before logout may still be in the network buffer.
      let ended = false;
      for (let i = 0; i < 5; i++) {
        const chunk = await reader.read();
        if (chunk.done) { ended = true; break; }
        assert.ok(!new TextDecoder().decode(chunk.value).includes('"name":"bob"'));
      }
      assert.equal(ended, true);
    }
    assert.equal((await call('alice', `${room.code}/state`)).status, 401);
  } finally { for (const controller of controllers) controller.abort(); }
});

test('friend room streams send a keepalive within 10 seconds and end when the platform closes streams', async t => {
  const { call, platform, cookies, base } = await fixture(t);
  const { room } = await (await call('alice', 'create', { difficulty: 2 })).json();
  const response = await fetch(`${base}/api/guess/friends/${room.code}/events`, { headers: { origin: base, cookie: cookies.alice } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const started = Date.now();
  let text = '';
  while (!text.includes(': keepalive')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value);
  }
  assert.ok(Date.now() - started <= 11_500, 'heartbeat arrives before the 15-second edge timeout');
  platform.closeStreams();
  for (;;) if ((await reader.read()).done) break;
});
