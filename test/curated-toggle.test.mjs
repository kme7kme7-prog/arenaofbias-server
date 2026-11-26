import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase, transaction } from '../server/db.mjs';
import { createModerationTokens } from '../server/dots-moderation.mjs';
import { createDotsAdminBindings } from '../server/dots-admin.mjs';

const actors = Object.fromEntries(['user', 'moderator', 'admin'].map(role => [role, { id: role, name: role, role }]));
const rows = (db, table) => db.prepare(`SELECT * FROM "${table}"`).all().map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const state = db => Object.fromEntries(['curated_settings', 'curated_sections', 'curated_questions', 'audit'].map(name => [name, rows(db, name)]));
const ballots = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .filter(({ name }) => /vote|ballot/.test(name)).map(({ name }) => [name, rows(db, name)]));
function schema60(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  for (const [i, migration] of MIGRATIONS.slice(0, 60).entries()) {
    if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys=OFF');
    transaction(db, () => { typeof migration === 'function' ? migration(db) : db.exec(migration); db.exec(`PRAGMA user_version=${i + 1}`); });
    db.exec('PRAGMA foreign_keys=ON');
  }
  for (const actor of Object.values(actors)) db.prepare('INSERT INTO users(id,name,name_key,role,salt,hash,created_at,email,email_verified_at) VALUES (?,?,?,?,?,?,1,?,1)')
    .run(actor.id, actor.name, actor.name, actor.role, 'unused', 'unused', `${actor.id}@example.test`);
  // The shipped 36 seed IDs plus two synthetic prior selections, never production data.
  for (const [id, section] of [['existing-web', 'web-design'], ['existing-3d', 'three-dimensional']])
    db.prepare('INSERT INTO curated_questions VALUES (?,?,?,?)').run(id, section, 'original-selector', 1234);
  assert.equal(rows(db, 'curated_questions').length, 38);
  for (const source of ['arena', 'show1', 'legacy']) db.prepare(`INSERT INTO votes
    (id,match_id,user_id,task_id,a_work,b_work,pair_key,choice,created_at,source,a_identity,b_identity) VALUES (?,?,?,'old-task','a','b',?,'a',1,?,'{"taskId":"old-task"}','{"taskId":"old-task"}')`)
    .run(source, source, 'moderator', source, source);
  db.exec(`INSERT INTO guided_trial_votes(id,match_id,user_id,task_id,a_work,b_work,choice,created_at) VALUES ('trial','trial','moderator','old-task','a','b','tie',1);
    INSERT INTO legacy_vote_levels VALUES ('legacy',2)`);
  return db;
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'curated-toggle-')), dist = join(root, 'dist'), dataDir = join(root, 'state');
  let platform, server, originalBallots;
  t.after(async () => {
    try { if (platform) assert.deepEqual(ballots(platform.db), originalBallots, 'all ballot tables remain byte-for-byte equivalent as rows'); }
    finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await platform?.close(); rmSync(root, { recursive: true, force: true }); }
  });
  mkdirSync(dist); mkdirSync(dataDir); schema60(join(dataDir, 'platform.db')).close();
  const tasks = [['page', '静态网页', 2], ['tower', '建模', 2], ['poem', '文学', 2], ['song', '音乐', 2],
    ['sparse', '静态网页', 1], ['empty', '文学', 0], ['ai', '推理', 2], ['hidden', '建模', 2], ['existing-web', '静态网页', 2], ['existing-3d', '建模', 2]]
    .map(([id, category, count]) => ({ id, title: id, summary: 'Synthetic', prompt: 'Build', category, domains: ['文学艺术'], tags: id === 'hidden' ? ['arena-only'] : [],
      results: ['a', 'b'].slice(0, count).map(model => {
        const scene = `results/${id}/${model}/`; mkdirSync(join(dist, scene), { recursive: true }); writeFileSync(join(dist, scene, 'index.html'), `<title>${id}</title>`);
        return { id: model, model, scene, effort: 'High', generationMode: 'single-turn', humanIntervention: 'none' };
      }) }));
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: ['a', 'b'].map(id => ({ id, name: id })), tasks }));
  const origin = 'https://gallery.example.test';
  platform = createPlatform({ config: { dist, dataDir, contentTemplate: 'http://{token}.localhost', siteOrigins: [origin], admins: [], cdn: [],
    capture: false, secureCookies: false, moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 }, bootstrapCacheMs: 60_000, leaderboardWarmup: false }, limits });
  const { db, auth, curated } = platform; originalBallots = ballots(db);
  db.exec(`INSERT INTO questions(id,owner_id,title,summary,prompt,tags,templates,created_at,category,domains,moderation)
    VALUES ('pending','user','Pending','Synthetic','Build','[]','["static"]',1,'静态网页','[]','{"status":"pending"}')`);
  const cookies = {};
  for (const actor of Object.values(actors)) auth.startSession({ setHeader: (_name, value) => { cookies[actor.id] = value.split(';')[0]; } }, actor.id);
  server = createServer(platform.handleSite); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (path, { who, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { origin, 'accept-encoding': 'identity',
      ...(who ? { cookie: cookies[who] } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };
  return { platform, db, curated, call, server, cookies, original: rows(db, 'curated_questions'), set: (id, selected, actor = actors.moderator) => curated.setQuestion(actor, id, { selected, revision: curated.revision() }) };
}

test('v60 to v61 only adds missing sections; repeated migration preserves all 38 selections and ballots', t => {
  assert.ok(MIGRATIONS.length >= 61);
  const root = mkdtempSync(join(tmpdir(), 'curated-v61-')); let db;
  t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });
  for (const existing of [[], ['language'], ['music'], ['language', 'music']]) {
    const file = join(root, `case-${existing.join('-') || 'none'}.db`); db = schema60(file);
    for (const id of existing) db.prepare('INSERT INTO curated_sections VALUES (?,?,?,1,2,?)').run(id, `Custom ${id}`, 10 + existing.indexOf(id), 'original-selector');
    db.exec("UPDATE curated_settings SET revision=17,updated_by='original-selector',updated_at=1234");
    const before = state(db), votes = ballots(db); db.close(); db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const after = state(db), settings = after.curated_settings[0];
    assert.equal(settings.revision, 17 + Number(existing.length < 2));
    for (const key of ['counting_started_at', 'updated_by']) assert.equal(settings[key], before.curated_settings[0][key]);
    assert.deepEqual(after.curated_questions, before.curated_questions); assert.deepEqual(after.audit, before.audit); assert.deepEqual(ballots(db), votes);
    for (const section of before.curated_sections) assert.deepEqual(after.curated_sections.find(row => row.id === section.id), section);
    assert.equal(after.curated_sections.length, 4);
    for (const id of ['language', 'music']) assert.equal(after.curated_questions.filter(row => row.section_id === id).length, 0);
    if (existing.length === 2) assert.deepEqual(after, before);
    db.close(); db = openDatabase(file); assert.deepEqual(state(db), after);
    db.exec('PRAGMA user_version=60'); db.close(); db = openDatabase(file);
    assert.deepEqual(state(db), after, 'INSERT OR IGNORE replay does not bump revision or overwrite metadata'); assert.deepEqual(ballots(db), votes);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close(); db = null;
  }
});

test('method requires staff, strict booleans and integer revisions; rejected requests do not write', async t => {
  const { db, curated } = await fixture(t), before = state(db), revision = curated.revision();
  for (const actor of [null, actors.user, { id: 'user', role: 'author' }])
    assert.throws(() => curated.setQuestion(actor, 'page', { selected: true, revision }), { status: 403 });
  for (const selected of [undefined, null, 0, 1, 'true', {}, []])
    assert.throws(() => curated.setQuestion(actors.moderator, 'page', { selected, revision }), { status: 400 });
  for (const invalid of [undefined, null, String(revision), revision + 0.5])
    assert.throws(() => curated.setQuestion(actors.admin, 'page', { selected: true, revision: invalid }), { status: 400 });
  assert.throws(() => curated.setQuestion(actors.admin, 'page', null), { status: 400 });
  assert.throws(() => curated.setQuestion(actors.moderator, 'page', { selected: true, revision: revision - 1 }), { status: 409, code: 'curated_revision_conflict' });
  assert.deepEqual(state(db), before);
});

test('four public categories map to fixed sections; music and insufficient works stay off boards', async t => {
  const { platform, db, curated, set, original } = await fixture(t);
  for (const [id, section, available] of [['page', 'web-design', true], ['tower', 'three-dimensional', true], ['poem', 'language', true],
    ['song', 'music', false], ['sparse', 'web-design', false], ['empty', 'language', false]]) {
    const revision = curated.revision(); assert.deepEqual(set(id, true, id === 'tower' ? actors.admin : actors.moderator), { taskId: id, selected: true, sectionId: section, revision: revision + 1 });
    assert.ok(curated.selection() instanceof Map); assert.equal(curated.selection().get(id), section); assert.equal(curated.contains(id), available);
    assert.equal(curated.scope(section).taskIds.includes(id), available);
  }
  assert.equal(platform.library.eligible('song').length, 2, 'music is excluded by category, not missing works');
  assert.deepEqual(curated.info().sections.find(section => section.id === 'music').taskIds, []);
  assert.equal((await platform.arena.leaderboard({ audience: 'curated', sectionId: 'music' })).totals.votes, 0);
  const before = state(db);
  for (const [id, status] of [['missing', 404], ['pending', 404], ['hidden', 404], ['ai', 400]]) assert.throws(() => set(id, true), { status });
  assert.deepEqual(state(db), before);
  assert.deepEqual(rows(db, 'curated_questions').filter(row => original.some(old => old.task_id === row.task_id)), original);
});

test('global conflicts are atomic; repeated states preserve timestamps, actors and audits; deletion is local', async t => {
  const { db, curated, set, original } = await fixture(t), revision = curated.revision();
  const selected = set('page', true), after = state(db);
  assert.equal(after.curated_questions.find(row => row.task_id === 'page').selected_by, 'moderator');
  for (const [id, wanted] of [['tower', true], ['page', true]]) assert.throws(() => curated.setQuestion(actors.admin, id, { selected: wanted, revision }), { status: 409 });
  assert.deepEqual(set('page', true, actors.admin), selected); assert.deepEqual(state(db), after);
  assert.deepEqual(set('page', false, actors.admin), { taskId: 'page', selected: false, sectionId: null, revision: selected.revision + 1 });
  const removed = state(db); set('page', false); assert.deepEqual(state(db), removed);
  assert.deepEqual(rows(db, 'curated_questions'), original); assert.equal(curated.selection().has('page'), false);
  assert.deepEqual(rows(db, 'audit').filter(row => row.action === 'curated-question-toggle').map(row => [row.actor_id, row.task_id]), [['moderator', 'page'], ['admin', 'page']]);
  set('existing-web', false); const withoutSeed = state(db); set('existing-web', false, actors.admin);
  assert.deepEqual(state(db), withoutSeed); assert.deepEqual(rows(db, 'curated_questions'), original.filter(row => row.task_id !== 'existing-web'));
});

test('HTTP uses the cookie actor, rejects guests/users/forgeries, and permits both staff roles', async t => {
  const { db, curated, call, original } = await fixture(t), path = '/api/admin/curated/questions/page';
  const body = { selected: true, revision: curated.revision(), actor: actors.admin, actorId: 'admin', user: actors.admin, role: 'admin', sectionId: 'music' }, before = state(db);
  for (const [who, status] of [[undefined, 401], ['user', 403]]) assert.equal((await call(path, { method: 'PUT', who, body })).status, status);
  assert.equal((await call(path, { method: 'PUT', body, headers: { cookie: 'sp_session=admin', 'x-user-id': 'admin', 'x-role': 'admin' } })).status, 401);
  assert.deepEqual(state(db), before);
  const selected = await call(path, { method: 'PUT', who: 'moderator', body }); assert.equal(selected.status, 200);
  assert.equal(selected.data.sectionId, 'web-design');
  assert.equal(db.prepare("SELECT selected_by FROM curated_questions WHERE task_id='page'").get().selected_by, 'moderator');
  assert.equal(db.prepare("SELECT actor_id FROM audit WHERE action='curated-question-toggle' ORDER BY id DESC LIMIT 1").get().actor_id, 'moderator');
  const stale = await call('/api/admin/curated/questions/tower', { method: 'PUT', who: 'admin', body });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'curated_revision_conflict');
  assert.equal((await call(path, { method: 'PUT', who: 'admin', body: { selected: false, revision: selected.data.revision } })).status, 200);
  for (const [who, wanted] of [['admin', true], ['moderator', false]])
    assert.equal((await call(path, { method: 'PUT', who, body: { selected: wanted, revision: curated.revision() } })).status, 200);
  assert.deepEqual(rows(db, 'curated_questions'), original);
  assert.equal(db.prepare("SELECT role FROM users WHERE id='moderator'").get().role, 'moderator');
});

test('session revocation and staff demotion during body upload prevent any curation write', async t => {
  const { platform, db, curated, server, cookies, original } = await fixture(t);
  for (const [change, status] of [['logout', 401], ['demotion', 403]]) {
    platform.auth.promote('moderator', 'moderator');
    platform.auth.startSession({ setHeader: (_key, value) => { cookies.moderator = value.split(';')[0]; } }, 'moderator');
    const body = JSON.stringify({ selected: true, revision: curated.revision() });
    const entered = new Promise(resolve => server.once('request', () => queueMicrotask(resolve)));
    let req;
    const response = new Promise((resolve, reject) => {
      req = httpRequest(`http://127.0.0.1:${server.address().port}/api/admin/curated/questions/page`, { method: 'PUT', headers: {
        origin: 'https://gallery.example.test', cookie: cookies.moderator, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
    });
    req.write(body.slice(0, 1));
    await entered;
    if (change === 'logout') db.prepare('DELETE FROM sessions WHERE user_id=?').run('moderator');
    else platform.auth.promote('moderator', 'user');
    req.end(body.slice(1));
    assert.equal(await response, status);
    assert.deepEqual(rows(db, 'curated_questions'), original);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='curated-question-toggle'").get().n, 0);
  }
});

test('bulk configuration remains senior-only and the single-question route is not exposed to dots', async t => {
  const { platform, db, curated, call } = await fixture(t), revision = curated.revision();
  const body = { revision, questions: rows(db, 'curated_questions').map(row => ({ taskId: row.task_id, sectionId: row.section_id })) }, before = state(db);
  assert.throws(() => curated.saveQuestions(actors.moderator, body), { status: 403 });
  assert.equal((await call('/api/admin/curated/questions', { who: 'moderator', method: 'PUT', body })).status, 403);
  assert.equal((await call('/api/admin/curated', { who: 'moderator' })).status, 403); assert.deepEqual(state(db), before);
  const tokens = createModerationTokens(db), token = tokens.create('toggle-test', 'test');
  createDotsAdminBindings({ db, auth: platform.auth }).bind(token.id, actors.admin.id);
  tokens.grant(token.id, 'admin:read'); tokens.grant(token.id, 'admin:write');
  const headers = { authorization: `Bearer ${token.token}` }, toggle = { selected: true, revision };
  const caps = await call('/api/dots/admin/caps', { headers }); assert.equal(caps.status, 200);
  assert.ok(!caps.data.routes.some(route => route.path === '/api/dots/admin/curated/questions/:task'));
  assert.equal((await call('/api/dots/admin/curated/questions/page', { headers, method: 'PUT', body: toggle })).status, 404);
  const forbidden = await call('/api/admin/curated/questions/page', { who: 'admin', headers, method: 'PUT', body: toggle });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.data.code, 'token_forbidden');
  assert.deepEqual(rows(db, 'curated_questions'), before.curated_questions); assert.equal(curated.revision(), revision);
  assert.equal((await call('/api/admin/curated/questions', { who: 'admin', method: 'PUT', body })).status, 200);
});

test('guided catalog/full/lite bootstrap revalidate immediately after each toggle; formal responses omit the field', async t => {
  const { curated, call, set } = await fixture(t);
  const paths = ['/api/catalog?guided=1', '/api/bootstrap?guided=1', '/api/bootstrap?guided=1&lite=1'], cached = new Map();
  const check = data => { assert.ok(data.questions.length); for (const q of data.questions) assert.equal(q.curatedSectionId, curated.selection().get(q.id) ?? null); };
  for (const path of paths) {
    const first = await call(path); assert.equal(first.status, 200); check(first.data); assert.ok(first.headers.get('etag')); cached.set(path, first);
    assert.equal((await call(path, { headers: { 'if-none-match': first.headers.get('etag') } })).status, 304);
  }
  for (const selected of [true, false]) {
    set('song', selected);
    for (const path of paths) {
      const previous = cached.get(path), next = await call(path, { headers: { 'if-none-match': previous.headers.get('etag') } });
      assert.equal(next.status, 200, path); assert.notEqual(next.headers.get('etag'), previous.headers.get('etag')); check(next.data);
      assert.equal(next.data.questions.find(q => q.id === 'song').curatedSectionId, selected ? 'music' : null); cached.set(path, next);
      assert.equal((await call(path, { headers: { 'if-none-match': next.headers.get('etag') } })).status, 304);
    }
    for (const path of ['/api/catalog', '/api/bootstrap', '/api/bootstrap?lite=1']) for (const who of [undefined, 'moderator']) {
      const formal = await call(path, { who }); assert.equal(formal.status, 200);
      assert.ok(formal.data.questions.length); assert.ok(formal.data.questions.every(q => !Object.hasOwn(q, 'curatedSectionId')));
    }
    for (const path of paths.slice(1)) { const personal = await call(path, { who: 'moderator' }); assert.equal(personal.status, 200); check(personal.data); }
  }
});
