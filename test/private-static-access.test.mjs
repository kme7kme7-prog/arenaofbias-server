import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'private-static-access-'));
  const dist = join(root, 'dist'); mkdirSync(dist);
  const registry = JSON.stringify({ title: 'Private complete registry', models: [], tasks: [] });
  writeFileSync(join(dist, 'data.json'), registry); writeFileSync(join(dist, 'public.txt'), 'Public asset');
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), admins: [], siteOrigins: [], cdn: [],
    contentTemplate: 'http://{token}.localhost', capture: false, moderation: { enabled: false }, leaderboardWarmup: false }, limits });
  const admin = platform.auth.createAdmin('admin', 'a correct password');
  let cookie;
  platform.auth.startSession({ setHeader: (_, value) => { cookie = value.split(';')[0]; } }, admin.id);
  const id = 'a'.repeat(16), inbox = join(root, 'data', 'inbox');
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ kind: 'html', name: 'private.html' }));
  writeFileSync(join(inbox, `${id}.bin`), 'Private inbox asset');
  const paths = { registry: '/data.json', inbox: `/admin/inbox/${id}/file` };
  const server = createServer(platform.handleSite); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await platform.close(); rmSync(root, { recursive: true, force: true }); });
  const read = async (path, method = 'GET', signedIn = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: signedIn ? { cookie } : {} });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const arm = mutate => {
    const original = platform.auth.userFrom; let armed = true;
    platform.auth.userFrom = function (req) {
      const viewer = original.call(this, req);
      if (armed) { armed = false; queueMicrotask(mutate); }
      return viewer;
    };
  };
  return { platform, admin, registry, paths, read, arm, inboxMeta: join(inbox, `${id}.json`) };
}

test('staff-only static GET/HEAD responses are no-store while public assets keep their policy', async t => {
  const f = await fixture(t);
  for (const [kind, path] of Object.entries(f.paths)) for (const method of ['GET', 'HEAD']) {
    const response = await f.read(path, method);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body, method === 'HEAD' ? '' : kind === 'registry' ? f.registry : 'Private inbox asset');
  }
  assert.equal((await f.read('/public.txt', 'GET', false)).headers.get('cache-control'), 'no-cache');
  for (const path of Object.values(f.paths)) assert.equal((await f.read(path, 'GET', false)).status, 404);
});

test('logout and staff demotion during file open reject both private static handlers', async t => {
  for (const kind of ['registry', 'inbox']) for (const change of ['logout', 'demotion']) for (const method of ['GET', 'HEAD']) {
    await t.test(`${kind} ${change} ${method}`, async t => {
      const f = await fixture(t);
      f.arm(() => change === 'logout' ? f.platform.db.exec('DELETE FROM sessions')
        : f.platform.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.admin.id));
      const response = await f.read(f.paths[kind], method);
      assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(response.body, /Private complete registry|Private inbox asset/);
    });
  }
});

test('removing the staging entry while its file opens also rejects its previous target', async t => {
  const f = await fixture(t); f.arm(() => rmSync(f.inboxMeta));
  const response = await f.read(f.paths.inbox);
  assert.equal(response.status, 404); assert.doesNotMatch(response.body, /Private inbox asset/);
});
