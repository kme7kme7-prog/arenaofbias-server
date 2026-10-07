import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { openDatabase } from '../server/db.mjs';
import { createQuestions } from '../server/questions.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { defaultTemplates, compatibleTemplates, isAiJudgedTask } from '../server/categories.mjs';

test('reasoning questions accept only text and include philosophy', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('owner', 'owner', 'owner', 'unused', 'unused', 1);
    const questions = createQuestions(db);
    const body = { title: 'Reasoning', summary: 'Summary', prompt: 'Explain', category: '推理', domains: ['哲学'], templates: ['text'] };
    const owner = { id: 'owner', name: 'owner', role: 'member' };
    const question = questions.create(owner, body);
    assert.equal(question.category, '推理');
    assert.deepEqual(question.templates, ['text']);
    assert.ok(isAiJudgedTask(question));
    assert.deepEqual(defaultTemplates('推理'), ['text']);
    for (const templates of [['static'], ['vite'], ['text', 'static']]) {
      assert.equal(compatibleTemplates('推理', templates), false);
      assert.throws(() => questions.create(owner, { ...body, templates }), (error) => error.status === 400);
    }
  } finally { db.close(); }
});

test('reasoning leaves stored ballots intact while removing pools, scores and compat rankings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-judged-'));
  const dist = join(root, 'dist');
  // Existing web questions can be reclassified without replacing their works.
  const tasks = ['writing', 'reasoning', 'reasoning-web'].map((id) => ({ id, title: id, summary: 'Summary', prompt: 'Explain',
    category: id === 'reasoning-web' ? '推理' : '文学', templates: [id === 'reasoning-web' ? 'static' : 'text'],
    domains: ['数学'], results: ['a', 'b'].map((model) => {
      const scene = `results/${id}/${model}/`;
      mkdirSync(join(dist, scene), { recursive: true });
      writeFileSync(join(dist, scene, 'index.html'), `<title>${id}</title>`);
      return { id: model, model, effort: 'High', scene, generationMode: 'single-turn', humanIntervention: 'none' };
    }) }));
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false }, limits });
  const server = createServer(platform.handleSite);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  try {
    const users = ['writer', 'thinker'].map((id) => ({ id, name: id, email: `${id}@example.test`, role: 'member' }));
    for (const user of users) platform.db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.name, 'unused', 'unused', 1);
    for (let i = 0; i < users.length; i++) {
      const match = await platform.arena.createMatch(users[i], tasks[i].id);
      assert.equal(platform.arena.vote(users[i], match.id, 'a').counted, true);
    }
    const pending = await platform.arena.createMatch(null, 'reasoning');
    const ballots = platform.db.prepare('SELECT * FROM votes ORDER BY id').all();
    // The compat layer scores its own source and must also stop reading these votes.
    platform.db.exec(`INSERT INTO matches (id, user_id, task_id, a_work, b_work, a_token, b_token, created_at, expires_at)
      SELECT 'compat-' || id, user_id, task_id, a_work, b_work, 'compat-' || a_token, 'compat-' || b_token, created_at, expires_at FROM matches WHERE choice IS NOT NULL;
      INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at, a_identity, b_identity, source)
      SELECT 'compat-' || id, 'compat-' || match_id, user_id, task_id, a_work, b_work, 'compat-' || pair_key, choice, created_at, a_identity, b_identity, 'show1' FROM votes WHERE source = 'arena'`);
    const before = await get('/api/bootstrap');
    assert.ok(!Object.hasOwn(before.arena, 'reasoning-web'));
    assert.ok(!Object.hasOwn(before.featured, 'reasoning-web'));
    assert.deepEqual(await platform.arena.workScores('reasoning-web'), []);
    await assert.rejects(() => platform.arena.createMatch(null, 'reasoning-web'), (error) => error.code === 'ai-judged');
    assert.deepEqual([before.totals.votes, before.totals.voters], [2, 2]);
    assert.equal((await get('/api/leaderboard?category=文学')).totals.votes, 2);
    assert.equal((await get('/api/show1/leaderboard?scope=entertainment')).board.totalVotes, 2);
    const questions = createQuestions(platform.db);
    createCatalog(dist, questions).refresh();
    questions.edit({ id: 'admin', name: 'admin', role: 'admin' }, 'reasoning', { category: '推理' });
    platform.arena.invalidate();
    const after = await get('/api/bootstrap');
    assert.deepEqual([after.totals.votes, after.totals.voters], [1, 1]);
    assert.ok(!Object.hasOwn(after.arena, 'reasoning'));
    assert.ok(Object.hasOwn(after.arena, 'writing'));
    assert.ok(!Object.hasOwn(after.featured, 'reasoning'));
    assert.deepEqual(platform.arena.poolStats('reasoning'), { works: 0, entries: 0 });
    await assert.rejects(() => platform.arena.createMatch(null, 'reasoning'), (error) => error.code === 'ai-judged');
    assert.throws(() => platform.arena.vote(null, pending.id, 'a'), (error) => error.code === 'ai-judged');
    for (const path of ['/api/leaderboard', '/api/leaderboard?category=文学', '/api/leaderboard?domain=数学']) {
      assert.equal((await get(path)).totals.votes, 1, path);
    }
    for (const path of ['/api/leaderboard?category=推理', '/api/leaderboard?task=reasoning']) {
      const board = await get(path);
      assert.deepEqual(board.rows, []);
      assert.deepEqual(board.unranked, []);
      assert.equal(board.totals.votes, 0);
    }
    assert.ok(!Object.hasOwn((await get('/api/leaderboard')).standings, '推理'));
    assert.deepEqual(await platform.arena.workScores('reasoning'), []);
    assert.equal((await get('/api/show1/leaderboard?scope=entertainment')).board.totalVotes, 1);
    assert.ok(!(await get('/api/prompts')).prompts.some((prompt) => prompt.id === 'reasoning'));
    assert.ok(!(await get('/api/works')).works.some((work) => work.promptId === 'reasoning'));
    assert.deepEqual(platform.db.prepare("SELECT * FROM votes WHERE source = 'arena' ORDER BY id").all(), ballots);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});
