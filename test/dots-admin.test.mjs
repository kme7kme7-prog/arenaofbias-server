import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createDotsAdminBindings } from '../server/dots-admin.mjs';
import { createModerationTokens } from '../server/dots-moderation.mjs';
import { compress } from '../server/compress.mjs';
import { limits } from '../server/config.mjs';

async function fixture(run, { compressBody, moderation = {}, captureFactory } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dots-admin-')), dist = join(root, 'dist'), dataDir = join(root, 'data');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Fixture', models: [{ id: 'model', name: 'Model', vendor: 'Vendor' }], tasks: [
    { id: 'one', title: 'One', prompt: 'Prompt', category: '建模', domains: ['物理'], templates: ['static'], results: [] },
  ] }));
  const platform = createPlatform({ config: { dist, dataDir, contentTemplate: 'http://{token}.localhost', admins: [], siteOrigins: [], cdn: [], capture: false,
    secureCookies: false, moderation: { enabled: false, ...moderation } }, limits, compressBody,
    captureFactory: captureFactory ?? (() => ({ available: false, async enqueue() { assert.fail('admin read/write must not start capture'); }, async close() {} })) });
  const inFlight = new Set();
  const server = createServer((req, res) => {
    const pending = platform.handleSite(req, res); inFlight.add(pending);
    pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const human = platform.auth.createAdmin('human-admin', 'correct horse');
  const member = await platform.auth.register('member', 'correct horse');
  const tokens = createModerationTokens(platform.db), token = tokens.create('dots', 'test');
  const bindings = createDotsAdminBindings({ db: platform.db, auth: platform.auth });
  const binding = bindings.createAssistant(token.id);
  const cookie = {};
  platform.auth.startSession({ setHeader: (_k, v) => { cookie.value = v.split(';')[0]; } }, human.id);
  const call = async (method, path, body, options = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(options.cookie ? { cookie: cookie.value, origin: base } : { authorization: `Bearer ${options.token ?? token.token}` }),
      'accept-encoding': options.encoding ?? 'identity', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: method === 'HEAD' ? null : await response.json(), headers: response.headers };
  };
  const grant = () => { tokens.grant(token.id, 'admin:read'); tokens.grant(token.id, 'admin:write'); };
  const add = (id, task = 'one') => platform.db.prepare(`INSERT INTO works
    (id,task_id,owner_id,title,model_id,model_other,content_key,source_name,root,entry,file_count,bytes,digest,checks,trial,created_at,updated_at,status,moderation)
    VALUES (?,?,?,?,'model','',?,'test.html','','index.html',1,20,?,'[]','{}',1,1,'unverified','{"status":"approved","source":"human"}')`)
    .run(id, task, member.id, `Confidential ${id}`, `key-${id}`, `digest-${id}`);
  try { await run({ platform, server, base, call, human, member, token, tokens, bindings, binding, grant, add, root, dataDir }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...inFlight]); await platform.close(); rmSync(root, { recursive: true, force: true }); }
}

test('admin scopes are explicit, caps is the actual allowlist, and Cookie/public APIs remain separate', async () => fixture(async ({ call, token, tokens, grant }) => {
  assert.equal((await call('GET', '/api/dots/admin/caps')).status, 403);
  assert.equal((await call('GET', '/api/admin/users')).data.code, 'token_forbidden');
  tokens.grant(token.id, 'admin:read');
  const caps = await call('GET', '/api/dots/admin/caps');
  assert.equal(caps.status, 200); assert.equal(caps.headers.get('cache-control'), 'no-store');
  assert.equal(caps.data.actor.name, 'dots'); assert.equal(caps.data.actor.role, 'admin');
  assert.deepEqual(caps.data.scopes, ['moderation', 'admin:read']);
  assert.equal(caps.data.recapture.supported, true);
  assert.ok(caps.data.routes.length > 50);
  const route = (method, path) => caps.data.routes.find(row => row.method === method && row.path === `/api/dots/admin${path}`);
  assert.equal(route('POST', '/guess/models').jsonBodyBytes, 8192);
  assert.equal(route('POST', '/announcements').scope, 'admin:write');
  assert.ok(!route('POST', '/works/upload')); assert.ok(!route('POST', '/inbox')); assert.ok(!route('POST', '/inbox/register'));
  assert.equal((await call('POST', '/api/dots/admin/announcements', { title: 'A', body: 'B' })).status, 403);
  for (const path of ['/api/dots/admin/cli', '/api/dots/admin/api/me', '/api/dots/admin/tokens', '/api/dots/admin/works/upload']) assert.ok([404, 405].includes((await call('POST', path, {})).status));
  assert.equal((await call('PATCH', '/api/dots/admin/caps', {})).status, 405);
  assert.equal((await call('GET', '/api/dots/admin/caps?target=/api/me')).status, 400);
  assert.equal((await call('GET', '/api/dots/admin/caps', undefined, { cookie: true })).status, 401);
  const before = (await call('GET', '/api/admin/users?page=1', undefined, { cookie: true })).data;
  assert.deepEqual((await call('GET', '/api/dots/admin/users?page=1')).data, before);
  assert.equal((await call('HEAD', '/api/dots/admin/users?page=1')).status, 200);
  grant(); assert.equal((await call('GET', '/api/dots/admin/caps')).data.scopes.length, 3);
}));

test('bound real actor uses original review/meta/announcement/role validation and auditable identity', async () => fixture(async ({ platform, call, grant, add, binding, member, token }) => {
  grant(); add('work');
  assert.equal((await call('GET', '/api/dots/admin/review?panel=unverified&pageSize=1')).data.works[0].id, 'work');
  assert.equal((await call('POST', '/api/dots/admin/works/one/work/meta', { title: 'Updated title' })).status, 200);
  assert.equal(platform.library.work('one', 'work').title, 'Updated title');
  assert.equal((await call('POST', '/api/dots/admin/works/one/work/review', { status: 'questioned', reason: '' })).status, 400);
  assert.equal((await call('POST', '/api/dots/admin/works/one/work/review', { status: 'questioned', reason: 'Confirm source' })).status, 200);
  assert.equal((await call('POST', '/api/dots/admin/announcements', { title: 'Notice', body: 'Body' })).status, 200);
  assert.equal(platform.db.prepare('SELECT created_by FROM announcements').get().created_by, binding.actorId);
  assert.equal((await call('POST', `/api/dots/admin/users/${binding.actorId}/role`, { role: 'user' })).status, 409);
  assert.equal((await call('POST', `/api/dots/admin/users/${member.id}/role`, { level: 1 })).status, 200);
  assert.equal((await call('POST', '/api/admin/announcements', { title: 'Cookie Notice', body: 'Cookie Body' }, { cookie: true })).status, 200);
  const audit = platform.db.prepare('SELECT * FROM moderation_token_audit WHERE token_id=?').all(token.id);
  assert.ok(audit.some(row => row.action === 'admin:POST:/announcements' && row.actor_id === binding.actorId && row.outcome === 'ok'));
  assert.ok(audit.some(row => row.action === 'admin:POST:/works/:task/:id/meta' && row.reason === 'title' && row.work_id === 'work'));
  const business = platform.db.prepare('SELECT * FROM audit WHERE actor_id=?').all(binding.actorId);
  assert.ok(business.length); assert.ok(business.every(row => row.actor_name === 'dots:dots'));
  assert.ok(!JSON.stringify(audit).includes(token.token));
}));

test('bindings require active tokens and current senior actors; creating a collision never upgrades or resets an account', async () => fixture(async ({ platform, bindings, binding, tokens, token, grant, call, member, human }) => {
  grant();
  const before = platform.db.prepare('SELECT role,hash,salt FROM users WHERE id=?').get(member.id);
  const other = tokens.create('other', 'test');
  assert.throws(() => bindings.createAssistant(other.id, ' ＭＥＭＢＥＲ '), /用户名/);
  assert.deepEqual(platform.db.prepare('SELECT role,hash,salt FROM users WHERE id=?').get(member.id), before);
  assert.equal(bindings.describe(other.id), null);
  assert.throws(() => bindings.bind(other.id, member.id), /高级管理员/);
  assert.throws(() => bindings.createAssistant(token.id, 'unused'), /已绑定/);
  assert.equal(platform.auth.isAdminName('unused'), false);
  platform.auth.setRole(human, binding.actorId, 'moderator');
  assert.equal((await call('GET', '/api/dots/admin/caps')).data.code, 'admin_actor_disabled');
  platform.auth.setRole(human, binding.actorId, 'admin');
  bindings.unbind(token.id);
  assert.equal((await call('GET', '/api/dots/admin/caps')).data.code, 'admin_binding_required');
  bindings.bind(token.id, binding.actorId);
  platform.db.prepare('DELETE FROM users WHERE id=?').run(binding.actorId);
  assert.equal((await call('GET', '/api/dots/admin/caps')).status, 403);
  tokens.revoke(other.id);
  assert.throws(() => bindings.createAssistant(other.id, 'unused'), /吊销/);
}));

test('handoff and mistaken-rejection reopen enter only human review with strict versions and preserve the old decision', async () => fixture(async ({ platform, call, grant, add, binding }) => {
  grant(); add('review-me');
  const rejected = { status: 'rejected', source: 'dots', reason: 'Old rejection', at: 1, revision: 'old-dots', route: 'dots' };
  platform.db.prepare('UPDATE works SET moderation=? WHERE id=?').run(JSON.stringify(rejected), 'review-me');
  const path = '/api/dots/admin/works/one/review-me/moderation';
  const originalFlags = platform.db.prepare('SELECT status,show_gallery,show_arena FROM works WHERE id=?').get('review-me');
  const state = (await call('GET', `${path}/state`)).data;
  assert.match(state.version, /^[a-f0-9]{64}$/);
  assert.equal((await call('POST', `${path}/reopen`, { version: state.version })).status, 400);
  assert.equal((await call('POST', `${path}/reopen`, { version: '0'.repeat(64), reason: 'Mistake' })).status, 409);
  const reopened = await call('POST', `${path}/reopen`, { version: state.version, reason: 'Mistaken rejection, request manual review' });
  assert.equal(reopened.status, 200); assert.equal(reopened.data.moderation.status, 'review');
  assert.equal(reopened.data.moderation.source, 'human'); assert.equal(reopened.data.moderation.route, undefined);
  assert.notEqual(reopened.data.version, state.version);
  assert.equal((await call('POST', `${path}/reopen`, { version: state.version, reason: 'Duplicate' })).status, 409);
  assert.equal((await call('POST', `${path}/reopen`, { version: reopened.data.version, reason: 'Already reopened' })).status, 409);
  assert.equal((await call('GET', '/api/dots/moderation/queue')).data.items.length, 0);
  const work = platform.library.work('one', 'review-me');
  assert.deepEqual(platform.db.prepare('SELECT status,show_gallery,show_arena FROM works WHERE id=?').get('review-me'), originalFlags);
  assert.ok(!platform.library.publicContent(work));
  assert.ok(!platform.library.isEligible(work));
  assert.equal((await call('GET', '/api/dots/admin/review?panel=content')).data.works[0].id, 'review-me');
  const audit = platform.db.prepare("SELECT actor_id,actor_name,detail FROM audit WHERE action='content-reopen'").get();
  assert.equal(audit.actor_id, binding.actorId); assert.equal(audit.actor_name, 'dots:dots');
  assert.deepEqual(JSON.parse(audit.detail).before, rejected);
  assert.equal(JSON.parse(audit.detail).after.status, 'review');
  platform.db.prepare('UPDATE works SET moderation=? WHERE id=?').run(JSON.stringify({ status: 'pending', route: 'dots', at: Date.now(), revision: 'unfinished' }), 'review-me');
  const waiting = (await call('GET', `${path}/state`)).data;
  const handed = await call('POST', `${path}/handoff`, { version: waiting.version, reason: 'Cannot finish reliably' });
  assert.equal(handed.status, 200); assert.equal(handed.data.moderation.status, 'review');
  assert.equal(handed.data.moderation.route, undefined);
  assert.equal((await call('GET', '/api/dots/moderation/queue')).data.items.length, 0);
  assert.equal(platform.library.finishModeration({ ...work, moderationRaw: JSON.stringify(rejected) }, { status: 'approved' }), false, 'old automatic or dots decision loses CAS');
}));

test('JSON request bodies held across revoke/withdraw/rebind/demotion cannot commit a write', async () => {
  for (const change of ['revoke', 'withdraw', 'unbind', 'rebind', 'demote']) await fixture(async ({ platform, server, base, token, tokens, bindings, binding, grant, human }) => {
    grant();
    let entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    server.once('request', () => entered());
    const response = new Promise((resolve, reject) => {
      const req = request(base + '/api/dots/admin/announcements', { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', reject); req.write('{"title":"Late');
      arrived.then(() => {
        if (change === 'revoke') tokens.revoke(token.id);
        if (change === 'withdraw') tokens.withdraw(token.id, 'admin:write');
        if (change === 'unbind') bindings.unbind(token.id);
        if (change === 'rebind') { bindings.unbind(token.id); bindings.bind(token.id, binding.actorId); }
        if (change === 'demote') platform.auth.setRole(human, binding.actorId, 'moderator');
        req.end(' notice","body":"Never publish"}');
      }).catch(reject);
    });
    const result = await response;
    assert.equal(result.status, change === 'revoke' ? 401 : 403, change);
    assert.equal(platform.db.prepare('SELECT COUNT(*) n FROM announcements').get().n, 0, change);
  });
});

test('compressed private admin bytes are withheld on successful or failed compression after authority changes', async () => {
  for (const failed of [false, true]) for (const change of ['revoke', 'withdraw', 'rebind', 'demote']) {
    let entered, finish, reject, source, encoding;
    const arrived = new Promise(resolve => { entered = resolve; });
    await fixture(async ({ call, add, grant, token, tokens, bindings, binding, platform, human }) => {
      grant(); for (let n = 0; n < 4; n++) add(`private-${n}`);
      const reading = call('GET', '/api/dots/admin/review?panel=works', undefined, { encoding: 'gzip' });
      await arrived;
      if (change === 'revoke') tokens.revoke(token.id);
      if (change === 'withdraw') tokens.withdraw(token.id, 'admin:read');
      if (change === 'rebind') { bindings.unbind(token.id); bindings.bind(token.id, binding.actorId); }
      if (change === 'demote') platform.auth.setRole(human, binding.actorId, 'moderator');
      if (failed) reject(new Error('controlled compression failure')); else finish(await compress(source, encoding));
      const response = await reading;
      assert.equal(response.status, change === 'revoke' ? 401 : 403, `${change}/${failed}`);
      assert.ok(!JSON.stringify(response.data).includes('Confidential'));
      assert.ok(!JSON.stringify(response.data).includes('private-'));
      const audit = platform.db.prepare('SELECT outcome,actor_id FROM moderation_token_audit ORDER BY id DESC LIMIT 1').get();
      assert.match(audit.outcome, /^error:/); assert.equal(audit.actor_id, binding.actorId);
    }, { compressBody(body, used) { source = body; encoding = used; entered(); return new Promise((resolve, no) => { finish = resolve; reject = no; }); } });
  }
});

test('every admin write method shares a per-token write limit separate from reads', async () => fixture(async ({ grant, call }) => {
  grant();
  assert.equal((await call('POST', '/api/dots/admin/announcements', { title: 'One', body: 'Body' })).status, 200);
  assert.equal((await call('GET', '/api/dots/admin/caps')).status, 200);
  const denied = await call('DELETE', '/api/dots/admin/changelog/1');
  assert.equal(denied.status, 429); assert.equal(denied.data.code, 'rate_limited');
  assert.ok(Number(denied.headers.get('retry-after')) > 0);
}, { moderation: { dotsWritesPerMin: 1 } }));

test('identity JSON and error responses also recheck authority at their actual send boundary', async () => {
  for (const change of ['revoke', 'withdraw', 'demote']) for (const path of ['/api/dots/admin/caps', '/api/dots/admin/caps?unexpected=1']) {
    await fixture(async ({ platform, call, tokens, token, human, binding, grant }) => {
      grant();
      const byId = platform.auth.byId;
      let reads = 0;
      platform.auth.byId = id => {
        const actor = byId(id);
        if (++reads === 2) queueMicrotask(() => {
          if (change === 'revoke') tokens.revoke(token.id);
          if (change === 'withdraw') tokens.withdraw(token.id, 'admin:read');
          if (change === 'demote') platform.auth.setRole(human, binding.actorId, 'moderator');
        });
        return actor;
      };
      const response = await call('GET', path);
      assert.equal(response.status, change === 'revoke' ? 401 : 403);
      assert.ok(!response.data.actor); assert.ok(!response.data.routes);
      assert.notEqual(response.data.code, 'invalid_query');
    });
  }
});

test('body limits and bodyless operations reject invalid input before any side effects', async () => fixture(async ({ platform, call, grant }) => {
  grant();
  assert.equal((await call('POST', '/api/dots/admin/announcements', { title: 'Large', body: 'x'.repeat(65536) })).status, 413);
  assert.equal(platform.db.prepare('SELECT COUNT(*) n FROM announcements').get().n, 0);
  assert.equal((await call('POST', '/api/dots/admin/guess/models', { name: 'x'.repeat(8192) })).status, 413);
  assert.equal((await call('POST', '/api/dots/admin/guess/models', {})).status, 400, 'Bearer follows model validation rather than Cookie Origin');
  const rejected = await call('DELETE', '/api/dots/admin/questions/one', { ignored: true });
  assert.equal(rejected.status, 400); assert.equal(rejected.data.code, 'unexpected_body');
  assert.equal((await call('GET', '/api/dots/admin/questions/one')).status, 200);
}));

test('assistant CLI creates a separate identity without printing a password or expanding any scopes', async () => fixture(async ({ root, dataDir, platform, tokens }) => {
  const token = tokens.create('cli-test', 'test');
  const env = { ...process.env, DATA_DIR: dataDir, ADMIN_USERS: '' };
  const script = new URL('../scripts/moderation-token.mjs', import.meta.url);
  const output = execFileSync(process.execPath, [script.pathname, 'assistant-create', token.id, 'cli-dots'], { env, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.binding.name, 'cli-dots'); assert.equal(result.binding.enabled, true);
  assert.deepEqual(Object.keys(result), ['tokenId', 'binding']);
  assert.equal(platform.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(result.binding.actorId).n, 0);
  assert.deepEqual(tokens.list().find(row => row.id === token.id).scopes, ['moderation']);
  assert.ok(!output.includes('password')); assert.ok(!output.includes(token.token));
  const collision = tokens.create('cli-other', 'test');
  assert.throws(() => execFileSync(process.execPath, [script.pathname, 'assistant-create', collision.id, 'CLI-DOTS'], { env, stdio: 'pipe' }));
  assert.equal(platform.db.prepare('SELECT COUNT(*) n FROM users WHERE name_key=?').get('cli-dots').n, 1);
}));

test('real HTTP recapture responds 202 before completion, isolates job downloads and keeps source/media/moderation unchanged', async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const captures = [];
  await fixture(async ({ platform, call, grant, add, base, token, tokens, bindings }) => {
    grant(); add('up-abcdef12');
    const work = platform.library.uploadById('up-abcdef12');
    mkdirSync(work.dir, { recursive: true });
    const original = '<!doctype html><h1>Original is never replaced</h1>';
    writeFileSync(join(work.dir, work.entry), original);
    const before = platform.db.prepare('SELECT captures,cover,moderation,status FROM works WHERE id=?').get(work.id);
    const source = await call('GET', `/api/dots/admin/recaptures/source?task=one&id=${work.id}`);
    assert.equal(source.status, 200); assert.match(source.data.version, /^[a-f0-9]{64}$/);
    assert.equal((await call('GET', `/api/dots/admin/recaptures/source?task=one&id=${work.id}&id=${work.id}`)).status, 400);
    const body = { task: 'one', id: work.id, version: source.data.version, desktop: { width: 800, height: 600 }, mobile: { width: 360, height: 640 }, wait: { load: 'domcontentloaded', settleMs: 0 } };
    const created = await call('POST', '/api/dots/admin/recaptures', body);
    assert.equal(created.status, 202); assert.ok(['queued', 'running'].includes(created.data.state));
    const jobId = created.data.jobId;
    assert.equal((await call('POST', '/api/dots/admin/recaptures', body)).data.jobId, jobId);
    assert.equal(captures.length, 1); assert.equal(captures[0].publish, false);
    const other = tokens.create('other-owner', 'test', 'admin:read');
    bindings.createAssistant(other.id, 'other-assistant');
    assert.equal((await call('GET', `/api/dots/admin/recaptures/${jobId}`, undefined, { token: other.token })).status, 404);
    finish();
    let completed;
    for (let n = 0; n < 100; n++) {
      completed = await call('GET', `/api/dots/admin/recaptures/${jobId}`);
      if (completed.data.state === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(completed.data.state, 'succeeded'); assert.equal(completed.data.images.length, 2);
    const download = await fetch(base + completed.data.images[0].url, { headers: { authorization: `Bearer ${token.token}`, 'accept-encoding': 'gzip' } });
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/jpeg');
    assert.equal(download.headers.get('cache-control'), 'no-store'); assert.match(download.headers.get('content-security-policy'), /sandbox/);
    assert.ok((await download.arrayBuffer()).byteLength > 0);
    assert.equal(readFileSync(join(work.dir, work.entry), 'utf8'), original);
    assert.deepEqual(platform.db.prepare('SELECT captures,cover,moderation,status FROM works WHERE id=?').get(work.id), before);
  }, { captureFactory: () => ({ available: true, async enqueue(_work, settings) {
    captures.push(settings); settings.signal?.addEventListener('abort', finish, { once: true }); await held; await settings.beforeCapture();
    // Structural JPEG fixtures verify transport/dimensions, not visual rendering.
    for (const shot of settings.shots) {
      const { width, height } = shot.viewport;
      writeFileSync(join(settings.outputDir, `${shot.id}.jpg`), Buffer.from([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0,255,217]));
    }
    return { captures: { first: 'first.jpg', mobile: 'mobile.jpg' } };
  }, async close() { finish(); } }) });
});
