import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

const PAGE = '<!doctype html><html><body>Provenance</body></html>';
const PROVIDERS = [
  { id: 'official', name: '官方', listed: true },
  { id: 'unofficial', name: '非官方', listed: true },
];
const pack = (root, registries = true) => {
  const dist = join(root, 'dist');
  for (const id of ['a1', 'b1']) {
    mkdirSync(join(dist, 'results', 'one', id), { recursive: true });
    writeFileSync(join(dist, 'results', 'one', id, 'index.html'), PAGE + id);
  }
  writeFileSync(join(dist, 'data.json'), JSON.stringify({
    title: 'test', models: [{ id: 'm-a', name: 'Model A', vendor: 'VA' }, { id: 'm-b', name: 'Model B', vendor: 'VB' }],
    ...(registries ? { harnesses: [{ id: 'codex', name: 'Codex', listed: true }],
      providers: [{ id: 'official', name: '官方', listed: true }, { id: 'openrouter', name: 'OpenRouter', listed: true }] } : {}),
    tasks: [{ id: 'one', title: 'One', results: [
      { id: 'a1', model: 'm-a', effort: 'High', title: 'A1', scene: 'results/one/a1/', harness: 'codex', harnessVersion: '1', provider: 'official',
        modelVersion: 'v1', generationMode: 'single-turn' },
      { id: 'b1', model: 'm-b', title: 'B1', scene: 'results/one/b1/' },
    ] }],
  }));
  return dist;
};

test('v15 upgrades preserve legacy metadata and metadata migrations remain idempotent', () => {
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const before = db.prepare('SELECT * FROM works WHERE id = ?').get('up-old');
    assert.deepEqual([before.harness_id, before.harness_other, before.harness_version, before.provider_id, before.provider_other],
      [null, 'Codex', '', null, '']);
    MIGRATIONS[15](db);
    MIGRATIONS[16](db);
    assert.deepEqual([before.model_version, before.generation_mode, before.human_intervention, before.generated_on, before.evidence_url], ['', '', '', '', '']);
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
    assert.deepEqual(catalog.providers(), PROVIDERS);
    assert.equal(catalog.harness('codex'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v25 normalizes stored providers and can rerun without changing other metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-migrate-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  try {
    for (const step of MIGRATIONS.slice(0, 24)) typeof step === 'function' ? step(db) : db.exec(step);
    db.exec('PRAGMA user_version = 24');
    const insert = db.prepare(`INSERT INTO works (id, task_id, title, model_other,
      harness_id, harness_version, provider_id, provider_other, content_key, source_name, root, entry,
      file_count, bytes, digest, checks, created_at, updated_at)
      VALUES (?, 'one', 'Stored', 'M', 'codex', '1', ?, ?, ?, 'original.html', '', 'index.html', 1, 10, 'digest', '[]', 1, 2)`);
    const cases = [
      ['official', 'official', 'Old label', 'official'],
      ['unofficial', 'unofficial', '', 'unofficial'],
      ['cloud', 'aws-bedrock', '', 'unofficial'],
      ['manual', null, 'Local service', 'unofficial'],
      ['unset', null, '', null],
    ];
    for (const [id, provider, name] of cases) insert.run(id, provider, name, `key-${id}`);
    const before = db.prepare('SELECT * FROM works ORDER BY id').all();
    db.close();
    db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const after = db.prepare('SELECT * FROM works ORDER BY id').all();
    for (const [i, row] of after.entries()) {
      const expected = cases.find(([id]) => id === row.id)[3];
      assert.deepEqual({ ...row }, { ...before[i], provider_id: expected, provider_other: '' });
    }
    MIGRATIONS[24](db);
    assert.deepEqual(db.prepare('SELECT * FROM works ORDER BY id').all(), after);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('catalog normalizes old provider IDs and manual names while exposing two options', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-old-pack-'));
  try {
    const dist = pack(root);
    const data = JSON.parse(readFileSync(join(dist, 'data.json'), 'utf8'));
    for (const source of [{ provider: 'azure' }, { providerName: 'Local service' }]) {
      data.tasks[0].results[1] = { id: 'b1', model: 'm-b', title: 'B1', scene: 'results/one/b1/', ...source };
      writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
      const catalog = createCatalog(dist);
      assert.deepEqual(catalog.providers(), PROVIDERS);
      assert.equal(catalog.provider('openrouter'), null);
      assert.equal(catalog.work('one', 'b1').providerId, 'unofficial');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catalog resolves retired models from modelPool while keeping the displayed list', () => {
  const root = mkdtempSync(join(tmpdir(), 'retired-model-'));
  try {
    const dist = pack(root);
    const data = JSON.parse(readFileSync(join(dist, 'data.json'), 'utf8'));
    data.modelPool = [...data.models, { id: 'retired', name: 'Retired model', vendor: 'Original vendor' }];
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    const catalog = createCatalog(dist);
    assert.deepEqual(catalog.model('retired'), data.modelPool.at(-1));
    assert.deepEqual(catalog.models(), data.models);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an old pack accepts a custom Harness and binary providers but no Harness registry ID', async () => {
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
    await verifiedUser(platform.auth, 'alice');
    assert.equal((await call('POST', '/api/auth/login', { name: 'alice', password: 'correct horse' })).status, 200);
    const draft = await call('POST', '/api/drafts?task=one&name=work.html', PAGE, true);
    assert.equal(draft.status, 200);
    const body = { draftId: draft.data.draft.id, confirmed: true, title: 'Old pack upload', modelId: 'm-a' };
    assert.equal((await call('POST', '/api/works', { ...body, harnessId: 'codex' })).status, 400);
    const custom = await call('POST', '/api/works', { ...body, harnessOther: 'Local tool', providerId: 'unofficial' });
    assert.equal(custom.status, 200);
    assert.equal(custom.data.work.harnessName, 'Local tool');
    assert.equal(custom.data.work.provider, 'unofficial');
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
    await verifiedUser(platform.auth, 'alice');
    assert.equal((await call('alice', 'POST', '/api/auth/login', { name: 'alice', password: 'correct horse' })).status, 200);
    const curated = platform.library.toPublic(platform.library.work('one', 'a1'));
    assert.deepEqual([curated.harness, curated.harnessName, curated.harnessVersion, curated.provider],
      ['codex', 'Codex', '1', 'official']);
    assert.equal('providerName' in curated, false);
    const baseBody = { draftId: await draft(), confirmed: true, title: 'Candidate', modelId: 'm-a' };
    for (const bad of [{}, { harnessId: 'missing' }, { harnessId: 'codex', harnessOther: 'Other' },
      { harnessVersion: '1' }, ...['missing', 'openrouter', 'third-party', 'other', 1, false].map((providerId) => ({ providerId, tool: 'CLI' }))]) {
      const response = await call('alice', 'POST', '/api/works', { ...baseBody, ...bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    const generation = { modelVersion: '2026-09-29', generationMode: 'agent', humanIntervention: 'prompt-guided',
      generatedOn: '2026-09-29', evidenceUrl: 'https://example.test/shared/run' };
    for (const invalid of [{ generationMode: 'anything' }, { humanIntervention: 'unknown' }, { generatedOn: '2026-02-30' },
      { evidenceUrl: 'javascript:alert(1)' }, { modelVersion: 'x'.repeat(61) }]) {
      const rejected = await call('alice', 'POST', '/api/works', { ...baseBody, harnessId: 'codex', ...invalid });
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(rejected.data.code, 'invalid_generation');
    }
    const first = await call('alice', 'POST', '/api/works', { ...baseBody, harnessId: 'codex', harnessVersion: '2', providerId: 'official', ...generation });
    assert.equal(first.status, 200);
    const id = first.data.work.id;
    assert.equal(platform.db.prepare('SELECT model_other FROM works WHERE id = ?').get(id).model_other, '');
    for (const [key, value] of Object.entries(generation)) assert.equal(first.data.work[key], value);
    assert.deepEqual([first.data.work.harness, first.data.work.harnessName, first.data.work.provider, first.data.work.tool],
      ['codex', 'Codex', 'official', 'Codex']);
    const editPath = `/api/works/one/${id}`;
    for (const body of [{ providerId: 'openrouter' }, { providerId: 'missing' }, { providerOther: 'Local service' }, { providerName: 'Local service' }])
      assert.equal((await call('alice', 'PATCH', editPath, body)).status, 400);
    for (const value of ['unofficial', null, 'official']) {
      const edited = await call('alice', 'PATCH', editPath, { providerId: value });
      assert.equal(edited.status, 200);
      assert.equal(edited.data.work.provider, value);
      assert.equal('providerName' in edited.data.work, false);
    }
    const other = await call('alice', 'POST', '/api/works', { ...baseBody, draftId: await draft(), harnessOther: ' 自制工具 ',
      providerId: 'unofficial', providerOther: ' 本地服务 ', providerName: 'Ignored' });
    assert.equal(other.status, 200);
    assert.deepEqual([other.data.work.harnessName, other.data.work.provider, other.data.work.tool], ['自制工具', 'unofficial', '自制工具']);
    assert.equal('providerName' in other.data.work, false);
    assert.equal(platform.db.prepare('SELECT provider_other FROM works WHERE id = ?').get(other.data.work.id).provider_other, '');
    const legacy = await call('alice', 'POST', '/api/works', { ...baseBody, draftId: await draft(), tool: '原始工具',
      providerOther: 'Ignored', providerName: 'Ignored' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.work.harness, null);
    assert.equal(legacy.data.work.harnessName, '原始工具');
    assert.equal(legacy.data.work.provider, null);
    const blank = await call('alice', 'POST', '/api/works', { ...baseBody, draftId: await draft(), tool: 'CLI', harnessId: '', providerId: '' });
    assert.equal(blank.status, 200, 'an empty id means not stated');
    assert.deepEqual([blank.data.work.harness, blank.data.work.harnessName, blank.data.work.provider], [null, 'CLI', null]);
    const meta = `/api/admin/works/one/${id}/meta`;
    const edited = await call('root', 'POST', meta, { modelVersion: 'snapshot-2', humanIntervention: 'code-edited' });
    assert.equal(edited.data.work.modelVersion, 'snapshot-2');
    assert.equal(edited.data.work.generatedOn, generation.generatedOn, 'patch preserves omitted fields');
    assert.equal((await call('root', 'POST', meta, { generatedOn: '2026-02-30' })).status, 400);
    assert.equal(platform.library.work('one', id).generatedOn, generation.generatedOn, 'failed patch leaves saved fields intact');
    assert.equal((await call('root', 'POST', meta, { providerOther: '其他服务' })).status, 400);
    assert.equal((await call('root', 'POST', meta, { harnessOther: '备用工具' })).data.work.harnessName, '备用工具');
    const cleared = await call('root', 'POST', meta, { harnessId: null, providerId: null });
    assert.deepEqual([cleared.data.work.harness, cleared.data.work.harnessName, cleared.data.work.harnessVersion,
      cleared.data.work.provider], [null, null, '', null]);
    for (const providerId of ['openrouter', 'missing'])
      assert.equal((await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', providerId })).status, 400);
    const unofficialReview = await call('root', 'POST', `/api/works/one/${id}/review`,
      { status: 'unverified', providerId: 'unofficial', providerOther: 'Ignored', providerName: 'Ignored' });
    assert.equal(unofficialReview.status, 200);
    assert.equal(unofficialReview.data.work.provider, 'unofficial');
    const reviewed = await call('root', 'POST', `/api/works/one/${id}/review`,
      { status: 'verified', show_gallery: true, harnessId: 'codex', harnessVersion: '3', providerId: 'official' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.work.reviewer, 'root');
    assert.equal(platform.library.work('one', id).harnessVersion, '3');
    assert.equal(platform.library.work('one', id).humanIntervention, 'code-edited', 'review preserves generation metadata');
    const bootstrap = await call('alice', 'GET', '/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(bootstrap.data.providers, PROVIDERS);
    assert.equal(bootstrap.data.works.find((work) => work.id === id).provider, 'official');
    assert.equal(bootstrap.data.works.some((work) => 'providerName' in work), false);
    const mine = await call('alice', 'GET', '/api/me');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.works.find((work) => work.id === other.data.work.id).provider, 'unofficial');
    assert.equal(mine.data.works.some((work) => 'providerName' in work), false);
    const listed = async (query) => {
      const response = await call('root', 'GET', `/api/admin/works?task=one&pageSize=100&${query}`);
      assert.equal(response.status, 200, query);
      assert.equal(response.data.works.some((work) => 'providerName' in work), false);
      return response.data.works.map((work) => work.id).sort();
    };
    assert.deepEqual(await listed('harness=codex'), ['a1', id].sort());
    assert.deepEqual(await listed('harness=other'), [other.data.work.id, legacy.data.work.id, blank.data.work.id].sort());
    assert.deepEqual(await listed('harness=unset'), ['b1']);
    assert.deepEqual(await listed('provider=official&harness=codex'), ['a1', id].sort());
    assert.deepEqual(await listed('provider=unofficial'), [other.data.work.id]);
    assert.deepEqual(await listed('provider=unset'), ['b1', legacy.data.work.id, blank.data.work.id].sort());
    assert.equal((await call('root', 'GET', '/api/admin/works?provider=other')).status, 400);
    assert.deepEqual(await listed('search=自制'), [other.data.work.id]);
    assert.equal((await call('root', 'GET', '/api/admin/works?harness=missing')).status, 400);
    assert.deepEqual(await listed('model=m-a&generationMode=agent&humanIntervention=code-edited'), [id]);
    assert.deepEqual(await listed('effort=hIgH'), ['a1']);
    assert.deepEqual(await listed('model=m-b&generationMode=unset'), ['b1']);
    assert.equal((await call('root', 'GET', '/api/admin/works?generationMode=missing')).status, 400);
    const audits = platform.db.prepare("SELECT detail FROM audit WHERE work_id = ? AND action = 'meta'").all(id);
    assert.equal(audits.some((audit) => audit.detail.includes('snapshot-2')), true);
    const nomination = await call('root', 'POST', `/api/admin/works/one/${id}/nominate`);
    assert.equal(nomination.status, 200);
    const exported = await call('alice', 'GET', new URL(nomination.data.exportUrl).pathname);
    assert.equal(exported.status, 200);
    assert.deepEqual([exported.data.harnessId, exported.data.harnessOther, exported.data.harnessVersion,
      exported.data.providerId, exported.data.providerOther], ['codex', '', '3', 'official', '']);
    assert.equal(exported.data.modelVersion, 'snapshot-2');
    assert.equal(exported.data.evidenceUrl, generation.evidenceUrl);
    const clear = await call('root', 'POST', meta, { evidenceUrl: '' });
    assert.equal(clear.data.work.evidenceUrl, '', 'empty text explicitly clears metadata');
    assert.equal(clear.data.work.generationMode, 'agent');
    for (const work of ['a1', 'b1']) platform.db.prepare(`INSERT INTO work_overrides
      (task_id, work_id, show_gallery, show_arena, updated_by, updated_at) VALUES ('one', ?, 1, 1, 'root', 0)`).run(work);
    const alice = platform.auth.userFrom({ headers: { cookie: jars.get('alice') } });
    const match = await platform.arena.createMatch(alice, 'one');
    const saved = platform.db.prepare('SELECT a_identity, b_identity FROM matches WHERE id = ?').get(match.id);
    const identity = JSON.parse(saved.a_identity);
    assert.deepEqual([identity.harnessId, identity.harnessVersion, identity.providerId],
      identity.id === 'a1' ? ['codex', '1', 'official'] : [null, '', null]);
    assert.equal(identity.configKey, `${identity.modelKey}|${identity.effortKey}`);
    assert.equal(identity.modelVersion, identity.id === 'a1' ? 'v1' : '');
    assert.equal(platform.arena.vote(alice, match.id, 'a').counted, true);
    const vote = platform.db.prepare('SELECT id FROM votes WHERE match_id = ?').get(match.id);
    const before = await platform.arena.leaderboard({ task: 'one' });
    assert.throws(() => platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'a',
      { harnessId: 'missing' }, 'test'), /所选Harness不存在/);
    const corrected = platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'a',
      { harnessId: 'codex', providerId: 'official' }, 'test');
    assert.equal(corrected.harnessId, 'codex');
    const after = await platform.arena.leaderboard({ task: 'one' });
    assert.deepEqual({ ...before, updatedAt: null }, { ...after, updatedAt: null });
    assert.equal(after.filters, undefined, 'an unfiltered board keeps its old shape');
    const board = (query) => call('alice', 'GET', `/api/leaderboard?task=one&${query}`);
    // Sides are drawn in random order; pin side b to "not stated" so the checks below are deterministic.
    platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'b', { harnessId: null, providerId: null }, 'test');
    assert.equal((await board('harness=codex')).data.totals.votes, 0, 'side b has no Harness, so the vote is left out');
    assert.equal((await board('harness=unset')).data.totals.votes, 0, 'side a has a Harness, so the vote is left out');
    platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'b', { harnessId: 'codex' }, 'test');
    assert.equal((await board('harness=codex')).data.totals.votes, 1);
    assert.equal((await board('harness=codex&provider=official')).data.totals.votes, 0, 'side b still has no provider');
    platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'b', { providerId: 'official' }, 'test');
    const codex = (await board('harness=codex&provider=official')).data;
    assert.deepEqual([codex.totals.votes, codex.filters], [1, { harness: 'codex', provider: 'official' }]);
    assert.equal((await board('provider=unset')).data.totals.votes, 0);
    platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'a', { providerId: 'unofficial' }, 'test');
    assert.equal((await board('provider=unofficial')).data.totals.votes, 0, 'both sides must be unofficial');
    platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, 'b', { providerId: 'unofficial' }, 'test');
    const unofficial = await board('provider=unofficial');
    assert.equal(unofficial.status, 200);
    assert.deepEqual([unofficial.data.totals.votes, unofficial.data.filters], [1, { harness: null, provider: 'unofficial' }]);
    for (const side of ['a', 'b'])
      platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, side, { providerId: null }, 'test');
    assert.equal((await board('provider=unset')).data.totals.votes, 1);
    // Old frozen platform IDs still belong in the unofficial board after the contract changes.
    const row = platform.db.prepare('SELECT a_identity, b_identity FROM votes WHERE id = ?').get(vote.id);
    const frozen = Object.values(row).map((text) => JSON.stringify({ ...JSON.parse(text), providerId: 'openrouter' }));
    platform.db.prepare('UPDATE votes SET a_identity = ?, b_identity = ?, a_correction = NULL, b_correction = NULL WHERE id = ?')
      .run(...frozen, vote.id);
    platform.arena.invalidate();
    assert.equal((await board('provider=unofficial')).data.totals.votes, 1);
    for (const side of ['a', 'b'])
      platform.arena.correctVote({ id: 'root', name: 'root', role: 'admin' }, vote.id, side, { harnessId: 'codex', providerId: 'official' }, 'test');
    for (const provider of ['openrouter', 'third-party', 'missing']) assert.equal((await board(`provider=${provider}`)).status, 400);
    assert.equal((await board('harness=missing')).status, 400);
    const frozenVotes = platform.db.prepare('SELECT a_identity, b_identity, a_correction, b_correction FROM votes ORDER BY id').all();
    const archive = createCatalog(dist).snapshot();
    const data = JSON.parse(readFileSync(join(dist, 'data.json'), 'utf8'));
    data.models[0].name = 'Renamed Model A';
    data.models[0].vendor = 'Renamed vendor';
    data.harnesses[0].name = 'Renamed Codex';
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    const current = platform.library.work('one', id);
    assert.deepEqual([current.modelName, current.vendor, current.tool], ['Renamed Model A', 'Renamed vendor', 'Renamed Codex']);
    assert.equal(platform.library.work('one', id, archive).modelName, 'Model A');
    assert.deepEqual(platform.db.prepare('SELECT a_identity, b_identity, a_correction, b_correction FROM votes ORDER BY id').all(), frozenVotes);
    assert.deepEqual((await board('harness=codex&provider=official')).data.rows, codex.rows);
  } finally {
    await new Promise((resolve) => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});
