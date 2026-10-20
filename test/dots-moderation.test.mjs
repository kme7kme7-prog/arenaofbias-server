import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { createModerationTokens } from '../server/dots-moderation.mjs';
import { createModerator } from '../server/moderation.mjs';

const PAGE = '<!doctype html><html><body><h1>作品正文</h1><p>正常页面文字</p></body></html>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
const reply = (decision = 'approved', reason = '内容正常') => ({ id: 'resp_test', model: 'gpt-6-luna', status: 'completed', service_tier: 'flex',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision, reason, categories: [] }) }] }],
  usage: { input_tokens: 100, output_tokens: 20 } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(20); }
  assert.fail('condition not reached');
}

function fakeCapturer(library, captures = []) {
  return { get available() { return true; }, async enqueue(work, { prefix = '', publish = true } = {}) {
    captures.push(work.id);
    mkdirSync(join(library.mediaDir, work.id), { recursive: true });
    const names = ['first', 'mobile', 'first-late', 'mobile-late'].map((name) => `${prefix}${name}.jpg`);
    for (const name of names) writeFileSync(join(library.mediaDir, work.id, name), PNG);
    if (publish) library.setCaptures(work.id, { first: names[0], mobile: names[1] });
    return { captures: { first: names[0], mobile: names[1] }, late: { first: names[2], mobile: names[3] }, texts: ['桌面', '延迟桌面', '手机', '延迟手机'] };
  }, async close() {} };
}

async function setup(run, { mode = 'machine', timeoutMs = 30 * 60_000, perMinute = 120, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dots-moderation-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: '测试', models: [{ id: 'm', name: '模型', vendor: '测试' }],
    tasks: [{ id: 'one', title: '题目', promptPending: false, results: [] }] }));
  const received = [];
  let respond = async () => ({ status: 200, body: reply() });
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    const result = await respond();
    if (!res.destroyed) { res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body)); }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const config = { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost:9', siteOrigins: [], admins: ['admin'], cdn: [],
    capture: false, secureCookies: false,
    moderation: { enabled: true, apiKey: 'test-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'gpt-6-luna',
      mode, dotsTimeoutMs: timeoutMs, dotsRequestsPerMin: perMinute, ...extra } };
  const captures = [];
  const platform = createPlatform({ config, limits, captureFactory: ({ library }) => fakeCapturer(library, captures) });
  const server = createServer(platform.handleSite);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  async function call(who, method, path, body, { raw = false, bearer } = {}) {
    const response = await fetch(base + path, { method,
      headers: { ...(cookies.has(who) ? { Cookie: cookies.get(who) } : {}), ...(method !== 'GET' && !bearer ? { Origin: base } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookies.set(who, response.headers.get('set-cookie').split(';')[0]);
    const data = response.headers.get('content-type')?.includes('application/json') && method !== 'HEAD' ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, headers: response.headers };
  }
  const dots = (token) => (method, path, body) => call(null, method, `/api/dots/moderation${path}`, body, { bearer: token });
  async function raw(token, method, path, body, type = 'application/octet-stream') {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function submit(who = 'owner', more = {}) {
    const draft = await call(who, 'POST', '/api/drafts?task=one&name=work.html', PAGE, { raw: true });
    assert.equal(draft.status, 200);
    const result = await call(who, 'POST', '/api/works', { draftId: draft.data.draft.id, confirmed: true, title: '测试作品',
      modelId: 'm', effort: 'Default', providerId: 'official', harnessOther: '测试工具', generationMode: 'single-turn', humanIntervention: 'none',
      cover: `data:image/png;base64,${PNG.toString('base64')}`, ...more });
    assert.equal(result.status, 200);
    return result.data.work;
  }
  const tokens = createModerationTokens(platform.db);
  const stored = (id) => platform.library.work('one', id).moderation;
  try {
    const admin = platform.auth.createAdmin('admin', 'correct horse');
    platform.auth.bindEmail(admin.id, 'admin@example.test');
    await verifiedUser(platform.auth, 'owner', 'correct horse');
    for (const name of ['admin', 'owner']) assert.equal((await call(name, 'POST', '/api/auth/login', { name, password: 'correct horse' })).status, 200);
    await run({ platform, call, dots, raw, submit, received, captures, config, tokens, stored, root,
      setResponse: (handler) => { respond = handler; } });
  } finally {
    await platform.close();
    for (const instance of [server, provider]) { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); }
    rmSync(root, { recursive: true, force: true });
  }
}

test('a moderation token opens only the four dots actions and every other API refuses it', async () => {
  await setup(async ({ call, dots, submit, tokens, platform }) => {
    const { token, id } = tokens.create('dots-test', 'test');
    const api = dots(token);
    const work = await submit();
    await platform.moderator.idle();
    assert.equal((await api('GET', '/queue')).status, 200);
    assert.equal((await api('GET', `/works/one/${work.id}`)).status, 200);
    for (const [method, path, body] of [['GET', '/api/bootstrap'], ['GET', '/api/admin/moderation-mode'], ['GET', '/api/admin/changelog'],
      ['POST', `/api/works/one/${work.id}/moderation`, { status: 'approved', reason: 'x' }], ['POST', `/api/works/one/${work.id}/moderation/retry`, {}],
      ['POST', '/api/admin/moderation-mode', { mode: 'dots' }], ['DELETE', `/api/works/one/${work.id}`], ['GET', '/api/me']]) {
      const response = await call(null, method, path, body, { bearer: token });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.data.code, 'token_forbidden');
    }
    // An admin cookie does not widen a token request either.
    assert.equal((await call('admin', 'GET', '/api/admin/moderation-mode', undefined, { bearer: token })).status, 403);
    assert.equal((await api('GET', '/other')).status, 404);
    assert.equal((await api('DELETE', '/queue')).status, 405);
    assert.equal((await call(null, 'GET', '/api/dots/moderation/queue')).status, 401);
    const wrong = await dots(`${token.slice(0, -2)}xx`)('GET', '/queue');
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get('www-authenticate'), /Bearer/);
    assert.equal((await dots(`aobd_${id}`)('GET', '/queue')).status, 401);
    // Cookies never open the dots API.
    assert.equal((await call('admin', 'GET', '/api/dots/moderation/queue')).status, 401);
  }, { mode: 'dots' });
});

test('only the SHA-256 hash is stored, revocation is immediate and audit rows never hold the token', async () => {
  await setup(async ({ dots, tokens, platform }) => {
    const created = tokens.create('dots-test', 'test');
    const row = platform.db.prepare('SELECT * FROM moderation_tokens WHERE id = ?').get(created.id);
    assert.equal(row.token_hash, createHash('sha256').update(created.token).digest('hex'));
    assert.doesNotMatch(JSON.stringify(platform.db.prepare('SELECT * FROM moderation_tokens').all()), new RegExp(created.token.split('_')[2]));
    assert.equal(tokens.list().some((item) => 'token_hash' in item || 'token' in item), false);
    const api = dots(created.token);
    assert.equal((await api('GET', '/queue')).status, 200);
    assert.ok(tokens.list()[0].last_used_at);
    assert.equal(tokens.revoke(created.id), true);
    assert.equal((await api('GET', '/queue')).status, 401);
    const dump = JSON.stringify(platform.db.prepare('SELECT * FROM moderation_token_audit').all());
    assert.doesNotMatch(dump, new RegExp(created.token.split('_')[2]));
  });
});

test('dots mode holds new submissions for dots, captures screenshots and records an audited decision', async () => {
  await setup(async ({ dots, submit, received, captures, tokens, stored, platform }) => {
    const { token, id } = tokens.create('dots-test', 'test');
    const api = dots(token);
    const work = await submit();
    await platform.moderator.idle();
    await until(() => captures.includes(work.id));
    assert.equal(received.length, 0, 'the machine is not asked while dots holds the work');
    assert.equal(stored(work.id).status, 'pending');
    assert.equal(stored(work.id).route, 'dots');
    const queue = await api('GET', '/queue');
    assert.deepEqual(queue.data.items.map((item) => item.id), [work.id]);
    assert.equal(queue.data.items[0].stage, 'dots');
    assert.ok(Date.parse(queue.data.items[0].deadline) > Date.now());
    const view = await api('GET', `/works/one/${work.id}`);
    assert.equal(view.status, 200);
    assert.ok(view.data.work.images.some((image) => image.name === 'first.jpg'));
    const image = await api('GET', `/works/one/${work.id}/images/first.jpg`);
    assert.equal(image.status, 200);
    assert.deepEqual(image.data, PNG);
    assert.equal((await api('GET', `/works/one/${work.id}/images/..%2Fplatform.db`)).status, 404);
    const file = await api('GET', `/works/one/${work.id}/file?path=index.html`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await api('GET', `/works/one/${work.id}/file?path=../../platform.db`)).status, 404);

    assert.equal((await api('POST', `/works/one/${work.id}/approve`, { version: 'old.0' })).data.code, 'stale');
    assert.equal(stored(work.id).status, 'pending');
    const missing = await api('POST', `/works/one/${work.id}/reject`, { reason: '  ', version: view.data.work.version });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, 'reason_required');
    assert.equal(stored(work.id).status, 'pending');
    const rejected = await api('POST', `/works/one/${work.id}/reject`, { reason: '含不当内容', version: view.data.work.version });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.applied, true);
    const decided = stored(work.id);
    assert.equal(decided.status, 'rejected');
    assert.equal(decided.source, 'dots');
    assert.equal(decided.reviewer, 'dots:dots-test');
    assert.equal(decided.reason, '含不当内容');
    const again = await api('POST', `/works/one/${work.id}/reject`, { reason: '含不当内容' });
    assert.equal(again.data.applied, false);
    const flipped = await api('POST', `/works/one/${work.id}/approve`, {});
    assert.equal(flipped.status, 409);
    assert.equal(flipped.data.code, 'not_in_queue');
    assert.equal((await api('GET', '/queue')).data.items.length, 0);
    assert.equal(received.length, 0);

    const audit = platform.db.prepare('SELECT * FROM moderation_token_audit ORDER BY id').all();
    const actions = audit.map((row) => `${row.action}:${row.outcome}`);
    assert.deepEqual(actions.slice(-6), ['approve:error:409:stale', 'reject:error:400:reason_required', 'reject:ok', 'reject:ok', 'approve:error:409:not_in_queue', 'list:ok']);
    assert.equal(audit.find((row) => row.outcome.includes('reason_required')).reason, '');
    const ok = audit.find((row) => row.action === 'reject' && row.outcome === 'ok');
    assert.equal(ok.token_id, id);
    assert.equal(ok.token_label, 'dots-test');
    assert.equal(ok.task_id, 'one');
    assert.equal(ok.work_id, work.id);
    assert.equal(ok.reason, '含不当内容');
    assert.ok(ok.ip);
    assert.ok(Math.abs(ok.at - Date.now()) < 60_000);
    assert.ok(audit.some((row) => row.action === 'list') && audit.some((row) => row.action === 'view'));
    const content = platform.db.prepare("SELECT * FROM audit WHERE action = 'content-review' AND work_id = ?").all(work.id);
    assert.equal(content.length, 1);
    assert.equal(content[0].actor_name, 'dots:dots-test');
  }, { mode: 'dots' });
});

test('machine mode keeps the machine path and dots sees nothing', async () => {
  await setup(async ({ dots, submit, received, tokens, stored, platform }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    const work = await submit();
    assert.equal(stored(work.id).route, undefined);
    await platform.moderator.idle();
    assert.equal(received.length, 1);
    assert.equal(stored(work.id).status, 'approved');
    assert.equal((await api('GET', '/queue')).data.items.length, 0);
    assert.equal((await api('POST', `/works/one/${work.id}/approve`, {})).status, 409);
  });
});

test('dots-review-only lets the machine decide first and hands only its human-review results to dots', async () => {
  await setup(async ({ dots, submit, received, tokens, stored, platform, setResponse, call }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    const clean = await submit();
    await platform.moderator.idle();
    assert.equal(stored(clean.id).status, 'approved');
    setResponse(async () => ({ status: 200, body: reply('review', '需要人工判断') }));
    const unsure = await submit();
    await platform.moderator.idle();
    assert.equal(received.length, 2);
    assert.equal(stored(unsure.id).status, 'review');
    assert.equal(stored(unsure.id).route, 'dots-review-only');
    // Still in the ordinary human queue at the same time.
    assert.equal((await call('admin', 'GET', '/api/bootstrap')).data.review.content, 1);
    const queue = (await api('GET', '/queue')).data.items;
    assert.deepEqual(queue.map((item) => [item.id, item.stage]), [[unsure.id, 'review-only']]);
    assert.equal((await api('POST', `/works/one/${unsure.id}/approve`, { reason: '看过了，正常' })).status, 200);
    assert.equal(stored(unsure.id).status, 'approved');
    assert.equal(stored(unsure.id).source, 'dots');
    assert.equal((await api('POST', `/works/one/${clean.id}/reject`, { reason: 'x' })).status, 409);
  }, { mode: 'dots-review-only' });
});

test('dots-review-only timeout leaves the work with people, not the machine', async () => {
  await setup(async ({ dots, submit, received, tokens, stored, platform, setResponse, call }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    setResponse(async () => ({ status: 200, body: reply('review', '需要人工判断') }));
    const work = await submit();
    await platform.moderator.idle();
    assert.equal((await api('GET', '/queue')).data.items.length, 1);
    await wait(400);
    assert.equal((await api('GET', '/queue')).data.items.length, 0);
    assert.equal((await api('POST', `/works/one/${work.id}/approve`, {})).status, 409);
    assert.equal(stored(work.id).status, 'review');
    assert.equal(received.length, 1, 'no second machine pass');
    assert.equal((await call('admin', 'POST', `/api/works/one/${work.id}/moderation`, { status: 'approved', reason: '人工通过' })).status, 200);
    assert.equal(stored(work.id).status, 'approved');
  }, { mode: 'dots-review-only', timeoutMs: 300 });
});

test('dots timeout hands the work to the machine, also after a restart, measured from the stored queue time', async () => {
  await setup(async ({ submit, received, stored, platform }) => {
    const work = await submit();
    await wait(200);
    assert.equal(received.length, 0);
    await until(() => stored(work.id).status !== 'pending');
    assert.equal(received.length, 1);
    assert.equal(stored(work.id).status, 'approved');
    assert.equal(stored(work.id).fallback, 'dots-timeout');
  }, { mode: 'dots', timeoutMs: 400 });

  await setup(async ({ submit, received, stored, platform, config }) => {
    const work = await submit();
    await platform.moderator.idle();
    assert.equal(received.length, 0);
    // Simulate a process that was down past the deadline: only the stored time moved.
    const moderation = { ...stored(work.id), at: Date.now() - config.moderation.dotsTimeoutMs - 1 };
    platform.db.prepare('UPDATE works SET moderation = ? WHERE id = ?').run(JSON.stringify(moderation), work.id);
    const restarted = createModerator({ config, library: platform.library, capturer: fakeCapturer(platform.library),
      routing: { current: 'dots', timeoutMs: config.moderation.dotsTimeoutMs } });
    try {
      await until(() => stored(work.id).status !== 'pending');
      assert.equal(stored(work.id).status, 'approved');
      assert.equal(stored(work.id).fallback, 'dots-timeout');
      assert.equal(received.length, 1);
    } finally { await restarted.close(); }
  }, { mode: 'dots', timeoutMs: 60 * 60_000 });
});

test('dots and the machine racing for one work: the first decision wins and the other changes nothing', async () => {
  await setup(async ({ dots, submit, received, tokens, stored, platform, setResponse }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    setResponse(async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { status: 200, body: reply('rejected', '机器打回') }; });
    const work = await submit();
    await started; // deadline passed and the machine is now deciding
    const first = await api('POST', `/works/one/${work.id}/approve`, { reason: 'dots 先到' });
    assert.equal(first.status, 200);
    assert.equal(first.data.applied, true);
    release();
    await platform.moderator.idle();
    assert.equal(received.length, 1);
    assert.equal(stored(work.id).status, 'approved');
    assert.equal(stored(work.id).source, 'dots');

    setResponse(async () => ({ status: 200, body: reply('rejected', '机器打回') }));
    const second = await submit();
    await until(() => stored(second.id).status !== 'pending');
    assert.equal(stored(second.id).status, 'rejected');
    const late = await api('POST', `/works/one/${second.id}/approve`, {});
    assert.equal(late.status, 409);
    assert.equal(late.data.current.status, 'rejected');
    assert.equal(stored(second.id).status, 'rejected');
    const decisions = platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'content-review'").get().n;
    assert.equal(decisions, 2);
  }, { mode: 'dots', timeoutMs: 200 });
});

test('concurrent dots decisions on one work apply once', async () => {
  await setup(async ({ dots, submit, tokens, stored, platform }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    const work = await submit();
    const results = await Promise.all([
      api('POST', `/works/one/${work.id}/approve`, {}), api('POST', `/works/one/${work.id}/reject`, { reason: '不行' }),
    ]);
    assert.equal(results.filter((result) => result.status === 200 && result.data.applied).length, 1);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'content-review' AND work_id = ?").get(work.id).n, 1);
    assert.ok(['approved', 'rejected'].includes(stored(work.id).status));
  }, { mode: 'dots' });
});

test('works queued before the switch keep the machine path; switching modes is a hot admin setting', async () => {
  await setup(async ({ call, dots, submit, received, tokens, stored, platform, setResponse }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    let release;
    setResponse(async () => { await new Promise((resolve) => { release = resolve; }); return { status: 200, body: reply('review', '人工') }; });
    const queued = await submit();
    await until(() => received.length === 1);
    const shown = await call('admin', 'POST', '/api/admin/moderation-mode', { mode: 'dots' });
    assert.equal(shown.status, 200);
    assert.equal(shown.data.mode, 'dots');
    assert.equal(shown.data.env, 'machine');
    assert.equal((await call('owner', 'POST', '/api/admin/moderation-mode', { mode: 'machine' })).status, 403);
    assert.equal((await call('admin', 'POST', '/api/admin/moderation-mode', { mode: 'nope' })).status, 400);
    release();
    await platform.moderator.idle();
    assert.equal(stored(queued.id).status, 'review');
    assert.equal(stored(queued.id).route, undefined);
    assert.equal((await api('GET', '/queue')).data.items.length, 0);
    assert.equal((await api('POST', `/works/one/${queued.id}/approve`, {})).status, 409);
    assert.equal((await api('GET', `/works/one/${queued.id}`)).status, 404);

    setResponse(async () => ({ status: 200, body: reply() }));
    const fresh = await submit();
    assert.equal(stored(fresh.id).route, 'dots');
    // Back to the environment value (machine): held dots work goes to the machine at once.
    assert.equal((await call('admin', 'POST', '/api/admin/moderation-mode', { mode: 'env' })).data.mode, 'machine');
    await until(() => stored(fresh.id).status !== 'pending');
    assert.equal(stored(fresh.id).status, 'approved');
    assert.equal(stored(fresh.id).fallback, 'mode-change');
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'moderation-mode'").get().n, 2);
  });
});

test('migrations 48 and 49 add tables to a populated v47 database without touching existing rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-v47-'));
  try {
    assert.equal(MIGRATIONS.length, 49);
    const file = join(root, 'platform.db');
    openDatabase(file).close();
    const now = Date.now();
    // Turn the fresh database back into v47 and fill works with every moderation shape.
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = OFF; DROP TABLE moderation_tokens; DROP TABLE moderation_token_audit; DROP TABLE moderation_settings; DROP TABLE cover_history; PRAGMA user_version = 47;');
    let serial = 0;
    const fill = (table, fixed) => {
      const values = { ...fixed };
      for (const column of raw.prepare(`PRAGMA table_info(${table})`).all()) {
        if (column.name in values || column.dflt_value !== null || !column.notnull) continue;
        values[column.name] = /INT/i.test(column.type) ? 0 : `${column.name}-${serial += 1}`;
      }
      const names = Object.keys(values);
      raw.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((name) => values[name]));
    };
    const shapes = [{ status: 'pending', revision: 'r1', at: now }, { status: 'review', reason: '人工', error: 'capture_incomplete', at: now },
      { status: 'approved', at: now }, { status: 'rejected', at: now }, { status: 'legacy' }];
    shapes.forEach((moderation, index) => fill('works', { id: `w${index}`, moderation: JSON.stringify(moderation) }));
    const before = raw.prepare('SELECT * FROM works ORDER BY id').all();
    raw.close();
    const upgraded = openDatabase(file);
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 49);
    assert.deepEqual(upgraded.prepare('SELECT * FROM works ORDER BY id').all(), before);
    for (const table of ['moderation_tokens', 'moderation_token_audit', 'moderation_settings', 'cover_history']) {
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n, 1);
    }
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM moderation_settings').get().n, 0);
    upgraded.close();
    const again = openDatabase(file);
    assert.deepEqual(again.prepare('SELECT * FROM works ORDER BY id').all(), before);
    again.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the per-token rate limit answers 429 with Retry-After', async () => {
  await setup(async ({ dots, tokens }) => {
    const api = dots(tokens.create('dots-test', 'test').token);
    for (let i = 0; i < 3; i += 1) assert.equal((await api('GET', '/queue')).status, 200);
    const limited = await api('GET', '/queue');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }, { perMinute: 3 });
});

// A real, decodable PNG of the given size.
import { deflateSync } from 'node:zlib';
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const WEBP = (width, height) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0); b.writeUInt32LE(32, 4); b.write('WEBPVP8X', 8); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
};

test('scopes are granted per token, withdrawn one at a time, and closed by the emergency switches', async () => {
  await setup(async ({ call, dots, raw, submit, tokens, platform }) => {
    const work = await submit();
    await platform.moderator.idle();
    const mod = tokens.create('mod', 'test');
    assert.deepEqual(mod.scopes, ['moderation']);
    const cap = tokens.create('cap', 'test', 'capture:read,cover:write');
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: mod.token })).data.code, 'scope_required');
    assert.equal((await raw(mod.token, 'PUT', `/api/dots/works/one/${work.id}/cover`, png(80, 80))).status, 403);
    assert.equal((await dots(cap.token)('GET', '/queue')).data.code, 'scope_required');
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: cap.token })).status, 200);
    // Scoped tokens still cannot reach anything outside the dots whitelist.
    assert.equal((await call(null, 'GET', `/api/works/one/${work.id}/cover-history`, undefined, { bearer: cap.token })).status, 403);
    assert.equal((await call(null, 'POST', `/api/works/one/${work.id}/cover/rollback`, {}, { bearer: cap.token })).status, 403);

    assert.deepEqual(tokens.withdraw(cap.id, 'capture:read'), ['cover:write']);
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: cap.token })).status, 403);
    assert.deepEqual(tokens.grant(cap.id, 'capture:read'), ['capture:read', 'cover:write']);
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: cap.token })).status, 200);
    assert.throws(() => tokens.grant(cap.id, 'admin'), /未知权限/);
    tokens.revoke(cap.id);
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: cap.token })).status, 401);
    assert.throws(() => tokens.grant(cap.id, 'moderation'), /已吊销/);
    const audit = platform.db.prepare("SELECT outcome FROM moderation_token_audit WHERE token_label = 'cap'").all().map((row) => row.outcome);
    assert.ok(audit.includes('error:403:scope_required'));
  });
  await setup(async ({ call, raw, submit, tokens, platform }) => {
    const work = await submit();
    await platform.moderator.idle();
    const all = tokens.create('all', 'test', 'moderation,capture:read,cover:write');
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed', undefined, { bearer: all.token })).status, 200);
    const closed = await raw(all.token, 'PUT', `/api/dots/works/one/${work.id}/cover`, png(80, 80));
    assert.equal(closed.status, 503);
    assert.equal(closed.data.code, 'scope_disabled');
  }, { extra: { dotsDisabledScopes: ['cover:write'] } });
  await setup(async ({ dots, tokens }) => {
    const all = tokens.create('all', 'test', 'moderation,capture:read,cover:write');
    const closed = await dots(all.token)('GET', '/queue');
    assert.equal(closed.status, 503);
    assert.equal(closed.data.code, 'dots_disabled');
  }, { extra: { dotsApiOff: true } });
});

test('capture:read lists capture_incomplete works and works without a first screen, not coverless ones', async () => {
  await setup(async ({ call, raw, submit, tokens, platform, stored }) => {
    const token = tokens.create('cap', 'test', 'capture:read,cover:write').token;
    const captured = await submit();
    const coverless = await submit('owner', { cover: null, note: '作者的私密备注' });
    const incomplete = await submit();
    const noFirst = await submit();
    const manual = await submit('owner', { cover: null });
    await platform.moderator.idle();
    for (const work of [captured, coverless, incomplete, noFirst, manual]) assert.ok(platform.library.work('one', work.id).captures.first);
    platform.db.prepare('UPDATE works SET moderation = ? WHERE id = ?')
      .run(JSON.stringify({ ...stored(incomplete.id), status: 'review', error: 'capture_incomplete' }), incomplete.id);
    platform.library.setCaptures(noFirst.id, { mobile: 'mobile.jpg' });
    platform.library.setCaptures(manual.id, {});
    assert.equal((await raw(token, 'PUT', `/api/dots/works/one/${manual.id}/cover`, png(120, 120))).status, 200);

    const list = async (query = '') => {
      const seen = [];
      let cursor = null;
      let pages = 0;
      do {
        const page = await call(null, 'GET', `/api/dots/captures/failed?limit=1${query}${cursor ? `&cursor=${cursor}` : ''}`, undefined, { bearer: token });
        assert.equal(page.status, 200);
        assert.ok(page.data.items.length <= 1);
        seen.push(...page.data.items);
        cursor = page.data.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      return seen;
    };
    const seen = await list();
    const expected = [incomplete.id, noFirst.id, manual.id].sort();
    assert.deepEqual(seen.map((item) => item.id), expected, 'paged in id order, each once');
    const byId = Object.fromEntries(seen.map((item) => [item.id, item]));
    assert.deepEqual(byId[incomplete.id].reasons, ['capture_incomplete']);
    assert.deepEqual(byId[incomplete.id].screenshots, { first: true, mobile: true });
    assert.deepEqual(byId[noFirst.id].reasons, ['no_first_capture']);
    assert.deepEqual(byId[noFirst.id].screenshots, { first: false, mobile: true });
    assert.equal(byId[noFirst.id].hasManualCover, false);
    assert.equal(byId[manual.id].hasManualCover, true);
    assert.equal(byId[manual.id].hasCover, true);
    for (const item of seen) assert.deepEqual(Object.keys(item).sort(), ['hasCover', 'hasManualCover', 'id', 'reasons', 'screenshots', 'status', 'submittedAt', 'task', 'title']);
    assert.doesNotMatch(JSON.stringify(seen), /owner|作者的私密备注|@/);
    assert.ok(!seen.some((item) => [captured.id, coverless.id].includes(item.id)), 'a first screen without a cover is not a capture gap');

    assert.deepEqual((await list('&manualCover=exclude')).map((item) => item.id), [incomplete.id, noFirst.id].sort());
    assert.deepEqual((await list('&manualCover=only')).map((item) => item.id), [manual.id]);
    const big = await call(null, 'GET', '/api/dots/captures/failed?limit=100', undefined, { bearer: token });
    assert.equal(big.data.items.length, 3);
    assert.equal(big.data.nextCursor, null);
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed?cursor=%2E%2E', undefined, { bearer: token })).status, 400);
    assert.equal((await call(null, 'GET', '/api/dots/captures/failed?manualCover=maybe', undefined, { bearer: token })).status, 400);
  });
});

test('cover:write replaces only the cover, checks bytes not headers, keeps history and refreshes the public cache', async () => {
  await setup(async ({ call, raw, submit, tokens, platform, root }) => {
    const { token, id } = tokens.create('cover', 'test', 'cover:write');
    const work = await submit();
    await platform.moderator.idle();
    let before = platform.db.prepare('SELECT * FROM works WHERE id = ?').get(work.id);
    const filesBefore = platform.db.prepare('SELECT digest, file_count, bytes FROM works WHERE id = ?').get(work.id);
    const path = `/api/dots/works/one/${work.id}/cover`;
    // Automatic (and dots) approval only reaches previews; a manual approval publishes.
    assert.equal((await call('admin', 'POST', `/api/works/one/${work.id}/moderation`, { status: 'approved' })).status, 200);
    before = platform.db.prepare('SELECT * FROM works WHERE id = ?').get(work.id);
    const publicCover = async () => (await call(null, 'GET', '/api/bootstrap')).data.works.find((item) => item.id === work.id)?.cover;
    const original = await publicCover();
    assert.ok(original, 'approved work is public');

    // Rejected inputs, whatever the declared type says.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>');
    assert.equal((await raw(token, 'PUT', path, svg, 'image/png')).data.code, 'unsupported_type');
    assert.equal((await raw(token, 'PUT', path, Buffer.from('GIF89a' + '\0'.repeat(40)), 'image/png')).data.code, 'unsupported_type');
    assert.equal((await raw(token, 'PUT', path, png(32, 32))).data.code, 'bad_dimensions');
    assert.equal((await raw(token, 'PUT', path, png(5000, 64))).data.code, 'bad_dimensions');
    assert.equal((await raw(token, 'PUT', path, Buffer.concat([png(80, 80), Buffer.alloc(3 * 1024 * 1024)]))).status, 413);
    assert.equal((await raw(token, 'PUT', path, Buffer.alloc(0))).data.code, 'invalid_image');
    // Trying to smuggle metadata changes is just a bad image.
    const meta = await raw(token, 'PUT', path, JSON.stringify({ modelId: 'other', modelName: 'X', title: 'Y', files: {} }), 'application/json');
    assert.equal(meta.status, 415);
    assert.equal((await raw(token, 'PUT', `/api/dots/works/one/${work.id}/files`, png(80, 80))).status, 404);
    assert.equal((await raw(token, 'PATCH', path, png(80, 80))).status, 405);
    assert.deepEqual(platform.db.prepare('SELECT * FROM works WHERE id = ?').get(work.id), before);

    for (const [image, type] of [[JPEG(640, 360), 'image/jpeg'], [WEBP(800, 450), 'image/webp'], [png(1200, 630), 'image/svg+xml']]) {
      const done = await raw(token, 'PUT', path, image, type);
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.equal(done.data.type, { 'image/svg+xml': 'image/png' }[type] ?? type);
    }
    const after = platform.db.prepare('SELECT * FROM works WHERE id = ?').get(work.id);
    assert.match(after.cover, /^cover-[a-z0-9]+\.png$/);
    // Nothing but the cover changed: files, model and labels are untouched.
    const { cover: _a, ...restBefore } = before;
    const { cover: _b, ...restAfter } = after;
    assert.deepEqual(restAfter, restBefore);
    assert.deepEqual(platform.db.prepare('SELECT digest, file_count, bytes FROM works WHERE id = ?').get(work.id), filesBefore);
    const internal = platform.library.work('one', work.id);
    assert.equal(internal.modelId, 'm');

    // Public cache follows at once; the new file is served and the old ones stay on disk.
    const current = await publicCover();
    assert.notEqual(current, original);
    assert.match(current, new RegExp(`${after.cover}$`));
    assert.equal((await call(null, 'GET', `/${current.replace(/^\//, '')}`)).status, 200);
    const mediaDir = join(root, 'state', 'media', work.id);
    const { readdirSync, existsSync } = await import('node:fs');
    const names = readdirSync(mediaDir);
    assert.ok(names.includes(before.cover));
    assert.equal(names.filter((name) => /^cover-/.test(name)).length, 3);

    // History, audit and a screenshot snapshot per change.
    const history = (await call('admin', 'GET', `/api/works/one/${work.id}/cover-history`)).data;
    assert.equal(history.entries.length, 3);
    assert.equal(history.entries[2].previous, before.cover);
    assert.equal(history.entries[0].actor, 'dots:cover');
    assert.ok(existsSync(join(mediaDir, history.entries[0].snapshot, 'first.jpg')));
    const tokenAudit = platform.db.prepare("SELECT * FROM moderation_token_audit WHERE action = 'cover-replace' AND outcome = 'ok'").all();
    assert.equal(tokenAudit.length, 3);
    assert.equal(tokenAudit[0].token_id, id);
    assert.equal(tokenAudit[0].work_id, work.id);
    assert.ok(tokenAudit[0].ip);
    assert.ok(platform.db.prepare("SELECT COUNT(*) AS n FROM moderation_token_audit WHERE action = 'cover-replace' AND outcome LIKE 'error:%'").get().n >= 6);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'cover-replace' AND work_id = ?").get(work.id).n, 3);

    // A re-capture rewrites screenshots but never the cover.
    assert.equal((await call('admin', 'POST', `/api/works/one/${work.id}/moderation/retry`, {})).status, 200);
    await platform.moderator.idle();
    assert.equal(platform.db.prepare('SELECT cover FROM works WHERE id = ?').get(work.id).cover, after.cover);
    assert.equal((await call('admin', 'POST', `/api/works/one/${work.id}/moderation`, { status: 'approved' })).status, 200);
    assert.equal(await publicCover(), current);

    // Rollback: admins only, back to the previous file, itself undoable.
    assert.equal((await call('owner', 'POST', `/api/works/one/${work.id}/cover/rollback`, {})).status, 403);
    const back = await call('admin', 'POST', `/api/works/one/${work.id}/cover/rollback`, { historyId: history.entries[2].id });
    assert.equal(back.status, 200);
    assert.equal(platform.db.prepare('SELECT cover FROM works WHERE id = ?').get(work.id).cover, before.cover);
    assert.equal(await publicCover(), original);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'cover-rollback'").get().n, 1);
    const undo = await call('admin', 'POST', `/api/works/one/${work.id}/cover/rollback`, {});
    assert.equal(undo.status, 200);
    assert.equal(platform.db.prepare('SELECT cover FROM works WHERE id = ?').get(work.id).cover, after.cover);
  });
});

test('a cover upload loses to a concurrent change instead of overwriting it', async () => {
  await setup(async ({ raw, submit, tokens, platform }) => {
    const token = tokens.create('cover', 'test', 'cover:write').token;
    const work = await submit();
    await platform.moderator.idle();
    const results = await Promise.all([1, 2, 3].map(() => raw(token, 'PUT', `/api/dots/works/one/${work.id}/cover`, png(100, 100))));
    const ok = results.filter((result) => result.status === 200).length;
    assert.ok(ok >= 1);
    const entries = platform.db.prepare('SELECT * FROM cover_history WHERE work_id = ? ORDER BY id').all(work.id);
    assert.equal(entries.length, ok);
    // Each accepted change starts from the cover the previous one left.
    for (let i = 1; i < entries.length; i++) assert.equal(entries[i].previous, entries[i - 1].next);
    assert.equal(platform.db.prepare('SELECT cover FROM works WHERE id = ?').get(work.id).cover, entries.at(-1).next);
  });
});

test('migration 49 gives tokens created under v48 the moderation scope only', () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-v48-'));
  try {
    const file = join(root, 'platform.db');
    const db = new DatabaseSync(file);
    for (let step = 0; step < 48; step++) {
      if (typeof MIGRATIONS[step] === 'function') MIGRATIONS[step](db); else db.exec(MIGRATIONS[step]);
    }
    db.exec('PRAGMA user_version = 48');
    db.prepare("INSERT INTO moderation_tokens (id, label, token_hash, created_at, created_by) VALUES ('aaaaaaaaaaaa', 'old', ?, 1, 'cli')").run('0'.repeat(64));
    db.close();
    const upgraded = openDatabase(file);
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 49);
      assert.deepEqual(createModerationTokens(upgraded).list().map((row) => [row.id, row.scopes]), [['aaaaaaaaaaaa', ['moderation']]]);
      MIGRATIONS[48](upgraded);
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
