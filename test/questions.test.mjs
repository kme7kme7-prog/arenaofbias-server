import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { createQuestions } from '../server/questions.mjs';

test('v22 migrates existing questions to legacy without losing their data and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'question-migration-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, 21)) {
      if (typeof migration === 'function') migration(db); else db.exec(migration);
    }
    db.exec('PRAGMA user_version = 21');
    db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('owner', 'owner', 'owner', 'unused', 'unused', 1);
    db.prepare('INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('q-old', 'owner', 'Old title', 'Old summary', 'Exact\nprompt', '["UI"]', '["static"]', 2);
    db.close(); db = openDatabase(file);
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get('q-old');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 22);
    assert.deepEqual(JSON.parse(row.moderation), { status: 'legacy' });
    assert.equal(row.deleted_at, null);
    assert.equal(row.prompt, 'Exact\nprompt');
    MIGRATIONS[21](db);
    assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id = ?').get('q-old'), row);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

describe('community question and sample review lifecycle', () => {
  let root, platform, site, content, base;
  const cookies = new Map();
  const questionBody = { title: 'Question', summary: 'Test interaction', prompt: 'Build a page.\nKeep this text.', tags: ['UI'], templates: ['static'] };
  const workBody = { title: 'Sample', modelId: 'model-a', effort: 'High', harnessOther: 'Test harness', trial: { loaded: true } };
  async function call(who, method, path, body, raw = false) {
    const headers = { origin: base };
    if (cookies.has(who)) headers.cookie = cookies.get(who);
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookies.set(who, response.headers.get('set-cookie').split(';')[0]);
    return { status: response.status, data: await response.json() };
  }
  async function draft(who, task = '__new__') {
    const response = await call(who, 'POST', `/api/drafts?task=${task}&template=static&name=sample.html`, '<!doctype html><title>Sample</title><h1>Sample</h1>', true);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.draft;
  }
  async function create(who, overrides = {}) {
    const staged = await draft(who);
    const response = await call(who, 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody, ...overrides });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  const moderate = (id, status, reason = '') => call('root', 'POST', `/api/questions/${id}/moderation`, { status, reason });
  function fetchScene(scene) {
    const url = new URL(scene);
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search, headers: { host: url.host } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
  }
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'question-review-'));
    const dist = join(root, 'dist'); mkdirSync(dist);
    writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'test', models: [{ id: 'model-a', name: 'Model A', vendor: 'Test' }], tasks: [{ id: 'one', title: 'One', results: [] }] }));
    const config = { dist, dataDir: join(root, 'data'), contentTemplate: '', siteOrigins: [], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: false, moderation: { enabled: true, apiKey: '', model: 'gpt-6-luna' } };
    platform = createPlatform({ config, limits: { ...limits, pendingPerUser: 30 } });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    content = createServer(platform.handleContent).listen(0, '127.0.0.1');
    await Promise.all([site, content].map(server => new Promise(resolve => server.once('listening', resolve))));
    base = `http://127.0.0.1:${site.address().port}`;
    config.contentTemplate = `http://{token}.localhost:${content.address().port}`;
    for (const name of ['author', 'other', 'quota', 'deletion']) assert.equal((await call(name, 'POST', '/api/auth/register', { name, password: 'correct horse' })).status, 200);
    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
  });
  after(async () => {
    site?.close(); content?.close(); await platform?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('reserved drafts recover and cannot be submitted as ordinary works; validation preserves the draft', async () => {
    const staged = await draft('author');
    assert.equal((await call('author', 'GET', '/api/drafts?task=__new__')).data.draft.id, staged.id);
    assert.equal((await call('author', 'POST', '/api/works', { ...workBody, draftId: staged.id, confirmed: true })).status, 400);
    assert.equal((await call('guest', 'POST', '/api/questions', questionBody)).status, 401);
    for (const missing of [{ confirmed: true }, { draftId: staged.id }, { work: workBody }]) {
      const response = await call('author', 'POST', '/api/questions', { ...questionBody, ...missing });
      assert.equal(response.status, 400); assert.match(JSON.stringify(response.data), /[\u4e00-\u9fff]/);
    }
    const normal = await draft('author', 'one');
    assert.equal((await call('author', 'POST', '/api/questions', { ...questionBody, draftId: normal.id, confirmed: true, work: workBody })).status, 400);
    const count = platform.db.prepare('SELECT count(*) AS n FROM questions').get().n;
    for (const invalid of [{ confirmed: false }, { work: { ...workBody, harnessOther: '' } }, { work: { ...workBody, cover: 'invalid' } }, { templates: ['vite'] }, { tags: [] }]) {
      const response = await call('author', 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody, ...invalid });
      assert.equal(response.status, 400, JSON.stringify(response.data));
      assert.equal(platform.db.prepare('SELECT count(*) AS n FROM questions').get().n, count);
      assert.ok(platform.db.prepare('SELECT id FROM drafts WHERE id = ?').get(staged.id));
      assert.ok(existsSync(join(root, 'data', 'drafts', staged.id, 'index.html')));
    }
    assert.equal((await call('other', 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody })).status, 404);
    const audits = platform.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const works = platform.db.prepare('SELECT count(*) AS n FROM works').get().n;
    platform.db.exec("CREATE TRIGGER fail_question_sample BEFORE INSERT ON works BEGIN SELECT RAISE(ABORT, 'sample insert failed'); END");
    try {
      assert.equal((await call('author', 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody })).status, 500);
    } finally { platform.db.exec('DROP TRIGGER fail_question_sample'); }
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM questions').get().n, count);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM works').get().n, works);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
    assert.equal((await call('author', 'GET', '/api/drafts?task=__new__')).data.draft.id, staged.id);
    assert.ok(existsSync(join(root, 'data', 'drafts', staged.id, 'index.html')));
  });

  test('questions without samples stay pending and private with empty admin samples', async () => {
    const works = platform.db.prepare('SELECT count(*) AS n FROM works').get().n;
    const response = await call('other', 'POST', '/api/questions', questionBody);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(Object.keys(response.data), ['question']);
    const { question } = response.data;
    assert.equal(question.moderation.status, 'pending');
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM works').get().n, works);
    assert.ok((await call('other', 'GET', '/api/me')).data.questions.some(q => q.id === question.id && q.moderation.status === 'pending'));
    assert.ok(!(await call('guest', 'GET', '/api/bootstrap')).data.questions.some(q => q.id === question.id));
    assert.equal(createCatalog(join(root, 'dist'), createQuestions(platform.db)).task(question.id), null);
    const admin = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(q => q.id === question.id);
    assert.equal(admin.works, 0); assert.deepEqual(admin.samples, []);
    assert.ok(platform.db.prepare('SELECT * FROM audit WHERE task_id = ? AND action = ?').get(question.id, 'question-create'));
  });

  test('question-only creation rolls back if its audit fails', async () => {
    const questions = platform.db.prepare('SELECT count(*) AS n FROM questions').get().n;
    const audits = platform.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    platform.db.exec("CREATE TRIGGER fail_question_audit BEFORE INSERT ON audit WHEN NEW.action = 'question-create' BEGIN SELECT RAISE(ABORT, 'question audit failed'); END");
    try {
      assert.equal((await call('other', 'POST', '/api/questions', questionBody)).status, 500);
    } finally { platform.db.exec('DROP TRIGGER fail_question_audit'); }
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM questions').get().n, questions);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  });

  test('three pending questions without samples block a fourth', async () => {
    assert.equal((await call('root', 'POST', '/api/questions', questionBody)).status, 200);
    assert.equal((await call('root', 'POST', '/api/questions', questionBody)).status, 200);
    assert.equal((await call('root', 'POST', '/api/questions', questionBody)).status, 200);
    assert.equal((await call('root', 'POST', '/api/questions', questionBody)).status, 429);
    assert.equal((await call('root', 'GET', '/api/me')).data.questions.filter(q => q.moderation.status === 'pending').length, 3);
  });

  test('question and sample appear privately, admin previews work, and approval gates public surfaces', async () => {
    const { question, work } = await create('author');
    assert.equal(question.moderation.status, 'pending'); assert.equal(work.task, question.id);
    assert.equal(work.moderation.status, 'pending');
    assert.equal(createCatalog(join(root, 'dist'), createQuestions(platform.db)).task(question.id), null);
    let boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.ok(!boot.questions.some(q => q.id === question.id)); assert.ok(!boot.works.some(w => w.id === work.id));
    assert.ok((await call('author', 'GET', '/api/me')).data.questions.some(q => q.id === question.id && q.moderation.status === 'pending'));
    assert.equal((await call('author', 'GET', '/api/admin/questions')).status, 403);
    const admin = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(q => q.id === question.id);
    assert.equal(admin.ownerName, 'author'); assert.equal(admin.works, 1);
    const sample = admin.samples[0];
    for (const field of ['id', 'task', 'title', 'modelName', 'effort', 'status', 'moderation', 'scene']) assert.ok(Object.hasOwn(sample, field), field);
    assert.match(new URL(sample.scene).hostname, /^p/); assert.equal(await fetchScene(sample.scene), 200);
    assert.ok((await call('root', 'GET', '/api/bootstrap')).data.review.questions >= 1);
    assert.equal((await call('root', 'POST', `/api/works/${question.id}/${work.id}/moderation`, { status: 'approved', reason: 'Safe sample' })).status, 200);
    assert.equal((await call('root', 'POST', `/api/works/${question.id}/${work.id}/review`, { status: 'verified', show_gallery: true, show_arena: true })).status, 200);
    const unverifiedBeforeQuestionApproval = (await call('root', 'GET', '/api/bootstrap')).data.review.unverified;
    assert.ok(!(await call('guest', 'GET', '/api/show1/works')).data.works.some(w => w.id === work.id));
    assert.equal((await call('other', 'POST', `/api/drafts?task=${question.id}&name=x.html`, '<html>test</html>', true)).status, 404);
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    assert.equal((await call('root', 'GET', '/api/bootstrap')).data.review.unverified, unverifiedBeforeQuestionApproval);
    boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.ok(boot.questions.some(q => q.id === question.id)); assert.ok(boot.works.some(w => w.id === work.id));
    assert.ok(!Object.hasOwn(boot.questions.find(q => q.id === question.id), 'moderation'));
    const publicScene = boot.works.find(w => w.id === work.id).scene;
    assert.match(new URL(publicScene).hostname, /^w/);
    assert.equal(await fetchScene(publicScene), 200);
    assert.ok((await call('guest', 'GET', '/api/show1/works')).data.works.some(w => w.id === work.id));
    assert.equal((await call('guest', 'GET', `/api/leaderboard?task=${question.id}`)).status, 200);
    assert.equal((await moderate(question.id, 'rejected', '题目含测试噪声')).status, 200);
    boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.ok(!boot.questions.some(q => q.id === question.id)); assert.ok(!boot.works.some(w => w.id === work.id));
    assert.ok(!(await call('guest', 'GET', '/api/show1/works')).data.works.some(w => w.id === work.id));
    assert.equal((await call('guest', 'GET', `/api/leaderboard?task=${question.id}`)).status, 404);
    assert.equal(await fetchScene(publicScene), 410);
  });

  test('human moderation validates reasons and writes an audit', async () => {
    const { question } = await create('other');
    assert.equal((await call('other', 'POST', `/api/questions/${question.id}/moderation`, { status: 'approved' })).status, 403);
    for (const body of [{ status: 'review' }, { status: 'rejected' }, { status: 'rejected', reason: ' ' }, { status: 'approved', reason: 'x'.repeat(501) }]) {
      assert.equal((await call('root', 'POST', `/api/questions/${question.id}/moderation`, body)).status, 400);
    }
    assert.equal((await moderate('q-missing', 'approved')).status, 404);
    const decided = await moderate(question.id, 'rejected', '请补充有意义的测试目标');
    assert.equal(decided.status, 200); assert.equal(decided.data.question.moderation.source, 'human');
    const audit = platform.db.prepare('SELECT * FROM audit WHERE task_id = ? AND action = ?').get(question.id, 'question-review');
    assert.ok(audit); assert.match(audit.detail, /请补充/);
  });

  test('three pending questions block a fourth without consuming its draft', async () => {
    for (let i = 0; i < 3; i++) await create('quota');
    const staged = await draft('quota');
    const response = await call('quota', 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody });
    assert.equal(response.status, 429);
    assert.equal((await call('quota', 'GET', '/api/drafts?task=__new__')).data.draft.id, staged.id);
    const first = (await call('quota', 'GET', '/api/me')).data.questions[0];
    await moderate(first.id, 'rejected', 'Test quota release');
    assert.equal((await call('quota', 'POST', '/api/questions', { ...questionBody, draftId: staged.id, confirmed: true, work: workBody })).status, 200);
  });

  test('deletion checks ownership, other authors and votes, and soft deletes attached works', async () => {
    const pending = await create('deletion');
    assert.equal((await call('other', 'DELETE', `/api/questions/${pending.question.id}`)).status, 403);
    assert.equal((await call('deletion', 'DELETE', `/api/questions/${pending.question.id}`)).status, 200);
    assert.ok(platform.db.prepare('SELECT deleted_at FROM questions WHERE id = ?').get(pending.question.id).deleted_at);
    assert.ok(platform.db.prepare('SELECT deleted_at FROM works WHERE id = ?').get(pending.work.id).deleted_at);
    assert.ok(!(await call('root', 'GET', '/api/admin/questions')).data.questions.some(q => q.id === pending.question.id));
    assert.equal((await call('root', 'DELETE', `/api/questions/${pending.question.id}`)).status, 404);
    const published = await create('deletion'); await moderate(published.question.id, 'approved');
    const staged = await draft('other', published.question.id);
    const attached = await call('other', 'POST', '/api/works', { ...workBody, draftId: staged.id, confirmed: true });
    assert.equal(attached.status, 200);
    const administration = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(q => q.id === published.question.id);
    assert.equal(administration.works, 2); assert.deepEqual(administration.samples.map(w => w.id), [published.work.id]);
    assert.equal((await call('deletion', 'DELETE', `/api/questions/${published.question.id}`)).status, 409);
    const voteId = 'question-vote';
    platform.db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(voteId, voteId, published.question.id, published.work.id, attached.data.work.id, voteId, 'a', Date.now());
    assert.equal((await call('root', 'DELETE', `/api/questions/${published.question.id}`)).status, 409);
    platform.db.prepare("UPDATE votes SET source = 'show1' WHERE id = ?").run(voteId);
    assert.equal((await call('root', 'DELETE', `/api/questions/${published.question.id}`)).status, 409);
    platform.db.prepare('DELETE FROM votes WHERE id = ?').run(voteId);
    assert.equal((await call('root', 'DELETE', `/api/questions/${published.question.id}`)).status, 200);
    assert.ok(platform.db.prepare('SELECT deleted_at FROM works WHERE id = ?').get(attached.data.work.id).deleted_at);
    assert.ok(platform.db.prepare('SELECT * FROM audit WHERE task_id = ? AND action = ?').get(published.question.id, 'question-delete'));
    const solo = await create('deletion'); await moderate(solo.question.id, 'approved');
    platform.db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(voteId, voteId, solo.question.id, solo.work.id, 'other-id', voteId, 'a', Date.now(), 'arena');
    assert.equal((await call('deletion', 'DELETE', `/api/questions/${solo.question.id}`)).status, 409);
    platform.db.prepare('DELETE FROM votes WHERE id = ?').run(voteId);
    assert.equal((await call('deletion', 'DELETE', `/api/questions/${solo.question.id}`)).status, 200);
    const rejected = await create('deletion'); await moderate(rejected.question.id, 'rejected', 'Remove test');
    assert.equal((await call('deletion', 'DELETE', `/api/questions/${rejected.question.id}`)).status, 200);
  });
});
