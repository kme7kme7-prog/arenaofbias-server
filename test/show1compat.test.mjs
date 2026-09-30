// Show1 compatibility layer: migration v8, arena vote sourcing, the compat endpoints
// against a synthetic snapshot fixture, and the integrity of the real snapshot file.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createArena } from '../server/arena.mjs';
import { createAuth } from '../server/auth.mjs';
import { limits as defaultLimits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { HttpError, createRouter, fail, sendJson } from '../server/http.mjs';
import { registerShow1Compat } from '../server/show1compat.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const loadJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

// A tiny synthetic snapshot: rounds 001 (→ show1-001, with weights) and 004
// (→ chinese-architecture, without weights), four works, no votes unless seeded.
function fixtureSnapshot(votes = { entertainment: [], formal: [] }) {
  return {
    generatedAt: '2026-09-28T00:00:00.000Z',
    taskByRound: { '001': 'show1-001', '004': 'chinese-architecture' },
    roundByTask: { 'show1-001': '001', 'chinese-architecture': '004' },
    prompts: [
      { id: '001', kind: 'web', name: '鹈鹕大挑战', prompt: '画一只鹈鹕', weights: [0.3, 0, 0.6, 0, 0, 0.1] },
      { id: '004', kind: 'web', name: '营造法式', prompt: '体素建筑' },
    ],
    works: [
      { id: '001-a', promptId: '001', modelId: 'model-a', modelName: 'Model A', title: 'A 作品', isDemo: 0, content: '{"kind":"text"}' },
      { id: '001-b', promptId: '001', modelId: 'model-b', modelName: 'Model B', title: 'B 作品', isDemo: 0, content: '{"kind":"text"}' },
      { id: '004-hall', promptId: '004', modelId: 'model-c', modelName: 'Model C', title: 'C 作品', isDemo: 0, content: '{"kind":"text"}' },
      { id: '004-pagoda', promptId: '004', modelId: 'model-d', modelName: 'Model D', title: 'D 作品', isDemo: 0, content: '{"kind":"text"}' },
    ],
    workMap: {
      '001-a': { up: 'up-aaaa0001', key: 'wa', task: 'show1-001', round: '001', mid: 'model-a', modelName: 'Model A', title: 'A 作品' },
      '001-b': { up: 'up-bbbb0002', key: 'wb', task: 'show1-001', round: '001', mid: 'model-b', modelName: 'Model B', title: 'B 作品' },
      '004-hall': { up: 'up-cccc0003', key: 'wc', task: 'chinese-architecture', round: '004', mid: 'model-c', modelName: 'Model C', title: 'C 作品' },
      '004-pagoda': { up: 'up-dddd0004', key: 'wd', task: 'chinese-architecture', round: '004', mid: 'model-d', modelName: 'Model D', title: 'D 作品' },
    },
    upToRid: { 'up-aaaa0001': '001-a', 'up-bbbb0002': '001-b', 'up-cccc0003': '004-hall', 'up-dddd0004': '004-pagoda' },
    votes,
    commentsBackfill: [],
  };
}

// The same dispatch core as app.mjs's handleSite, so 201/204 retargeting and error
// envelopes behave exactly like production wiring.
function createFixture({ snapshot = fixtureSnapshot(), admins = ['root'], tasks = [] } = {}) {
  const db = openDatabase(':memory:');
  const auth = createAuth(db, { admins, secureCookies: false, sessionTtl: 60000 });
  const router = createRouter();
  registerShow1Compat(router, { db, catalog: { tasks: () => tasks, model: (id) => ({ name: `Model ${id.at(-1).toUpperCase()}` }) }, snapshot, config: { contentTemplate: 'https://{token}.works.test' }, limit: {} });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://test.invalid');
      const route = router.match(req.method, url.pathname);
      if (!route) fail(404, '接口不存在');
      const ctx = { req, res, url, params: route.params, ip: '203.0.113.9', user: auth.userFrom(req) };
      return sendJson(res, 200, (await route.handler(ctx)) ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      return sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
    }
  });
  return { db, auth, server };
}

async function withServer(options, run) {
  const { db, auth, server } = createFixture(options);
  let base;
  // Windows may assign a port that fetch refuses under the browser unsafe-port list.
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    try { await fetch(`${base}/__port_probe`); break; }
    catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (error?.cause?.message !== 'bad port') throw error;
    }
  }
  try {
    await run({ db, auth, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

async function call(base, method, path, { body, cookie, raw = false } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, text, data };
}

async function signIn(auth, name) {
  const user = name === 'root' ? auth.createAdmin(name, 'correct horse') : await auth.register(name, 'correct horse');
  const headers = new Map();
  auth.startSession({ setHeader: (key, value) => headers.set(key, value) }, user.id);
  return { cookie: headers.get('Set-Cookie').split(';')[0], user };
}

const BALLOT = { promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '001-b', loserMid: 'model-b', mode: 'blind', outcome: 'win' };
const VOTE_KEYS = ['id', 'promptId', 'winnerRid', 'winnerMid', 'loserRid', 'loserMid', 'mode', 'ts', 'outcome', 'winnerName', 'loserName', 'promptKind', 'promptWeights'];

function seedWorks(db) {
  const insert = db.prepare(`INSERT INTO works (id, task_id, owner_id, title, summary, model_id, model_other,
    effort, note, status, content_key, source_name, root, entry, file_count, bytes, digest,
    checks, trial, created_at, updated_at, show_gallery, show_arena)
    VALUES (?, ?, NULL, ?, '', ?, ?, '', '', 'verified', ?, '', '', 'index.html', 1, 10, ?, '[]', '{}', 1, 1, 1, 1)`);
  insert.run('up-aaaa0001', 'show1-001', 'A 作品', 'model-a', '', 'wa', 'da');
  insert.run('up-bbbb0002', 'show1-001', 'B 作品', 'model-b', '', 'wb', 'db');
  insert.run('up-cccc0003', 'chinese-architecture', 'C 作品', 'model-c', '', 'wc', 'dc');
}

test('v8 migrates a v7 database: vote sources, comment sides and the new tables', () => {
  const root = mkdtempSync(join(tmpdir(), 'show1-v8-'));
  const file = join(root, 'platform.db');
  const raw = new DatabaseSync(file);
  try {
    for (const step of MIGRATIONS.slice(0, 7)) raw.exec(step);
    raw.exec('PRAGMA user_version = 7');
    const addVote = raw.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice,
      created_at, a_identity, b_identity, identity_source) VALUES (?, ?, NULL, 'one', 'w1', 'w2', ?, 'a', 1, '{}', '{}', ?)`);
    addVote.run('arena-vote', 'm1', 'one:w1+w2', 'snapshot');
    addVote.run('legacy-vote', 'm2', 'one:w1+w3', 'legacy');
    raw.prepare("INSERT INTO comments (id, task_id, work_id, user_id, body, created_at) VALUES ('c1', 'one', 'w1', NULL, 'hi', 1)").run();
  } finally { raw.close(); }
  const db = openDatabase(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.equal(db.prepare("SELECT source FROM votes WHERE id = 'arena-vote'").get().source, 'arena');
    assert.equal(db.prepare("SELECT source FROM votes WHERE id = 'legacy-vote'").get().source, 'legacy');
    assert.equal(db.prepare("SELECT compat_mode FROM votes WHERE id = 'arena-vote'").get().compat_mode, null);
    assert.equal(db.prepare("SELECT side FROM comments WHERE id = 'c1'").get().side, null);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'page_views'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'guess_results'").get());
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('weight migration restores prior arena audit weights and falls back to original weights', () => {
  const root = mkdtempSync(join(tmpdir(), 'show1-weights-'));
  const file = join(root, 'platform.db');
  const old = new DatabaseSync(file);
  try {
    for (const step of MIGRATIONS.slice(0, 13)) {
      if (typeof step === 'function') step(old);
      else old.exec(step);
    }
    old.exec('PRAGMA user_version = 13');
    const add = old.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice,
      created_at, a_identity, b_identity, identity_source, source) VALUES (?, ?, 'show1-001', 'a', 'b', ?, 'a', ?, '{}', '{}', 'snapshot', 'show1')`);
    add.run('before', 'm-before', 'p-before', 10);
    add.run('after', 'm-after', 'p-after', 30);
    add.run('later', 'm-later', 'p-later', 50);
    const audit = old.prepare("INSERT INTO audit (at, actor_name, action, task_id, detail) VALUES (?, 'admin', 'editorial', 'show1-001', ?)");
    audit.run(20, JSON.stringify({ face: 'arena', weights: [1, 0, 0, 0, 0, 0] }));
    audit.run(40, JSON.stringify({ face: 'arena', weights: [0, 1, 0, 0, 0, 0] }));
  } finally { old.close(); }
  const db = openDatabase(file);
  try {
    const rows = db.prepare("SELECT id, compat_weights_json, compat_weight_source FROM votes ORDER BY created_at").all();
    assert.deepEqual(rows.map((row) => JSON.parse(row.compat_weights_json)),
      [[0.3, 0, 0.6, 0, 0, 0.1], [1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0]]);
    assert.deepEqual(rows.map((row) => row.compat_weight_source), ['original', 'audit', 'audit']);
    MIGRATIONS[13](db);
    assert.deepEqual(db.prepare("SELECT compat_weight_source FROM votes ORDER BY created_at").all().map((row) => row.compat_weight_source),
      ['original', 'audit', 'audit']);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('countedVotes only feeds source=arena votes to Bradley–Terry', async () => {
  const db = openDatabase(':memory:');
  try {
    const catalog = {
      snapshot: () => ({ version: 1, commit: 'c', catalogDigest: 'd', root: '', task: () => null, tasks: () => [], entryDigest: () => null }),
      task: () => null, tasks: () => [], at: () => null,
    };
    const library = {
      work: (task, id) => ({ id, taskId: task, modelId: id, modelName: id, vendor: '', effort: '' }),
      isEligible: () => true,
      eligible: () => [],
    };
    const arena = createArena({ db, catalog, library, limits: defaultLimits });
    db.prepare("INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES ('u1', 'u1', 'u1', 'member', 's', 'h', 1)").run();
    const identity = (mid) => JSON.stringify({ taskId: 'one', id: mid, curated: false, title: mid, modelId: mid, modelName: mid, vendor: '', effort: '', effortKey: '', modelKey: mid, configKey: mid, ownerId: null });
    const add = db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice,
      created_at, a_identity, b_identity, source, compat_mode) VALUES (?, ?, 'u1', 'one', 'w1', 'w2', ?, 'a', 1, ?, ?, ?, ?)`);
    add.run('v-arena', 'ma', 'one:w1+w2', identity('w1'), identity('w2'), 'arena', null);
    add.run('v-legacy', 'mb', 'one:w1+w2x', identity('w1'), identity('w2'), 'legacy', null);
    add.run('v-show1', 'mc', 'show1:0:w1+w2', identity('w1'), identity('w2'), 'show1', 'blind');
    const board = await arena.leaderboard({ task: 'one' });
    assert.equal(board.totals.votes, 1, 'legacy and show1 votes never enter Bradley–Terry');
  } finally { db.close(); }
});

describe('show1 compat endpoints', () => {
  test('GET /api/prompts and /api/works return the snapshot verbatim', () => withServer({}, async ({ base }) => {
    const prompts = await call(base, 'GET', '/api/prompts');
    assert.equal(prompts.status, 200);
    assert.equal(prompts.data.prompts.length, 2);
    assert.deepEqual(prompts.data.prompts[0].weights, [0.3, 0, 0.6, 0, 0, 0.1]);
    const works = await call(base, 'GET', '/api/works');
    assert.equal(works.data.works.length, 4);
    assert.equal(works.data.works[0].id, '001-a');
  }));

  test('arena editorial overlays only its matching prompt; snapshot works stay unchanged', () => withServer({}, async ({ db, base }) => {
    const before = await call(base, 'GET', '/api/works');
    db.prepare(`INSERT INTO task_editorial (task_id, face, commentary, weights_json, updated_by, updated_at)
      VALUES (?, 'arena', ?, ?, 'admin', ?)`).run('show1-001', '新点评', JSON.stringify([0, 0, 0, 0.5, 0.5, 0]), Date.now());
    const prompts = (await call(base, 'GET', '/api/prompts')).data.prompts;
    assert.equal(prompts[0].commentary, '新点评');
    assert.deepEqual(prompts[0].weights, [0, 0, 0, 0.5, 0.5, 0]);
    assert.deepEqual(prompts[1], fixtureSnapshot().prompts[1]);
    assert.deepEqual((await call(base, 'GET', '/api/works')).data, before.data);
  }));

test('snapshot vote weights stay fixed after editorial changes', () => withServer({
    snapshot: fixtureSnapshot({ entertainment: [
      { id: 'sv1', promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '001-b', loserMid: 'model-b', mode: 'blind', ts: 1, outcome: 'win', winnerName: 'Model A', loserName: 'Model B', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
    ], formal: [] }),
  }, async ({ db, base }) => {
    const before = (await call(base, 'GET', '/api/votes?scope=entertainment')).data.votes[0];
    assert.deepEqual(before.promptWeights, [0.3, 0, 0.6, 0, 0, 0.1]);
    db.prepare(`INSERT INTO task_editorial (task_id, face, commentary, weights_json, updated_by, updated_at)
      VALUES (?, 'arena', ?, ?, 'admin', ?)`).run('show1-001', '', JSON.stringify([0, 0, 0, 0.5, 0.5, 0]), Date.now());
    const after = (await call(base, 'GET', '/api/votes?scope=entertainment')).data.votes[0];
    assert.deepEqual(after.promptWeights, [0.3, 0, 0.6, 0, 0, 0.1]);
    // 另一道题没有覆盖，权重保持快照值
    db.prepare(`INSERT INTO task_editorial (task_id, face, commentary, weights_json, updated_by, updated_at)
      VALUES (?, 'arena', ?, ?, 'admin', ?)`).run('chinese-architecture', '', JSON.stringify([1, 0, 0, 0, 0, 0]), Date.now());
    const still = (await call(base, 'GET', '/api/votes?scope=entertainment')).data.votes[0];
    assert.deepEqual(still.promptWeights, [0.3, 0, 0.6, 0, 0, 0.1]);
  }));

  test('a verified arena upload joins the Show1 list and entertainment votes', () => withServer({}, async ({ db, auth, base }) => {
    seedWorks(db);
    const columns = db.prepare('PRAGMA table_info(works)').all().map((column) => column.name);
    db.exec(`INSERT INTO works (${columns.join(', ')}) SELECT ${columns.map((name) => ({
      id: "'up-live0001'", content_key: "'wlive'", digest: "'dlive'", show_arena: '1',
    })[name] ?? name).join(', ')} FROM works WHERE id = 'up-cccc0003'`);
    const works = (await call(base, 'GET', '/api/works')).data.works;
    const live = works.find((work) => work.id === 'up-live0001');
    assert.deepEqual(Object.keys(live).sort(), Object.keys(works[0]).sort());
    assert.deepEqual(JSON.parse(live.content), { kind: 'html', src: 'https://wlive.works.test/' });
    assert.equal(live.promptId, '004');
    assert.equal(works.length, 5);
    const voter = await signIn(auth, 'live-voter');
    const result = await call(base, 'POST', '/api/votes', { cookie: voter.cookie, body: { id: randomUUID(),
      promptId: '004', winnerRid: live.id, winnerMid: live.modelId,
      loserRid: '004-pagoda', loserMid: 'model-d', mode: 'blind' } });
    assert.equal(result.status, 201, result.text);
    assert.equal((await call(base, 'GET', '/api/votes?scope=entertainment')).data.votes.at(-1).winnerRid, live.id);
    db.prepare("UPDATE works SET show_arena = 0 WHERE id = 'up-live0001'").run();
    assert.equal((await call(base, 'GET', '/api/works')).data.works.some((work) => work.id === live.id), false);
  }));

  test('shared questions preserve legacy IDs and expose prompt variants within one question', () => withServer({ tasks: [
    { id: 'chinese-architecture', arenaId: '004', kind: 'web', category: '建模', title: '古典建筑', prompt: '完整建筑提示词', summary: '建筑' },
    { id: 'little-red-riding-hood', arenaId: '013', kind: 'text', category: '文学', title: '小红帽', prompt: '创作全新故事', summary: '故事' },
    { id: 'supernovai', arenaId: '014', kind: 'web', category: '静态网页', title: 'SupernovAI', prompt: '长提示词', summary: '网站',
      promptVariants: [{ id: 'long', label: '长提示词', prompt: '长提示词' }, { id: 'short', label: '短提示词', prompt: '短提示词' }] },
  ] }, async ({ db, auth, base }) => {
    const prompts = (await call(base, 'GET', '/api/prompts')).data.prompts;
    assert.deepEqual(prompts.map((prompt) => prompt.id), ['001', '004', '013', '014']);
    assert.equal(prompts[1].name, '营造法式');
    assert.equal(prompts[1].prompt, '完整建筑提示词');
    assert.equal(prompts[2].kind, 'text');
    assert.equal(prompts[2].category, '文学');
    assert.deepEqual(prompts[3].promptVariants.map((variant) => variant.id), ['long', 'short']);
    assert.equal(prompts[3].promptVariants[1].prompt, '短提示词');
    seedWorks(db);
    const columns = db.prepare('PRAGMA table_info(works)').all().map((column) => column.name);
    for (const [id, task, source] of [
      ['up-long-a', 'supernovai', 'up-cccc0003'],
      ['up-long-b', 'supernovai', 'up-bbbb0002'],
      ['up-short-b', 'little-red-riding-hood', 'up-bbbb0002'],
    ]) {
      db.exec(`INSERT INTO works (${columns.join(', ')}) SELECT ${columns.map((name) => ({
        id: `'${id}'`, task_id: `'${task}'`, content_key: `'w${id}'`, digest: `'d${id}'`,
      })[name] ?? name).join(', ')} FROM works WHERE id = '${source}'`);
    }
    const works = (await call(base, 'GET', '/api/works')).data.works;
    assert.equal(works.find((work) => work.id === 'up-long-a').promptId, '014');
    assert.equal(works.find((work) => work.id === 'up-short-b').promptId, '013');
    const voter = await signIn(auth, 'shared-voter');
    const ballot = { promptId: '014', winnerRid: 'up-long-a', winnerMid: 'model-c',
      loserRid: 'up-long-b', loserMid: 'model-b', mode: 'party' };
    const vote = await call(base, 'POST', '/api/votes', { cookie: voter.cookie, body: { id: randomUUID(), ...ballot } });
    assert.equal(vote.status, 201, vote.text);
    assert.equal(vote.data.vote.promptId, '014');
    assert.equal(db.prepare("SELECT task_id FROM votes WHERE source = 'show1'").get().task_id, 'supernovai');
    assert.equal((await call(base, 'POST', '/api/votes', { cookie: voter.cookie,
      body: { id: randomUUID(), ...ballot, loserRid: 'up-short-b' } })).status, 400);
    assert.equal((await call(base, 'GET', '/api/comments?round=014')).status, 200);
    db.prepare("UPDATE works SET show_arena = 0 WHERE id = 'up-long-b'").run();
    assert.equal((await call(base, 'GET', '/api/works')).data.works.some((work) => work.id === 'up-long-b'), false);
  }));

  test('live votes retain different weights saved between editorial changes', () => withServer({}, async ({ db, auth, base }) => {
    const save = (weights) => db.prepare(`INSERT INTO task_editorial (task_id, face, commentary, weights_json, updated_by, updated_at)
      VALUES ('show1-001', 'arena', '', ?, 'admin', ?) ON CONFLICT(task_id, face) DO UPDATE SET
      weights_json = excluded.weights_json, updated_at = excluded.updated_at`).run(JSON.stringify(weights), Date.now());
    const firstWeights = [1, 0, 0, 0, 0, 0];
    const secondWeights = [0, 1, 0, 0, 0, 0];
    save(firstWeights);
    const first = await call(base, 'POST', '/api/votes', { cookie: (await signIn(auth, 'first')).cookie, body: { id: randomUUID(), ...BALLOT } });
    assert.equal(first.status, 201);
    save(secondWeights);
    const second = await call(base, 'POST', '/api/votes', { cookie: (await signIn(auth, 'second')).cookie, body: { id: randomUUID(), ...BALLOT } });
    assert.equal(second.status, 201);
    save([0, 0, 1, 0, 0, 0]);
    const votes = (await call(base, 'GET', '/api/votes?scope=entertainment')).data.votes;
    assert.deepEqual(votes.map((vote) => vote.promptWeights), [firstWeights, secondWeights]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM votes WHERE compat_weight_source = 'cast'").get().n, 2);
  }));

  test('POST /api/votes enforces the old validation, dedup and storage rules', () => withServer({}, async ({ db, auth, base }) => {
    const vote = (who, body) => call(base, 'POST', '/api/votes', { body, cookie: who?.cookie });
    assert.equal((await vote(null, { id: randomUUID(), ...BALLOT })).status, 401);
    const anonymous = await call(base, 'POST', '/api/votes', { body: { id: randomUUID(), ...BALLOT } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.error, '请先登录再投票。');

    const voter = await signIn(auth, 'voter');
    assert.equal((await vote(voter, { id: 'nope', ...BALLOT })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, promptId: '999' })).data.error, '题目不存在');
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, winnerMid: 'model-x' })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, winnerRid: '001-x' })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, loserRid: '001-a', loserMid: 'model-a' })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, winnerRid: 'x'.repeat(65) })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, mode: 'ranked' })).status, 400);
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, outcome: 'lose' })).status, 400);
    const formal = await vote(voter, { id: randomUUID(), ...BALLOT, mode: 'formal' });
    assert.equal(formal.status, 403);
    assert.equal(formal.data.error, '正式测评为资格制，暂未开放。');

    // Winner on side a (001-a < 001-b): choice 'a'.
    const id = randomUUID();
    const created = await vote(voter, { id, ...BALLOT });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.data.vote), VOTE_KEYS);
    assert.equal(created.data.vote.outcome, 'win');
    assert.equal(created.data.vote.promptKind, 'web');
    assert.deepEqual(created.data.vote.promptWeights, [0.3, 0, 0.6, 0, 0, 0.1]);
    const row = db.prepare('SELECT * FROM votes WHERE id = ?').get(id);
    assert.equal(row.source, 'show1');
    assert.equal(row.compat_mode, 'blind');
    assert.equal(row.pair_key, 'show1:0:001-a+001-b');
    assert.equal(row.choice, 'a');
    assert.equal(row.a_work, 'up-aaaa0001');
    assert.equal(row.b_work, 'up-bbbb0002');
    const aIdentity = JSON.parse(row.a_identity);
    assert.deepEqual(Object.keys(aIdentity).sort(), ['configKey', 'curated', 'effort', 'effortKey', 'id', 'modelId', 'modelKey', 'modelName', 'ownerId', 'taskId', 'title', 'vendor']);
    assert.equal(aIdentity.modelId, 'model-a');
    assert.equal(aIdentity.ownerId, null);
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(row.match_id);
    assert.equal(row.match_id, sha256(`show1:match:${id}`).slice(0, 16));
    assert.equal(match.choice, 'a');
    assert.equal(match.created_at, match.expires_at);
    assert.equal(match.created_at, match.decided_at);
    assert.match(match.a_token, /^w[0-9a-f]{32}$/);
    assert.match(match.b_token, /^m[0-9a-f]{32}$/);

    // Idempotent replay: same id, same ballot → 200 with the stored ballot.
    const replay = await vote(voter, { id, ...BALLOT });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.vote.id, id);
    assert.equal(replay.data.vote.ts, created.data.vote.ts);
    // Same id, different ballot → 409 code 'id'; different id → 409 code 'pair'.
    const idConflict = await vote(voter, { id, ...BALLOT, outcome: 'draw' });
    assert.equal(idConflict.status, 409);
    assert.equal(idConflict.data.code, 'id');
    assert.equal(idConflict.data.error, '投票编号冲突，请重新提交');
    const pairConflict = await vote(voter, { id: randomUUID(), ...BALLOT });
    assert.equal(pairConflict.status, 409);
    assert.equal(pairConflict.data.code, 'pair');
    assert.equal(pairConflict.data.error, '这一对作品你已经投过票了。');
    // The reversed ballot is the same pair.
    assert.equal((await vote(voter, { id: randomUUID(), ...BALLOT, winnerRid: '001-b', winnerMid: 'model-b', loserRid: '001-a', loserMid: 'model-a' })).data.code, 'pair');

    // Winner on side b: another voter backs 001-b; a/b stay in rid order → choice 'b'.
    const other = await signIn(auth, 'voter2');
    const idB = randomUUID();
    const createdB = await vote(other, { id: idB, ...BALLOT, winnerRid: '001-b', winnerMid: 'model-b', loserRid: '001-a', loserMid: 'model-a' });
    assert.equal(createdB.status, 201);
    assert.equal(db.prepare('SELECT choice FROM votes WHERE id = ?').get(idB).choice, 'b');
    assert.equal(createdB.data.vote.winnerRid, '001-b');

    // Draw → choice 'tie', side a still reported as the old-shape "winner".
    const idDraw = randomUUID();
    const draw = await vote(other, { id: idDraw, promptId: '004', winnerRid: '004-pagoda', winnerMid: 'model-d', loserRid: '004-hall', loserMid: 'model-c', mode: 'party', outcome: 'draw' });
    assert.equal(draw.status, 201);
    assert.equal(draw.data.vote.outcome, 'draw');
    assert.equal(draw.data.vote.winnerRid, '004-hall', 'tie reports the lexicographically smaller rid (side a)');
    const drawRow = db.prepare('SELECT * FROM votes WHERE id = ?').get(idDraw);
    assert.equal(drawRow.choice, 'tie');
    assert.equal(drawRow.a_work, 'up-cccc0003');
    assert.equal(drawRow.pair_key, 'show1:0:004-hall+004-pagoda');
    assert.equal(drawRow.compat_mode, 'party');

    // Formal votes by an admin carry the formal scope bit in the pair key.
    const admin = await signIn(auth, 'root');
    const idFormal = randomUUID();
    const formalVote = await vote(admin, { id: idFormal, ...BALLOT, mode: 'formal' });
    assert.equal(formalVote.status, 201);
    assert.equal(db.prepare('SELECT pair_key FROM votes WHERE id = ?').get(idFormal).pair_key, 'show1:1:001-a+001-b');
  }));

  test('a migrated legacy vote (bare pair_key) still blocks re-voting the same pair', () => withServer({}, async ({ db, auth, base }) => {
    const voter = await signIn(auth, 'legacyvoter');
    db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice,
      created_at, a_identity, b_identity, source) VALUES ('old-vote', 'old-match', ?, 'show1-001',
      'legacy:model-a', 'legacy:model-b', '001-a+001-b', 'a', 1, 'model-a', 'model-b', 'legacy')`).run(voter.user.id);
    const blocked = await call(base, 'POST', '/api/votes', { body: { id: randomUUID(), ...BALLOT }, cookie: voter.cookie });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'pair');
    // A different pair on another prompt is unaffected.
    const ok = await call(base, 'POST', '/api/votes', {
      body: { id: randomUUID(), promptId: '004', winnerRid: '004-hall', winnerMid: 'model-c', loserRid: '004-pagoda', loserMid: 'model-d', mode: 'blind', outcome: 'win' },
      cookie: voter.cookie,
    });
    assert.equal(ok.status, 201);
  }));

  test('GET /api/votes merges snapshot and live rows in (ts, id) order with old shapes', () => withServer({
    snapshot: fixtureSnapshot({
      entertainment: [
        { id: 'snap-2', promptId: '001', winnerRid: '001-b', winnerMid: 'model-b', loserRid: '001-a', loserMid: 'model-a', mode: 'blind', ts: 2000, outcome: 'win', winnerName: 'Model B', loserName: 'Model A', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
        { id: 'snap-1', promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '001-b', loserMid: 'model-b', mode: 'blind', ts: 1000, outcome: 'win', winnerName: 'Model A', loserName: 'Model B', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
      ],
      formal: [{ id: 'snap-f', promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '001-b', loserMid: 'model-b', mode: 'formal', ts: 500, outcome: 'win', winnerName: 'Model A', loserName: 'Model B', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] }],
    }),
  }, async ({ auth, base }) => {
    assert.equal((await call(base, 'GET', '/api/votes?scope=nonsense')).status, 400);
    assert.equal((await call(base, 'GET', '/api/votes?scope=nonsense')).data.error, '测评数据范围无效');
    assert.equal((await call(base, 'GET', '/api/votes')).status, 400);

    const voter = await signIn(auth, 'merger');
    const liveId = randomUUID();
    assert.equal((await call(base, 'POST', '/api/votes', { body: { id: liveId, ...BALLOT }, cookie: voter.cookie })).status, 201);
    const admin = await signIn(auth, 'root');
    const liveFormal = randomUUID();
    assert.equal((await call(base, 'POST', '/api/votes', { body: { id: liveFormal, ...BALLOT, mode: 'formal' }, cookie: admin.cookie })).status, 201);

    const merged = await call(base, 'GET', '/api/votes?scope=entertainment');
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.data.votes.map((row) => row.id), ['snap-1', 'snap-2', liveId]);
    assert.deepEqual(Object.keys(merged.data.votes[0]), VOTE_KEYS);
    const live = merged.data.votes[2];
    assert.equal(live.winnerRid, '001-a');
    assert.equal(live.winnerName, 'Model A');
    assert.equal(live.promptKind, 'web');
    assert.deepEqual(live.promptWeights, [0.3, 0, 0.6, 0, 0, 0.1]);
    assert.ok(!merged.data.votes.some((row) => row.id === liveFormal), 'formal votes stay out of the entertainment scope');

    const formal = await call(base, 'GET', '/api/votes?scope=formal');
    assert.deepEqual(formal.data.votes.map((row) => row.id), ['snap-f', liveFormal]);
    assert.equal(formal.data.votes[1].mode, 'formal');

    // A prompt without weights omits promptWeights (parseWeightsColumn semantics).
    const noWeights = randomUUID();
    await call(base, 'POST', '/api/votes', { body: { id: noWeights, promptId: '004', winnerRid: '004-hall', winnerMid: 'model-c', loserRid: '004-pagoda', loserMid: 'model-d', mode: 'blind', outcome: 'win' }, cookie: voter.cookie });
    const again = await call(base, 'GET', '/api/votes?scope=entertainment');
    const live004 = again.data.votes.find((row) => row.id === noWeights);
    assert.equal(live004.promptId, '004');
    assert.equal(live004.promptKind, 'web');
    assert.ok(!('promptWeights' in live004));
  }));

  test('GET /api/ratings replays old Elo over the merged list', () => withServer({
    snapshot: fixtureSnapshot({
      entertainment: [
        { id: 'r1', promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '001-b', loserMid: 'model-b', mode: 'blind', ts: 1000, outcome: 'win', winnerName: 'Model A', loserName: 'Model B', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
        { id: 'r2', promptId: '001', winnerRid: '001-b', winnerMid: 'model-b', loserRid: '004-hall', loserMid: 'model-c', mode: 'blind', ts: 2000, outcome: 'win', winnerName: 'Model B', loserName: 'Model C', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
        { id: 'r3', promptId: '001', winnerRid: '001-a', winnerMid: 'model-a', loserRid: '004-hall', loserMid: 'model-c', mode: 'blind', ts: 3000, outcome: 'draw', winnerName: 'Model A', loserName: 'Model C', promptKind: 'web', promptWeights: [0.3, 0, 0.6, 0, 0, 0.1] },
      ],
      formal: [],
    }),
  }, async ({ base }) => {
    assert.equal((await call(base, 'GET', '/api/ratings?scope=nope')).status, 400);
    const { status, data } = await call(base, 'GET', '/api/ratings?scope=entertainment');
    assert.equal(status, 200);
    // Hand-computed: 1200 base, K=32 — a beats b, b beats c, a draws c.
    assert.equal(data.ratings['model-a'], 1214.4968829087939);
    assert.equal(data.ratings['model-b'], 1200.736306793522);
    assert.equal(data.ratings['model-c'], 1184.766810297684);
    assert.deepEqual(data.games, { 'model-a': 2, 'model-b': 2, 'model-c': 2 });
  }));

  test('GET /api/comments maps rounds to tasks; POST resolves the backed side work', () => withServer({}, async ({ db, auth, base }) => {
    seedWorks(db);
    const author = await signIn(auth, 'commenter');
    const insert = db.prepare('INSERT INTO comments (id, task_id, work_id, user_id, body, created_at, side, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('c-new', 'chinese-architecture', 'up-cccc0003', author.user.id, '新的', 200, 'a', null);
    insert.run('c-old', 'chinese-architecture', 'up-cccc0003', null, '旧的', 100, null, null);
    insert.run('c-gone', 'chinese-architecture', 'up-cccc0003', null, '删了', 300, 'b', 1);
    insert.run('c-else', 'show1-001', 'up-aaaa0001', null, '别题', 400, 'a', null);

    assert.equal((await call(base, 'GET', '/api/comments?round=999')).status, 400);
    assert.equal((await call(base, 'GET', '/api/comments?round=999')).data.error, '题目不存在');
    const listed = await call(base, 'GET', '/api/comments?round=004');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.comments.map((row) => row.id), ['c-new', 'c-old']);
    assert.deepEqual(listed.data.comments[0], { id: 'c-new', roundId: '004', side: 'a', body: '新的', createdAt: 200, username: 'commenter' });
    assert.equal(listed.data.comments[1].username, null);
    assert.equal(listed.data.comments[1].side, null, 'platform-native comments carry no side');

    // POST validation.
    const comment = (who, body) => call(base, 'POST', '/api/comments', { body, cookie: who?.cookie });
    const unauthenticated = await call(base, 'POST', '/api/comments', { body: { id: randomUUID(), roundId: '001', side: 'a', body: 'hi' } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.data.error, '请先登录再留言。');
    for (const body of [
      { id: 'bad', roundId: '001', side: 'a', body: 'hi' },
      { id: randomUUID(), roundId: '001', side: 'c', body: 'hi' },
      { id: randomUUID(), roundId: '001', side: 'a', body: '   ' },
      { id: randomUUID(), roundId: '001', side: 'a', body: 'x'.repeat(281) },
    ]) assert.equal((await comment(author, body)).data.error, '留言内容无效');
    assert.equal((await comment(author, { id: randomUUID(), roundId: '999', side: 'a', body: 'hi' })).data.error, '题目不存在');

    // The commenter votes blind: 001-a beats 001-b. A side-b comment then belongs to
    // the b-side work of that latest vote (up-bbbb0002).
    await call(base, 'POST', '/api/votes', { body: { id: randomUUID(), ...BALLOT }, cookie: author.cookie });
    const id = randomUUID();
    const created = await comment(author, { id, roundId: '001', side: 'b', body: '  右边更好  ' });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.data.comment).sort(), ['body', 'createdAt', 'id', 'roundId', 'side', 'username']);
    assert.equal(created.data.comment.body, '右边更好');
    assert.equal(created.data.comment.username, 'commenter');
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    assert.equal(row.work_id, 'up-bbbb0002');
    assert.equal(row.side, 'b');
    assert.equal(row.task_id, 'show1-001');

    // Idempotent replay vs. id conflict.
    const replay = await comment(author, { id, roundId: '001', side: 'b', body: '右边更好' });
    assert.equal(replay.status, 201);
    assert.equal(replay.data.comment.createdAt, created.data.comment.createdAt);
    const conflict = await comment(author, { id, roundId: '001', side: 'a', body: '换个说法' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, '留言编号冲突，请重新提交');

    // No votes at all → fall back to the task's first work by rid.
    const fresh = await signIn(auth, 'fresh');
    const fallbackId = randomUUID();
    assert.equal((await comment(fresh, { id: fallbackId, roundId: '001', side: 'a', body: '第一' })).status, 201);
    assert.equal(db.prepare('SELECT work_id FROM comments WHERE id = ?').get(fallbackId).work_id, 'up-aaaa0001');

    // A legacy migrated vote resolves its mid from the legacy:<mid> work reference.
    const legacy = await signIn(auth, 'legacyvoter');
    db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at,
      a_identity, b_identity, source) VALUES ('lv1', 'lm1', ?, 'show1-001', 'legacy:model-b', 'legacy:model-a',
      '001-a+001-b', 'a', 50, 'model-b', 'model-a', 'legacy')`).run(legacy.user.id);
    const legacyCommentId = randomUUID();
    assert.equal((await comment(legacy, { id: legacyCommentId, roundId: '001', side: 'a', body: '旧票定位' })).status, 201);
    assert.equal(db.prepare('SELECT work_id FROM comments WHERE id = ?').get(legacyCommentId).work_id, 'up-bbbb0002');
  }));

  test('reactions set, switch and cancel per slot with counts and mine', () => withServer({}, async ({ db, auth, base }) => {
    assert.equal((await call(base, 'GET', '/api/reactions?prompt=999')).status, 400);
    const react = (who, body) => call(base, 'POST', '/api/reactions', { body, cookie: who?.cookie });
    const one = await signIn(auth, 'one');
    const two = await signIn(auth, 'two');
    const base1 = { promptId: '001', mid: 'model-a' };

    assert.equal((await react(null, { id: randomUUID(), ...base1, kind: 'up' })).status, 401);
    assert.equal((await react(null, { id: randomUUID(), ...base1, kind: 'up' })).data.error, '请先登录再表态。');
    assert.equal((await react(one, { id: 'bad', ...base1, kind: 'up' })).status, 400);
    assert.equal((await react(one, { id: randomUUID(), promptId: '999', mid: 'model-a', kind: 'up' })).status, 400);
    assert.equal((await react(one, { id: randomUUID(), ...base1, mid: 'model-x', kind: 'up' })).status, 400);
    assert.equal((await react(one, { id: randomUUID(), ...base1, kind: 'wow' })).status, 400);

    const first = await react(one, { id: randomUUID(), ...base1, kind: 'up' });
    assert.equal(first.status, 201);
    assert.deepEqual(first.data.mine, { 'model-a': 'up' });
    assert.deepEqual(first.data.counts, { 'model-a': { up: 1, down: 0, laugh: 0 } });
    assert.equal(db.prepare('SELECT emoji FROM reactions WHERE user_id = ?').get(one.user.id).emoji, '👍');

    assert.deepEqual((await react(two, { id: randomUUID(), ...base1, kind: 'down' })).data.counts, { 'model-a': { up: 1, down: 1, laugh: 0 } });

    // Switching replaces the slot state; only the new emoji remains.
    const switched = await react(one, { id: randomUUID(), ...base1, kind: 'laugh' });
    assert.deepEqual(switched.data.mine, { 'model-a': 'laugh' });
    assert.deepEqual(switched.data.counts, { 'model-a': { up: 0, down: 1, laugh: 1 } });
    assert.deepEqual(db.prepare('SELECT emoji FROM reactions WHERE user_id = ?').all(one.user.id).map((row) => row.emoji), ['🤯']);

    // Re-sending the same kind keeps the original created_at.
    const before = db.prepare('SELECT created_at FROM reactions WHERE user_id = ?').get(one.user.id).created_at;
    await react(one, { id: randomUUID(), ...base1, kind: 'laugh' });
    assert.equal(db.prepare('SELECT created_at FROM reactions WHERE user_id = ?').get(one.user.id).created_at, before);

    // Platform-only emoji never enter the compat counts.
    db.prepare("INSERT INTO reactions (task_id, work_id, user_id, emoji, created_at) VALUES ('show1-001', 'up-aaaa0001', ?, '❤️', 1)").run(two.user.id);
    const listed = await call(base, 'GET', '/api/reactions?prompt=001', { cookie: two.cookie });
    assert.deepEqual(listed.data.counts, { 'model-a': { up: 0, down: 1, laugh: 1 } });
    assert.deepEqual(listed.data.mine, { 'model-a': 'down' });
    assert.deepEqual((await call(base, 'GET', '/api/reactions?prompt=001')).data.mine, {});

    // kind=null clears every mapped emoji of the slot.
    const cleared = await react(one, { id: randomUUID(), ...base1, kind: null });
    assert.deepEqual(cleared.data.mine, { 'model-a': null });
    assert.deepEqual(cleared.data.counts, { 'model-a': { up: 0, down: 1, laugh: 0 } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE user_id = ?').get(one.user.id).n, 0);
  }));

  test('POST /api/track always answers 204 and hashes the ip with a daily salt', () => withServer({}, async ({ db, base }) => {
    const tracked = await call(base, 'POST', '/api/track', { body: { path: '/vote/001' } });
    assert.equal(tracked.status, 204);
    assert.equal(tracked.text, '');
    const row = db.prepare('SELECT * FROM page_views').get();
    assert.equal(row.path, '/vote/001');
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.day, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
    assert.equal(typeof row.created_at, 'number');

    assert.equal((await call(base, 'POST', '/api/track', { body: { path: 'x'.repeat(65) } })).status, 204);
    assert.equal((await call(base, 'POST', '/api/track', { body: 'not json', raw: true })).status, 204);
    assert.equal((await call(base, 'POST', '/api/track', { body: '{"path":"/x"}', raw: true })).status, 204);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_views').get().n, 1, 'invalid payloads are dropped silently');
  }));

  test('retired share endpoints have no routes', () => withServer({}, async ({ base }) => {
    for (const path of ['/api/share', '/api/share-work/up-aaaa0001']) {
      const response = await call(base, 'GET', path);
      assert.equal(response.status, 404, path);
    }
  }));
});

describe('auth dual shape', () => {
  let root;
  let platform;
  let site;
  let base;
  const jars = new Map();

  async function call(who, method, path, body) {
    const headers = { origin: base };
    if (jars.get(who)) headers.cookie = jars.get(who);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jars.set(who, cookie.split(';')[0]);
    return { status: response.status, data: await response.json() };
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'show1-auth-'));
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'test', models: [], tasks: [] }));
    const config = { dist, dataDir: join(root, 'data'), contentTemplate: '', siteOrigins: [], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: false };
    platform = createPlatform({ config, limits: defaultLimits });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${site.address().port}`;
  });

  after(async () => {
    site.close();
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('username aliases name; login/register/me gain the old fields additively', async () => {
    const registered = await call('u1', 'POST', '/api/auth/register', { username: 'show1user', password: 'correct horse' });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.user.name, 'show1user', 'platform fields stay');
    assert.equal(registered.data.user.nickname, 'show1user');
    assert.equal(registered.data.user.role, 'member');
    assert.equal(registered.data.user.username, 'show1user');
    assert.equal(registered.data.user.email, null);

    const loggedIn = await call('u1', 'POST', '/api/auth/login', { username: 'show1user', password: 'correct horse' });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.data.user.username, 'show1user');

    const byName = await call('u2', 'POST', '/api/auth/login', { name: 'show1user', password: 'correct horse' });
    assert.equal(byName.status, 200, 'the platform field name keeps working');

    const guest = await call('guest', 'GET', '/api/auth/me');
    assert.deepEqual(guest.data, { user: null });
    const me = await call('u1', 'GET', '/api/auth/me');
    assert.deepEqual(Object.keys(me.data.user).sort(), ['email', 'id', 'role', 'username']);
    assert.equal(me.data.user.username, 'show1user');
    assert.equal(me.data.user.role, null, 'members read role null in the old shape');
    assert.equal(me.data.user.email, null);

    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('admin', 'POST', '/api/auth/login', { username: 'root', password: 'correct horse' })).status, 200);
    assert.equal((await call('admin', 'GET', '/api/auth/me')).data.user.role, 'admin');

    // Platform rules are untouched: bad names still fail, no email is ever required.
    assert.equal((await call('bad', 'POST', '/api/auth/register', { username: 'x', password: 'correct horse' })).status, 400);
    const boot = await call('u1', 'GET', '/api/bootstrap');
    assert.equal(boot.data.user.name, 'show1user');
    assert.equal(boot.data.user.username, undefined, 'bootstrap keeps the platform-only shape');
  });
});

describe('real compat snapshot', () => {
  const snapshot = loadJson(new URL('../server/show1/compat-data.json', import.meta.url));
  const golden = (name) => loadJson(new URL(`./fixtures/show1-golden/${name}`, import.meta.url));

  test('structure and referential integrity hold', () => {
    assert.equal(snapshot.prompts.length, 8);
    assert.equal(snapshot.works.length, 262);
    assert.equal(snapshot.votes.entertainment.length, 546);
    assert.equal(snapshot.votes.formal.length, 53);
    assert.equal(Object.keys(snapshot.taskByRound).length, 8);
    assert.equal(snapshot.taskByRound['004'], 'chinese-architecture');
    assert.deepEqual(Object.keys(snapshot.roundByTask).sort(), Object.values(snapshot.taskByRound).sort());
    for (const [rid, work] of Object.entries(snapshot.workMap)) {
      assert.ok(work.up && work.task && work.mid, `workMap ${rid} is complete`);
      assert.ok(snapshot.upToRid[work.up] === rid, `upToRid reverses ${rid}`);
      assert.equal(snapshot.taskByRound[work.round], work.task);
    }
    const missing = [];
    for (const scope of ['entertainment', 'formal']) {
      for (const vote of snapshot.votes[scope]) {
        if (!snapshot.workMap[vote.winnerRid] || !snapshot.workMap[vote.loserRid]) missing.push(`${scope}:${vote.id}`);
      }
    }
    assert.deepEqual(missing, [], 'every snapshot vote resolves both rids through workMap');
    for (const work of snapshot.works) {
      const content = JSON.parse(work.content);
      if (content.kind === 'html') assert.match(content.src, /^https:\/\/w[a-z0-9]+\.w\.arenaofbias\.icu\/$/, `src rewritten for ${work.id}`);
    }
    assert.equal(snapshot.commentsBackfill.length, 16);
  });

  test('endpoints reproduce the goldens from the snapshot alone', () => withServer({ snapshot }, async ({ base }) => {
    assert.equal((await call(base, 'GET', '/api/prompts')).data.prompts.length, 8);
    assert.equal((await call(base, 'GET', '/api/works')).data.works.length, 262);
    for (const scope of ['entertainment', 'formal']) {
      const votes = golden(`votes_${scope}.json`).votes;
      const response = await call(base, 'GET', `/api/votes?scope=${scope}`);
      assert.equal(response.data.votes.length, votes.length, scope);
      assert.deepEqual(response.data.votes[0], votes[0], `${scope} first vote`);
      assert.deepEqual(response.data.votes.at(-1), votes.at(-1), `${scope} last vote`);
      const ratings = await call(base, 'GET', `/api/ratings?scope=${scope}`);
      const expected = golden(`ratings_scope_${scope}.json`);
      assert.deepEqual(ratings.data.ratings, expected.ratings, `${scope} Elo replay`);
      assert.deepEqual(ratings.data.games, expected.games, `${scope} appearance counts`);
    }
    const comments = await call(base, 'GET', '/api/comments?round=001');
    assert.equal(comments.status, 200);
    assert.deepEqual(comments.data.comments, [], 'no live comments in an empty database');
  }));
});
