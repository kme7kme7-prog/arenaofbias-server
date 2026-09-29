import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

const PAGE = '<!doctype html><html><body>Provenance</body></html>';
const pack = (root, registries = true) => {
  const dist = join(root, 'dist');
  for (const id of ['a1', 'b1']) {
    mkdirSync(join(dist, 'results', 'one', id), { recursive: true });
    writeFileSync(join(dist, 'results', 'one', id, 'index.html'), PAGE + id);
  }
  writeFileSync(join(dist, 'data.json'), JSON.stringify({
    title: 'test', models: [{ id: 'm-a', name: 'Model A', vendor: 'VA' }, { id: 'm-b', name: 'Model B', vendor: 'VB' }],
    ...(registries ? { harnesses: [{ id: 'codex', name: 'Codex', listed: true }],
      providers: [{ id: 'official', name: '官方', listed: true }] } : {}),
    tasks: [{ id: 'one', title: 'One', results: [
      { id: 'a1', model: 'm-a', effort: 'High', title: 'A1', scene: 'results/one/a1/', harness: 'codex', harnessVersion: '1', provider: 'official' },
      { id: 'b1', model: 'm-b', title: 'B1', scene: 'results/one/b1/' },
    ] }],
  }));
  return dist;
};

test('v15 upgrades to v16 without changing rows and v16 constraints remain idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-migrate-'));
  const file = join(root, 'platform.db');
  const old = new DatabaseSync(file);
  try {
    for (const step of MIGRATIONS.slice(0, 15)) typeof step === 'function' ? step(old) : old.exec(step);
    old.exec('PRAGMA user_version = 15');
    old.prepare(`INSERT INTO works (id, task_id, owner_id, title, summary, model_id, model_name, vendor, effort, tool, note, content_key,
      source_name, root, entry, file_count, bytes, digest, checks, trial, created_at, updated_at)
      VALUES ('up-old', 'one', NULL, 'Old', '', NULL, 'M', '', '', 'Codex', '', 'key', 'x', '', 'index.html', 1, 1, 'digest', '[]', '{}', 1, 1)`).run();
  } finally { old.close(); }
  const db = openDatabase(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    const before = db.prepare('SELECT * FROM works WHERE id = ?').get('up-old');
    assert.deepEqual([before.harness_id, before.harness_other, before.harness_version, before.provider_id, before.provider_other],
      [null, '', '', null, '']);
    MIGRATIONS[15](db);
    assert.deepEqual(db.prepare('SELECT * FROM works WHERE id = ?').get('up-old'), before);
    for (const value of ['Claude Code', '', 'x'.repeat(41)])
      assert.throws(() => db.prepare('UPDATE works SET harness_id = ? WHERE id = ?').run(value, 'up-old'), /CHECK constraint failed/);
    assert.throws(() => db.prepare('UPDATE works SET harness_version = ? WHERE id = ?').run('x'.repeat(41), 'up-old'), /CHECK constraint failed/);
    db.prepare('UPDATE works SET harness_id = ?, provider_id = ? WHERE id = ?').run('claude-code', 'aws-bedrock', 'up-old');
    assert.equal(db.prepare('SELECT harness_id FROM works WHERE id = ?').get('up-old').harness_id, 'claude-code');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('catalog tolerates an old pack with no registries', () => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-old-pack-'));
  try {
    const catalog = createCatalog(pack(root, false));
    assert.deepEqual(catalog.harnesses(), []);
    assert.deepEqual(catalog.providers(), []);
    assert.equal(catalog.harness('codex'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an old pack accepts a custom Harness but no registry ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-old-api-'));
  const dist = pack(root, false);
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: '',
    siteOrigins: ['http://127.0.0.1'], admins: [], cdn: [], capture: false,
    secureCookies: false, trustProxy: false }, limits });
  const site = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => site.once('listening', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  let cookie = '';
  const call = async (method, path, body, raw = false) => {
    const response = await fetch(base + path, { method, headers: {
      origin: base, ...(cookie ? { cookie } : {}), ...(raw ? {} : { 'content-type': 'application/json' }),
    }, body: raw ? body : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  try {
    assert.equal((await call('POST', '/api/auth/register', { name: 'alice', password: 'correct horse' })).status, 200);
    const draft = await call('POST', '/api/drafts?task=one&name=work.html', PAGE, true);
    assert.equal(draft.status, 200);
    const body = { draftId: draft.data.draft.id, confirmed: true, title: 'Old pack upload', modelId: 'm-a' };
    assert.equal((await call('POST', '/api/works', { ...body, harnessId: 'codex' })).status, 400);
    const custom = await call('POST', '/api/works', { ...body, harnessOther: 'Local tool' });
    assert.equal(custom.status, 200);
    assert.equal(custom.data.work.harnessName, 'Local tool');
  } finally {
    await new Promise((resolve) => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('submission, review, metadata, export and vote snapshots carry provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-api-'));
  const dist = pack(root);
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: '',
    siteOrigins: ['http://127.0.0.1'], admins: ['root'], cdn: [], capture: false,
    secureCookies: false, trustProxy: false }, limits });
  const site = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => site.once('listening', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const jars = new Map();
  const call = async (who, method, path, body, raw = false) => {
    const headers = { origin: base };
    if (jars.get(who)) headers.cookie = jars.get(who);
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jars.set(who, cookie.split(';')[0]);
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  const draft = async () => {
    const result = await call('alice', 'POST', '/api/drafts?task=one&name=work.html', PAGE, true);
    assert.equal(result.status, 200);
    return result.data.draft.id;
  };
  try {
    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
    assert.equal((await call('alice', 'POST', '/api/auth/register', { name: 'alice', password: 'correct horse' })).status, 200);
    const curated = platform.library.toPublic(platform.library.work('one', 'a1'));
    assert.deepEqual([curated.harness, curated.harnessName, curated.harnessVersion, curated.provider, curated.providerName],
      ['codex', 'Codex', '1', 'official', '官方']);
    const baseBody = { draftId: await draft(), confirmed: true, title: 'Candidate', modelId: 'm-a' };
    for (const bad of [{}, { harnessId: 'missing' }, { harnessId: 'codex', harnessOther: 'Other' },
      { harnessVersion: '1' }, { providerId: 'missing', tool: 'CLI' }]) {
      const response = await call('alice', 'POST', '/api/works', { ...baseBody, ...bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    const first = await call('alice', 'POST', '/api/works', { ...baseBody, harnessId: 'codex', harnessVersion: '2', providerId: 'official' });
    assert.equal(first.status, 200);
    const id = first.data.work.id;
    assert.deepEqual([first.data.work.harness, first.data.work.harnessName, first.data.work.providerName, first.data.work.tool],
      ['codex', 'Codex', '官方', 'Codex']);
    const other = await call('alice', 'POST', '/api/works', { ...baseBody, draftId: await draft(), harnessOther: ' 自制工具 ', providerOther: ' 本地服务 ' });
    assert.equal(other.status, 200);
    assert.deepEqual([other.data.work.harnessName, other.data.work.providerName, other.data.work.tool], ['自制工具', '本地服务', '自制工具']);
    const legacy = await call('alice', 'POST', '/api/works', { ...baseBody, draftId: await draft(), tool: '原始工具' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.work.harness, null);
    const meta = `/api/admin/works/one/${id}/meta`;
    assert.equal((await call('root', 'POST', meta, { harnessOther: '备用工具', providerOther: '其他服务' })).data.work.harnessName, '备用工具');
    const cleared = await call('root', 'POST', meta, { harnessId: null, providerId: null });
    assert.deepEqual([cleared.data.work.harness, cleared.data.work.harnessName, cleared.data.work.harnessVersion,
      cleared.data.work.providerName], [null, null, '', null]);
    const reviewed = await call('root', 'POST', `/api/works/one/${id}/review`,
      { status: 'verified', show_gallery: true, harnessId: 'codex', harnessVersion: '3', providerId: 'official' });
    assert.equal(reviewed.status, 200);
    assert.equal(platform.library.work('one', id).harnessVersion, '3');
    const nomination = await call('root', 'POST', `/api/admin/works/one/${id}/nominate`);
    assert.equal(nomination.status, 200);
    const exported = await call('alice', 'GET', new URL(nomination.data.exportUrl).pathname);
    assert.equal(exported.status, 200);
    assert.deepEqual([exported.data.harnessId, exported.data.harnessOther, exported.data.harnessVersion,
      exported.data.providerId, exported.data.providerOther], ['codex', '', '3', 'official', '']);
    for (const work of ['a1', 'b1']) platform.db.prepare(`INSERT INTO work_overrides
      (task_id, work_id, show_gallery, show_arena, updated_by, updated_at) VALUES ('one', ?, 1, 1, 'root', 0)`).run(work);
    const alice = platform.auth.userFrom({ headers: { cookie: jars.get('alice') } });
    const match = await platform.arena.createMatch(alice, 'one');
    const saved = platform.db.prepare('SELECT a_identity, b_identity FROM matches WHERE id = ?').get(match.id);
    const identity = JSON.parse(saved.a_identity);
    assert.deepEqual([identity.harnessId, identity.harnessVersion, identity.providerId],
      identity.id === 'a1' ? ['codex', '1', 'official'] : [null, '', null]);
    assert.equal(identity.configKey, `${identity.modelKey}|${identity.effortKey}`);
    assert.equal(platform.arena.vote(alice, match.id, 'a').counted, true);
    const vote = platform.db.prepare('SELECT id FROM votes WHERE match_id = ?').get(match.id);
    const before = await platform.arena.leaderboard({ task: 'one' });
    assert.throws(() => platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'a',
      { harnessId: 'missing' }, 'test'), /所选harness不存在/);
    const corrected = platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'a',
      { harnessId: 'codex', providerId: 'official' }, 'test');
    assert.equal(corrected.harnessId, 'codex');
    const after = await platform.arena.leaderboard({ task: 'one' });
    assert.deepEqual({ ...before, updatedAt: null }, { ...after, updatedAt: null });
  } finally {
    await new Promise((resolve) => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});
