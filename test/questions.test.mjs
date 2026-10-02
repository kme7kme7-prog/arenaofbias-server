import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.deepEqual(JSON.parse(row.moderation), { status: 'legacy' });
    assert.equal(row.deleted_at, null);
    assert.equal(row.prompt, 'Exact\nprompt');
    MIGRATIONS[21](db);
    assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id = ?').get('q-old'), row);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('v23 backfills categories from tags before text templates and preserves existing categories', () => {
  const root = mkdtempSync(join(tmpdir(), 'question-category-migration-'));
  let db = new DatabaseSync(join(root, 'platform.db'));
  try {
    for (const migration of MIGRATIONS.slice(0, 22)) {
      if (typeof migration === 'function') migration(db); else db.exec(migration);
    }
    db.exec('PRAGMA user_version = 22');
    db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('owner', 'owner', 'owner', 'unused', 'unused', 1);
    const insert = db.prepare('INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, tags, templates] of [['tag', ['UI', '建模', '文学'], ['text']], ['text', [], ['text']], ['unknown', ['UI'], ['static']], ['mixed', [], ['text', 'static']]]) {
      insert.run(id, 'owner', id, 'summary', 'prompt', JSON.stringify(tags), JSON.stringify(templates), 2);
    }
    db.close(); db = openDatabase(join(root, 'platform.db'));
    const categories = () => Object.fromEntries(db.prepare('SELECT id, category FROM questions ORDER BY id').all().map(row => [row.id, row.category]));
    assert.deepEqual(categories(), { mixed: null, tag: '建模', text: '文学', unknown: null });
    db.prepare('UPDATE questions SET category = ? WHERE id = ?').run('静态网页', 'tag');
    const rows = db.prepare('SELECT * FROM questions ORDER BY id').all();
    MIGRATIONS[22](db);
    assert.deepEqual(db.prepare('SELECT * FROM questions ORDER BY id').all(), rows);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('admin question edits validate metadata, preserve decisions and protect existing answers', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('owner', 'owner', 'owner', 'unused', 'unused', 1);
    const questions = createQuestions(db);
    const owner = { id: 'owner', name: 'owner', role: 'member' };
    const admin = { id: 'admin', name: 'root', role: 'admin' };
    const body = { title: 'Question', summary: 'Summary', prompt: 'Original\nprompt', category: '静态网页', templates: ['static'], tags: ['建模', 'UI'] };
    const question = questions.create(owner, body);
    const row = () => db.prepare('SELECT * FROM questions WHERE id = ?').get(question.id);
    const failure = (data, status = 400, actor = admin) => assert.throws(() => questions.edit(actor, question.id, data), error => error.status === status);
    failure({ title: 'Title' }, 403, owner);
    assert.throws(() => questions.edit(admin, 'q-missing', { title: 'Title' }), error => error.status === 404);
    for (const data of [{}, { tags: [] }, { title: '' }, { title: 'x'.repeat(71) }, { summary: 'x'.repeat(401) },
      { prompt: 'x'.repeat(20001) }, { category: '其他' }, { domains: [] }, { domains: ['未知'] },
      { domains: ['数学', '物理', '化学'] }]) failure(data);
    const originalModeration = row().moderation;
    let edited = questions.edit(admin, question.id, { title: ' New title ', summary: ' New summary ', prompt: ' New\nprompt ', domains: ['数学', '数学'] });
    assert.equal(edited.title, 'New title'); assert.equal(edited.summary, 'New summary'); assert.equal(edited.prompt, 'New\nprompt');
    assert.deepEqual(edited.domains, ['数学']); assert.equal(row().moderation, originalModeration);
    const audit = JSON.parse(db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-edit' ORDER BY id DESC").get(question.id).detail);
    assert.deepEqual(audit.title, { from: body.title, to: edited.title });
    assert.deepEqual(audit.summary, { from: body.summary, to: edited.summary });
    assert.deepEqual(audit.domains, { from: [], to: ['数学'] });
    assert.deepEqual(audit.prompt, { changed: '已修改', fromLength: body.prompt.length, toLength: edited.prompt.length });
    assert.ok(!JSON.stringify(audit).includes('Original')); assert.ok(!JSON.stringify(audit).includes('New\\nprompt'));
    db.prepare(`INSERT INTO works (id, task_id, owner_id, title, model_other, content_key, source_name, root,
      entry, file_count, bytes, digest, checks, trial, created_at, updated_at)
      VALUES ('sample', ?, 'owner', 'Sample', 'Model', 'sample-key', 'sample.html', '', 'index.html', 1, 100, 'digest', '[]', '{}', 1, 1)`).run(question.id);
    for (const status of ['pending', 'rejected', 'approved', 'legacy']) {
      const moderation = JSON.stringify({ status, reason: 'Keep decision', at: 123 });
      db.prepare('UPDATE questions SET moderation = ? WHERE id = ?').run(moderation, question.id);
      questions.edit(admin, question.id, { title: status, summary: `Summary ${status}`, domains: ['物理'] });
      assert.equal(row().moderation, moderation);
      if (['approved', 'legacy'].includes(status)) {
        assert.throws(() => questions.edit(admin, question.id, { prompt: `Prompt ${status}` }),
          error => error.status === 409 && error.message === '已有作品的题目不能修改提示词');
        questions.edit(admin, question.id, { prompt: row().prompt });
      } else questions.edit(admin, question.id, { prompt: `Prompt ${status}` });
      failure({ category: '文学' }, 409);
    }
    edited = questions.edit(admin, question.id, { category: '建模' });
    assert.deepEqual(edited.templates, ['static']); assert.deepEqual(edited.tags, ['UI']);
    db.prepare('UPDATE works SET deleted_at = 1 WHERE id = ?').run('sample');
    edited = questions.edit(admin, question.id, { category: '文学', prompt: 'New text prompt' });
    assert.deepEqual(edited.templates, ['text']); assert.equal(edited.prompt, 'New text prompt');
    const resetAudit = JSON.parse(db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-edit' ORDER BY id DESC").get(question.id).detail);
    assert.deepEqual(resetAudit.templates, { from: ['static'], to: ['text'] });
    assert.deepEqual(resetAudit.category, { from: '建模', to: '文学' });
    db.exec("CREATE TRIGGER fail_edit_audit BEFORE INSERT ON audit WHEN NEW.action = 'question-edit' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => questions.edit(admin, question.id, { title: 'Should roll back' }), /audit failed/);
    assert.equal(row().title, 'legacy');
  } finally { db.close(); }
});

describe('community question and sample review lifecycle', () => {
  let root, platform, site, content, base;
  const cookies = new Map();
  const questionBody = { title: 'Question', summary: 'Test interaction', prompt: 'Build a page.\nKeep this text.', category: '静态网页', tags: ['UI'], templates: ['static'] };
  const workBody = { title: 'Sample', modelId: 'model-a', effort: 'High', providerId: 'official', harnessOther: 'Test harness', trial: { loaded: true } };
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
    for (const name of ['author', 'other', 'quota', 'deletion', 'categories', 'editing', 'batch']) {
      await verifiedUser(platform.auth, name);
      assert.equal((await call(name, 'POST', '/api/auth/login', { name, password: 'correct horse' })).status, 200);
    }
    const admin = platform.auth.createAdmin('root', 'correct horse');
    platform.auth.bindEmail(admin.id, 'root@example.test');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
  });
  after(async () => {
    site?.close(); content?.close(); await platform?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('categories are required, templates match and tags may be empty or omit the category', async () => {
    const staged = await draft('categories');
    for (const invalid of [{ category: undefined }, { category: '' }, { category: 'UI' }, { category: ['文学'] }, { category: '文学', templates: ['static'] }, { category: '建模', templates: ['text'] }]) {
      for (const sample of [{}, { draftId: staged.id, confirmed: true, work: workBody }]) {
        const result = await call('categories', 'POST', '/api/questions', { ...questionBody, ...sample, ...invalid });
        assert.equal(result.status, 400, JSON.stringify(result.data));
      }
    }
    for (const tags of [undefined, [], ['静态网页', 'UI']]) {
      const created = await call('categories', 'POST', '/api/questions', { ...questionBody, tags });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      assert.equal(created.data.question.category, '静态网页');
      assert.deepEqual(created.data.question.tags, tags?.length ? ['UI'] : []);
      await moderate(created.data.question.id, 'approved');
    }
  });

  test('approval fills or changes category, resets incompatible templates and records the changes', async () => {
    const created = await call('categories', 'POST', '/api/questions', questionBody);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.question.id;
    platform.db.prepare('UPDATE questions SET category = NULL WHERE id = ?').run(id);
    assert.equal((await moderate(id, 'approved')).status, 400);
    assert.equal((await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', category: 'UI' })).status, 400);
    assert.equal((await call('categories', 'GET', '/api/me')).data.questions.find(q => q.id === id).category, null);
    const decision = await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', category: '文学' });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    assert.equal(decision.data.question.category, '文学');
    assert.deepEqual(decision.data.question.templates, ['text']);
    const detail = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-review' ORDER BY rowid DESC LIMIT 1").get(id).detail);
    assert.deepEqual(detail.category, { from: null, to: '文学' });
    assert.deepEqual(detail.templates, { from: ['static'], to: ['text'] });
    assert.equal((await call('guest', 'GET', '/api/bootstrap')).data.questions.find(q => q.id === id).category, '文学');
    assert.equal((await call('root', 'GET', '/api/admin/questions')).data.questions.find(q => q.id === id).category, '文学');
    const changed = await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', category: '建模' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.question.templates, ['static', 'vite']);
    const changedDetail = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-review' ORDER BY rowid DESC LIMIT 1").get(id).detail);
    assert.deepEqual(changedDetail.category, { from: '文学', to: '建模' });
    assert.deepEqual(changedDetail.templates, { from: ['text'], to: ['static', 'vite'] });
    platform.db.prepare('UPDATE questions SET templates = ? WHERE id = ?').run('["static"]', id);
    const compatible = await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', category: '静态网页' });
    assert.equal(compatible.status, 200);
    assert.deepEqual(compatible.data.question.templates, ['static']);
    const compatibleDetail = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-review' ORDER BY rowid DESC LIMIT 1").get(id).detail);
    assert.deepEqual(compatibleDetail.category, { from: '建模', to: '静态网页' });
    assert.ok(!Object.hasOwn(compatibleDetail, 'templates'));
    const rejected = await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'rejected', reason: '测试', category: 'invalid' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.question.category, '静态网页');
  });

  test('domains are optional on create, checked when sent and corrected on approval', async () => {
    for (const domains of [[], ['UI'], ['数学', '化学', '物理'], '数学']) {
      assert.equal((await call('categories', 'POST', '/api/questions', { ...questionBody, domains })).status, 400, JSON.stringify(domains));
    }
    const older = await call('categories', 'POST', '/api/questions', questionBody);
    assert.deepEqual(older.data.question.domains, [], 'clients that send no domains still publish');
    await moderate(older.data.question.id, 'rejected', '测试');
    const created = await call('categories', 'POST', '/api/questions', { ...questionBody, domains: ['数学', '数学'] });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.question.id;
    assert.deepEqual(created.data.question.domains, ['数学']);
    assert.equal((await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', domains: ['UI'] })).status, 400);
    const decision = await call('root', 'POST', `/api/questions/${id}/moderation`, { status: 'approved', domains: ['数学', '物理'] });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    assert.deepEqual(decision.data.question.domains, ['数学', '物理']);
    const detail = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-review' ORDER BY rowid DESC LIMIT 1").get(id).detail);
    assert.deepEqual(detail.domains, { from: ['数学'], to: ['数学', '物理'] });
    const boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.ok(boot.domains.includes('化学'));
    assert.deepEqual(boot.questions.find(q => q.id === id).domains, ['数学', '物理']);
    const board = await call('guest', 'GET', `/api/leaderboard?domain=${encodeURIComponent('物理')}`);
    assert.equal(board.status, 200, JSON.stringify(board.data));
    assert.equal(board.data.domain, '物理');
    for (const query of ['domain=化学', `domain=${encodeURIComponent('物理')}&task=${id}`]) {
      assert.equal((await call('guest', 'GET', `/api/leaderboard?${query}`)).status, 400, query);
    }
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
    for (const invalid of [{ confirmed: false }, { work: { ...workBody, harnessOther: '' } }, { work: { ...workBody, cover: 'invalid' } }, { templates: ['vite'] }]) {
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
    assert.ok(!(await call('guest', 'GET', '/api/bootstrap')).data.works.some(w => w.id === work.id));
    assert.equal(await fetchScene(platform.library.originOf(platform.library.work(question.id, work.id).contentKey)), 410);
    const unverifiedBeforeQuestionApproval = (await call('root', 'GET', '/api/bootstrap')).data.review.unverified;
    assert.ok(!(await call('guest', 'GET', '/api/show1/works')).data.works.some(w => w.id === work.id));
    assert.equal((await call('other', 'POST', `/api/drafts?task=${question.id}&name=x.html`, '<html>test</html>', true)).status, 404);
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    assert.equal((await call('root', 'GET', '/api/bootstrap')).data.review.unverified, unverifiedBeforeQuestionApproval);
    boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.ok(boot.questions.some(q => q.id === question.id)); assert.ok(boot.works.some(w => w.id === work.id));
    assert.ok(!Object.hasOwn(boot.questions.find(q => q.id === question.id), 'moderation'));
    const ownerView = (await call('author', 'GET', '/api/me')).data.questions.find(q => q.id === question.id);
    assert.deepEqual(Object.keys(ownerView.moderation).sort(), ['at', 'status']);
    const fullView = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(q => q.id === question.id);
    assert.equal(fullView.moderation.source, 'human');
    assert.equal(fullView.moderation.reviewer, 'root');
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

  test('unverified queue excludes approved samples until their question is public', async () => {
    const before = (await call('root', 'GET', '/api/bootstrap')).data.review.unverified;
    const { question, work } = await create('author');
    const catalog = createCatalog(join(root, 'dist'), createQuestions(platform.db));
    assert.equal(catalog.task(question.id), null);
    assert.equal(catalog.task(question.id, { role: 'admin' }).id, question.id);
    assert.equal((await call('root', 'POST', `/api/works/${question.id}/${work.id}/moderation`, { status: 'approved' })).status, 200);
    assert.equal(platform.library.work(question.id, work.id).status, 'unverified');
    assert.equal((await call('root', 'GET', '/api/bootstrap')).data.review.unverified, before);
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    assert.equal(catalog.task(question.id).id, question.id);
    assert.equal((await call('root', 'GET', '/api/bootstrap')).data.review.unverified, before + 1);
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
    const ownerQuestion = (await call('other', 'GET', '/api/me')).data.questions.find(q => q.id === question.id);
    assert.deepEqual(ownerQuestion.moderation, { status: 'rejected', reason: '请补充有意义的测试目标', at: decided.data.question.moderation.at });
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

  test('admin metadata edits preserve decisions, update bootstrap and invalidate domain boards', async () => {
    const { question, work } = await create('editing', { domains: ['化学'], work: { ...workBody, generationMode: 'single-turn', humanIntervention: 'none' } });
    const path = `/api/admin/questions/${question.id}/meta`;
    assert.equal((await call('editing', 'POST', path, { title: 'Owner edit' })).status, 403);
    const pending = await call('root', 'POST', path, { prompt: 'Pending\nprompt update' });
    assert.equal(pending.status, 200); assert.equal(pending.data.question.prompt, 'Pending\nprompt update');
    assert.deepEqual(pending.data.question.moderation, question.moderation);
    await moderate(question.id, 'approved');
    await call('root', 'POST', `/api/works/${question.id}/${work.id}/moderation`, { status: 'approved' });
    await call('root', 'POST', `/api/works/${question.id}/${work.id}/review`, { status: 'verified', show_arena: true });
    const anchor = await call('editing', 'POST', '/api/questions', { ...questionBody, domains: ['化学'] });
    assert.equal(anchor.status, 200); await moderate(anchor.data.question.id, 'approved');
    const board = (domain) => call('guest', 'GET', `/api/leaderboard?domain=${encodeURIComponent(domain)}`);
    assert.equal((await board('化学')).data.unranked.length, 1);
    const before = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(item => item.id === question.id).moderation;
    const edit = await call('root', 'POST', path, { title: 'Edited public question', domains: ['天文'] });
    assert.equal(edit.status, 200); assert.deepEqual(edit.data.question.moderation, before);
    const publicQuestion = (await call('guest', 'GET', '/api/bootstrap')).data.questions.find(item => item.id === question.id);
    assert.equal(publicQuestion.title, 'Edited public question'); assert.deepEqual(publicQuestion.domains, ['天文']);
    assert.equal((await board('化学')).data.unranked.length, 0);
    assert.equal((await board('天文')).data.unranked.length, 1);
    const locked = await call('root', 'POST', path, { prompt: 'Public prompt update' });
    assert.equal(locked.status, 409); assert.match(JSON.stringify(locked.data), /已有作品的题目不能修改提示词/);
    const audit = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-edit' ORDER BY id DESC").get(question.id).detail);
    assert.deepEqual(audit.domains, { from: ['化学'], to: ['天文'] });
    await moderate(question.id, 'rejected', 'Finish edit fixture');
    await moderate(anchor.data.question.id, 'rejected', 'Finish domain fixture');
  });

  test('batch question moderation reports individual failures and validates rejection before writes', async () => {
    const empty = await call('batch', 'POST', '/api/questions', questionBody);
    const valid = await call('batch', 'POST', '/api/questions', { ...questionBody, domains: ['数学'] });
    assert.equal(empty.status, 200); assert.equal(valid.status, 200);
    const ids = [empty.data.question.id, valid.data.question.id, 'q-missing'];
    const endpoint = '/api/admin/questions/batch-moderation';
    assert.equal((await call('batch', 'POST', endpoint, { ids, status: 'approved' })).status, 403);
    const response = await call('root', 'POST', endpoint, { ids, status: 'approved' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.results.map(item => item.ok), [false, true, false]);
    assert.deepEqual(response.data.results.filter(item => !item.ok).map(item => item.error.status), [400, 404]);
    assert.equal(response.data.results[1].question.moderation.status, 'approved');
    assert.equal(platform.db.prepare("SELECT count(*) AS n FROM audit WHERE task_id = ? AND action = 'question-review'").get(ids[0]).n, 0);
    assert.equal(platform.db.prepare("SELECT count(*) AS n FROM audit WHERE task_id = ? AND action = 'question-review'").get(ids[1]).n, 1);
    const rows = platform.db.prepare('SELECT id, moderation FROM questions WHERE id IN (?, ?) ORDER BY id').all(...ids.slice(0, 2));
    const audits = platform.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const invalid = await call('root', 'POST', endpoint, { ids: ids.slice(0, 2), status: 'rejected' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(platform.db.prepare('SELECT id, moderation FROM questions WHERE id IN (?, ?) ORDER BY id').all(...ids.slice(0, 2)), rows);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
    const rejected = await call('root', 'POST', endpoint, { ids: ids.slice(0, 2), status: 'rejected', reason: 'Batch rejection' });
    assert.deepEqual(rejected.data.results.map(item => item.ok), [true, true]);
    const audit = JSON.parse(platform.db.prepare("SELECT detail FROM audit WHERE task_id = ? AND action = 'question-review' ORDER BY id DESC").get(ids[1]).detail);
    assert.equal(audit.status, 'rejected'); assert.equal(audit.reason, 'Batch rejection');
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
