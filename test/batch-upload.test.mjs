import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { planDigest } from '../server/batch-plan.mjs';
import { limits } from '../server/config.mjs';
import { inspectUpload } from '../server/inspect.mjs';
import { isBlockedAddress, resolvePublic } from '../server/egress.mjs';

const html = '<!doctype html><html><head><title>台灯</title></head><body><h1>台灯</h1></body></html>';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function planFor(batch, body, extra = {}) {
  const bytes = Buffer.from(body);
  const plan = {
    batch,
    clientName: 'aob-batch',
    works: [{
      key: 'lamp-01', task: 'one', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official',
      harnessOther: 'local', generationMode: 'single-turn', humanIntervention: 'none',
      compressedBytes: bytes.length,
      files: [{ path: 'index.html', size: bytes.length, sha256: sha(bytes) }],
      autoVerify: false, publish: true, show_gallery: true, pipeline: 'staff', role: 'admin',
      ...extra,
    }],
  };
  const packed = planDigest(plan);
  return { plan: packed.plan, digest: packed.digest, body: bytes };
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const sum = entry.crc ?? (crc32(data) >>> 0);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(entry.packedSize ?? payload.length, 18);
    local.writeUInt32LE(entry.rawSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(entry.packedSize ?? payload.length, 20);
    central.writeUInt32LE(entry.rawSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.external ?? 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

async function withPlatform(run, batch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'batch-upload-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'results', 'one', 'a'), { recursive: true });
  writeFileSync(join(dist, 'results', 'one', 'a', 'index.html'), html);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ schemaVersion: 1, title: '测试', models: [
    { id: 'ma', name: '模型甲', vendor: '甲' },
  ], tasks: [
    { id: 'one', title: '测试题', category: '建模', domains: ['物理'], prompt: '题', templates: ['static'], results: [
      { id: 'a', title: '精选', model: 'ma', scene: 'results/one/a/' },
    ] },
    { id: 'two', title: '第二题', category: '建模', domains: ['物理'], prompt: '题二', templates: ['static'], results: [] },
  ] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), admin: join(process.cwd(), 'admin'),
    contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: ['root'], cdn: [], capture: false,
    secureCookies: false, trustProxy: false, moderation: { enabled: false },
    batch: { enabled: true, diskFloorBytes: 0, diskFloorRatio: 0, inodeFloor: 0, screenshotReserve: 1024,
      worksPerWindow: 30, moderationQueueMax: 64, captureQueueMax: 32, ...batch } }, limits });
  const server = createServer(platform.handleSite);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  async function call(who, method, path, { json, raw, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (method !== 'GET' && method !== 'HEAD') requestHeaders.origin = base;
    if (who && cookies.get(who)) requestHeaders.cookie = cookies.get(who);
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      requestHeaders['content-type'] = 'application/json';
    } else if (raw !== undefined) body = raw;
    const response = await fetch(base + path, { method, headers: requestHeaders, body });
    const cookie = response.headers.get('set-cookie');
    if (who && cookie) cookies.set(who, cookie.split(';')[0]);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: response.status, data, retryAfter: response.headers.get('retry-after') };
  }
  try {
    platform.auth.createAdmin('root', 'correct horse');
    const senior = platform.db.prepare("SELECT * FROM users WHERE name = 'root'").get();
    platform.auth.bindEmail(senior.id, 'root@example.test');
    const staff = await platform.auth.register('mod', 'correct horse');
    platform.auth.bindEmail(staff.id, 'mod@example.test');
    platform.auth.setRole(senior, staff.id, 'moderator');
    const other = await platform.auth.register('other', 'correct horse');
    platform.auth.bindEmail(other.id, 'other@example.test');
    platform.auth.setRole(senior, other.id, 'moderator');
    assert.equal((await call('root', 'POST', '/api/auth/login', { json: { name: 'root', password: 'correct horse' } })).status, 200);
    assert.equal((await call('mod', 'POST', '/api/auth/login', { json: { name: 'mod', password: 'correct horse' } })).status, 200);
    assert.equal((await call('other', 'POST', '/api/auth/login', { json: { name: 'other', password: 'correct horse' } })).status, 200);
    await run({ platform, call, base, root, staffId: staff.id });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function grantFor(call, batch, body = html) {
  const packed = planFor(batch, body);
  const registered = await call(null, 'POST', '/api/batch/device', { json: { ...packed.plan, payloadDigest: packed.digest } });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(registered.data.payloadDigest, packed.digest);
  const viewed = await call('mod', 'GET', `/api/batch/device/${registered.data.user_code}`);
  assert.equal(viewed.status, 200);
  assert.equal(viewed.data.payloadDigest, packed.digest);
  assert.equal(viewed.data.works[0].files[0].sha256, packed.plan.works[0].files[0].sha256);
  const approved = await call('mod', 'POST', `/api/batch/${batch}/approve`, { json: { userCode: registered.data.user_code, payloadDigest: viewed.data.payloadDigest } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const polled = await call(null, 'POST', '/api/batch/device/poll', { json: { device_code: registered.data.device_code } });
  assert.equal(polled.status, 200, JSON.stringify(polled.data));
  assert.equal(polled.data.tokenType, 'batch-grant');
  assert.match(polled.data.token, /^aobb_/);
  return { ...packed, token: polled.data.token, device: registered.data.device_code };
}

test('batch grant stays unverified while the cookie path still auto-verifies', async () => {
  await withPlatform(async ({ platform, call }) => {
    let queued = 0;
    let captured = 0;
    const enqueue = platform.moderator.enqueue.bind(platform.moderator);
    const shoot = platform.capturer.enqueue.bind(platform.capturer);
    platform.moderator.enqueue = (work) => { queued += 1; assert.equal(work.moderation.status, 'pending'); return enqueue(work); };
    platform.capturer.enqueue = (work) => { captured += 1; return shoot(work); };
    const granted = await grantFor(call, 'lamp01');
    const logs = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const previous = Object.fromEntries(methods.map((method) => [method, console[method]]));
    for (const method of methods) console[method] = (...args) => logs.push(args.map((item) => String(item)).join(' '));
    let uploaded;
    try {
      uploaded = await call(null, 'PUT', '/api/batch/lamp01/works/lamp-01', {
        raw: granted.body,
        headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
      });
    } finally {
      for (const method of methods) console[method] = previous[method];
    }
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.status, 'unverified');
    assert.equal(uploaded.data.moderation, 'pending');
    const row = platform.db.prepare('SELECT status, moderation, show_gallery, show_arena, show_entertainment, author_role FROM works WHERE id = ?').get(uploaded.data.workId);
    assert.equal(row.status, 'unverified');
    assert.equal(JSON.parse(row.moderation).status, 'pending');
    assert.equal(JSON.parse(row.moderation).source, undefined);
    assert.equal(row.show_gallery, 0);
    assert.equal(row.show_arena, 0);
    assert.equal(row.show_entertainment, 0);
    assert.equal(row.author_role, 'moderator');
    assert.equal(queued, 1);
    assert.equal(captured, 0);
    const replay = await call(null, 'PUT', '/api/batch/lamp01/works/lamp-01', {
      raw: granted.body, headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.workId, uploaded.data.workId);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works WHERE deleted_at IS NULL').get().n, 1);
    const changed = Buffer.from(html.replace('台灯', '灯台'));
    assert.equal(changed.length, granted.body.length);
    const mismatch = await call(null, 'PUT', '/api/batch/lamp01/works/lamp-01', {
      raw: changed, headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.data.code, 'digest_mismatch');
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 1);
    const listed = await call(null, 'GET', '/api/bootstrap');
    assert.equal(listed.status, 200);
    assert.equal((listed.data.works ?? []).some((work) => work.id === uploaded.data.workId), false);
    const draft = await call('mod', 'POST', '/api/drafts?task=one&name=staff.html', { raw: Buffer.from(html) });
    const submitted = await call('mod', 'POST', '/api/works', { json: { draftId: draft.data.draft.id, confirmed: true, modelId: 'ma', effort: 'High', providerId: 'official' } });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    assert.equal(submitted.data.work.status, 'verified');
    assert.equal(submitted.data.work.moderation.status, 'approved');
    const audit = platform.db.prepare('SELECT detail, action FROM audit').all().map((row) => `${row.action} ${row.detail}`).join('\n');
    assert.equal(audit.includes(granted.token), false);
    assert.equal(audit.includes(granted.device), false);
    assert.equal(logs.join('\n').includes(granted.token), false);
    assert.equal(logs.join('\n').includes(granted.device), false);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE work_id = ? AND action = 'verified'").get(uploaded.data.workId).n, 0);
  });
});

test('batch grant rejects scope changes, mixing, other users, and a changed role', async () => {
  await withPlatform(async ({ platform, call, staffId }) => {
    const granted = await grantFor(call, 'lamp02');
    const auth = { authorization: `Bearer ${granted.token}` };
    const denied = [
      ['POST', '/api/works/one/nope/review', { json: { status: 'verified' } }],
      ['POST', '/api/works/one/nope/moderation', { json: { status: 'approved' } }],
      ['POST', '/api/admin/works/upload?task=one&name=x.html', { raw: granted.body }],
      ['POST', '/api/admin/inbox?name=x.html', { raw: granted.body }],
      ['POST', `/api/admin/users/${staffId}/role`, { json: { role: 'admin' } }],
      ['POST', '/api/drafts?task=one&name=x.html', { raw: granted.body }],
      ['GET', '/api/dots/moderation/works'],
    ];
    for (const [method, path, options] of denied) {
      const response = await call(null, method, path, { ...options, headers: auth });
      assert.equal(response.status, 403, `${method} ${path} ${JSON.stringify(response.data)}`);
    }
    const mixed = await call('mod', 'PUT', '/api/batch/lamp02/works/lamp-01', {
      raw: granted.body, headers: { ...auth, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(mixed.status, 403);
    assert.equal(mixed.data.code, 'batch_forbidden');
    const other = await call('other', 'GET', '/api/batch/lamp02');
    assert.equal(other.status, 404);
    assert.equal(JSON.stringify(other.data).includes('台灯'), false);
    const otherCancel = await call('other', 'POST', '/api/batch/lamp02/cancel', { json: {} });
    assert.equal(otherCancel.status, 404);
    assert.equal(JSON.stringify(otherCancel.data).includes('台灯'), false);
    const wrongTask = await call(null, 'PUT', '/api/batch/lamp02/works/lamp-01?task=two', {
      raw: granted.body, headers: { ...auth, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(wrongTask.status, 403, JSON.stringify(wrongTask.data));
    const senior = await call('root', 'POST', '/api/batch/lamp02/approve', { json: { userCode: 'AAAAAAAAAA', payloadDigest: granted.digest } });
    assert.equal(senior.status, 403);
    const uploaded = await call(null, 'PUT', '/api/batch/lamp02/works/lamp-01', {
      raw: granted.body, headers: { ...auth, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    const id = uploaded.data.workId;
    platform.auth.setRole(platform.db.prepare("SELECT * FROM users WHERE name = 'root'").get(), staffId, 'user');
    const downgraded = await call(null, 'PUT', '/api/batch/lamp02/works/lamp-01', {
      raw: granted.body, headers: { ...auth, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(downgraded.status, 403);
    assert.equal(platform.db.prepare('SELECT status FROM works WHERE id = ?').get(id).status, 'unverified');
    platform.auth.setRole(platform.db.prepare("SELECT * FROM users WHERE name = 'root'").get(), staffId, 'moderator');
    const revived = await call(null, 'PUT', '/api/batch/lamp02/works/lamp-01', {
      raw: granted.body, headers: { ...auth, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(revived.status, 403);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 1);
  });
});

test('mid-upload role downgrade, revoke, and expiry leave no work row', async () => {
  const phases = [
    (platform, staffId) => platform.auth.setRole(platform.db.prepare("SELECT * FROM users WHERE name = 'root'").get(), staffId, 'user'),
    (platform) => platform.db.prepare('UPDATE batch_grants SET revoked_at = 1').run(),
    (platform) => platform.db.prepare('UPDATE batch_grants SET expires_at = 1').run(),
  ];
  for (const [index, phase] of phases.entries()) {
    let platformRef;
    let staffRef;
    let action = async () => {};
    await withPlatform(async ({ platform, call, staffId }) => {
      platformRef = platform;
      staffRef = staffId;
      action = async () => phase(platformRef, staffRef);
      const granted = await grantFor(call, `lamp3${index}`);
      const before = platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n;
      const response = await call(null, 'PUT', `/api/batch/lamp3${index}/works/lamp-01`, {
        raw: granted.body,
        headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
      });
      assert.equal(response.status, 403, JSON.stringify(response.data));
      assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, before);
      assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM batch_reservations WHERE state = 'held'").get().n, 0);
    }, { beforeCommit: () => action() });
  }
});

test('disk reservation and queue pressure reject before a work row exists', async () => {
  await withPlatform(async ({ platform, call }) => {
    const granted = await grantFor(call, 'lampdisk');
    platform.db.prepare(`INSERT INTO batch_reservations (
      id, user_id, batch_id, work_key, compressed_bytes, expanded_bytes, staging_bytes, screenshot_bytes, inodes, state, created_at)
      VALUES ('held-other', 'someone', 'other', 'x', 4500, 0, 0, 0, 0, 'held', 1)`).run();
    const response = await call(null, 'PUT', '/api/batch/lampdisk/works/lamp-01', {
      raw: granted.body, headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(response.status, 507, JSON.stringify(response.data));
    assert.equal(response.data.code, 'insufficient_storage');
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
    platform.db.prepare("UPDATE batch_reservations SET state = 'released' WHERE id = 'held-other'").run();
    const ok = await call(null, 'PUT', '/api/batch/lampdisk/works/lamp-01', {
      raw: granted.body, headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
  }, { statfs: () => ({ bytes: 5000, capacity: 100000, inodes: 1000 }) });

  await withPlatform(async ({ platform, call }) => {
    const granted = await grantFor(call, 'lampqueue');
    const response = await call(null, 'PUT', '/api/batch/lampqueue/works/lamp-01', {
      raw: granted.body, headers: { authorization: `Bearer ${granted.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(response.status, 429, JSON.stringify(response.data));
    assert.equal(response.data.code, 'moderation_busy');
    assert.ok(Number(response.retryAfter) > 0);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
  }, { moderationQueueMax: 0 });
});

test('unsafe packages are rejected and cancel removes only uncommitted staging', async () => {
  const limitsForInspect = { ...limits, inflateBudgetMs: 50 };
  assert.throws(() => inspectUpload(zip([{ name: '../secret.html', data: html }]), 'bad.zip', { limits, cdn: [], policy: 'batch' }), /不安全/);
  assert.throws(() => inspectUpload(zip([{ name: 'link.html', data: html, external: 0xa0000000, madeBy: 0 }]), 'link.zip', { limits, cdn: [], policy: 'batch' }), /符号链接/);
  const bomb = zip([{ name: 'index.html', data: html, method: 8, rawSize: 5 * 1024 * 1024, packedSize: 20 }]);
  assert.throws(() => inspectUpload(bomb, 'bomb.zip', { limits, cdn: [], policy: 'batch' }), /压缩比例|解压|损坏/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.throws(() => inspectUpload(png, 'index.html', { limits, cdn: [], policy: 'batch' }), /图片/);
  assert.throws(() => inspectUpload(Buffer.alloc(0), 'index.html', { limits: limitsForInspect, cdn: [] }), /空/);

  await withPlatform(async ({ platform, call }) => {
    const hostile = zip([{ name: '../secret.html', data: html }]);
    const packed = planFor('lampsafe', hostile);
    const registered = await call(null, 'POST', '/api/batch/device', { json: { ...packed.plan, payloadDigest: packed.digest } });
    assert.equal(registered.status, 200, JSON.stringify(registered.data));
    await call('mod', 'POST', '/api/batch/lampsafe/approve', { json: { userCode: registered.data.user_code, payloadDigest: packed.digest } });
    const polled = await call(null, 'POST', '/api/batch/device/poll', { json: { device_code: registered.data.device_code } });
    const response = await call(null, 'PUT', '/api/batch/lampsafe/works/lamp-01', {
      raw: hostile, headers: { authorization: `Bearer ${polled.data.token}`, 'idempotency-key': 'lamp-01' },
    });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
    const status = await call(null, 'GET', '/api/batch/lampsafe', { headers: { authorization: `Bearer ${polled.data.token}` } });
    assert.equal(status.status, 200);
    assert.equal(status.data.works[0].workId, null);
    const cancelled = await call(null, 'POST', '/api/batch/lampsafe/cancel', { headers: { authorization: `Bearer ${polled.data.token}` }, json: {} });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.data.kept, []);
    const again = await call(null, 'POST', '/api/batch/lampsafe/cancel', { headers: { authorization: `Bearer ${polled.data.token}` }, json: {} });
    assert.equal(again.status, 200);
  });
});

test('batch routes stay closed when the feature flag is off', async () => {
  await withPlatform(async ({ call }) => {
    const packed = planFor('lampoff', html);
    const registered = await call(null, 'POST', '/api/batch/device', { json: { ...packed.plan, payloadDigest: packed.digest } });
    assert.equal(registered.status, 403);
    assert.equal(registered.data.code, 'batch_forbidden');
    const upload = await call(null, 'PUT', '/api/batch/lampoff/works/lamp-01', {
      raw: Buffer.from(html), headers: { authorization: 'Bearer aobb_example', 'idempotency-key': 'lamp-01' },
    });
    assert.equal(upload.status, 403);
    assert.equal(upload.data.code, 'batch_forbidden');
  }, { enabled: false });
});

test('egress refuses private, metadata, and mixed DNS answers', async () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('127.0.0.1', { allowLoopback: true }), false);
  const rebound = await resolvePublic('cdn.example', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }] });
  assert.equal(rebound.ok, false);
  const metadata = await resolvePublic('metadata.google.internal', { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  assert.equal(metadata.ok, false);
  const failed = await resolvePublic('cdn.example', { lookup: async () => { throw new Error('servfail'); } });
  assert.equal(failed.ok, false);
});
