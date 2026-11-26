import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import {
  BACKEND_CATEGORY,
  BACKEND_TASK_IDS,
  backendLeaderboard,
  backendQuestions,
  verifyBackendBenchmarkData,
  weightedTotal600,
} from '../server/backend-benchmark.mjs';
import { limits } from '../server/config.mjs';
import { verifiedUser } from './helpers/email.mjs';

const FORBIDDEN_INTERNAL_NAMES = [
  'history', 'lsm', 'placement', 'migration', 'replication',
  'provenance', 'raft', 'sqlite', 'compiler', 'crossdb',
];

test('AGB-Bench v4.1 data validates weights, vendors, sorting, and hides internal repo names', () => {
  assert.equal(verifyBackendBenchmarkData(), true);

  const board = backendLeaderboard();
  assert.equal(board.kind, 'backend-benchmark');
  assert.equal(board.suite, 'AGB-Bench v4.1');
  assert.equal(board.ratio, '1:2:1:2');
  assert.deepEqual(board.weights, { EZ: 1, HD: 2, IN: 1, AT: 2 });
  assert.equal(board.tier, null);
  assert.equal(board.tiers.length, 4);
  assert.equal(board.rows.length, 18);
  assert.equal(board.partialRows.length, 2);

  for (const row of [...board.rows, ...board.partialRows]) {
    assert.equal(weightedTotal600(row), row.total600);
    assert.equal(row.total100, Number((row.total600 / 6).toFixed(2)));
  }

  const byName = (name, effort) => [...board.rows, ...board.partialRows].find((r) => r.name === name && (!effort || r.effort === effort));
  assert.equal(byName('LongCat 2.5').vendor, 'Meituan');
  assert.equal(byName('Hy4 V3转算').vendor, 'Tencent');
  assert.equal(byName('Kimi K3.1 Pro V3转算').vendor, 'Moonshot AI');
  assert.equal(byName('Qwen3.8 Flash').vendor, 'Alibaba');
  assert.equal(byName('GLM 5.4', 'Max').vendor, 'Z.ai');
  assert.equal(byName('DeepSeek V4.1 Flash 1017').vendor, 'DeepSeek');
  assert.equal(byName('Grok 4.7').vendor, 'xAI');
  assert.equal(byName('MiniMax M3.1 Flash', 'XHigh').vendor, 'MiniMax');
  assert.deepEqual(board.partialRows.map((r) => r.name), ['Qwen3.8 Flash', 'GLM 5.4']);

  // Verify tier filtering (case-insensitive) and invalid tier rejection.
  const hd = backendLeaderboard('hd');
  assert.equal(hd.tier, 'HD');
  assert.equal(hd.rows.length, 18);
  assert.deepEqual(hd.partialRows, []);
  assert.ok(hd.rows.every((row, i) => i === 0 || hd.rows[i - 1].score >= row.score));
  assert.equal(backendLeaderboard('at').rows.length, 20);
  assert.equal(backendLeaderboard('ez').rows.length, 19);
  assert.equal(backendLeaderboard('in').rows.length, 19);
  assert.throws(() => backendLeaderboard('invalid'), { status: 400, code: 'invalid_query' });

  // Verify 4 backend questions shape & zero forbidden internal benchmark names.
  const questions = backendQuestions(new Map([['agb-v41-in', 'hard']]));
  assert.equal(questions.length, 4);
  assert.deepEqual(questions.map((q) => q.id), ['agb-v41-ez', 'agb-v41-hd', 'agb-v41-in', 'agb-v41-at']);
  assert.ok(questions.every((q) => q.category === BACKEND_CATEGORY && q.benchmarkOnly === true && q.acceptsUploads === false));
  assert.equal(questions.find((q) => q.id === 'agb-v41-ez').solveStatus, 'solved');
  assert.equal(questions.find((q) => q.id === 'agb-v41-in').solveStatus, 'hard');
  assert.deepEqual(questions.find((q) => q.id === 'agb-v41-hd').languages, ['Go', 'C']);
  assert.equal(questions.find((q) => q.id === 'agb-v41-hd').languageLabel, 'Go + C');

  const serialized = JSON.stringify({ board, ez: backendLeaderboard('EZ'), hd, questions }).toLowerCase();
  for (const term of FORBIDDEN_INTERNAL_NAMES) {
    assert.equal(new RegExp(`\\b${term}\\b`, 'i').test(serialized), false, `forbidden internal term leaked: ${term}`);
  }
});

test('backend endpoints, guided catalog visibility, solve-status toggle, and manual creation block', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'backend-bench-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({
    models: [{ id: 'm1', name: 'M1', vendor: 'Test' }],
    tasks: [{ id: 'web1', title: 'Web1', summary: 'S', prompt: 'P', category: '静态网页', domains: ['计算机技术'], results: [] }],
  }));
  const origin = 'https://gallery.example.test';
  const platform = createPlatform({
    config: {
      dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost',
      siteOrigins: [origin], admins: [], cdn: [], capture: false, secureCookies: false,
      moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 }, leaderboardWarmup: false,
    },
    limits,
  });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  const admin = platform.auth.createAdmin('root', 'secret pass');
  platform.auth.bindEmail(admin.id, 'root@example.test');
  const member = await verifiedUser(platform.auth, 'member');
  platform.auth.promote(member.id, 1);
  const cookies = {};
  for (const [k, u] of Object.entries({ admin, member })) {
    platform.auth.startSession({ setHeader: (_n, v) => { cookies[k] = v.split(';')[0]; } }, u.id);
  }
  const call = async (path, { who, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        origin,
        'accept-encoding': 'identity',
        ...(who ? { cookie: cookies[who] } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  // Public backend leaderboard endpoint
  const overall = await call('/api/leaderboard/backend');
  assert.equal(overall.status, 200);
  assert.equal(overall.data.rows.length, 18);
  assert.equal(overall.data.partialRows.length, 2);

  const tierIn = await call('/api/leaderboard/backend?tier=in');
  assert.equal(tierIn.status, 200);
  assert.equal(tierIn.data.tier, 'IN');
  assert.equal(tierIn.data.rows.length, 19);

  const badTier = await call('/api/leaderboard/backend?tier=nope');
  assert.equal(badTier.status, 400);
  assert.equal(badTier.data.code, 'invalid_query');

  // Public bootstrap hides backend questions; guided bootstrap includes them
  const pub = await call('/api/bootstrap?lite=1');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.questions.some((q) => BACKEND_TASK_IDS.has(q.id)), false);

  const guided = await call('/api/bootstrap?lite=1&guided=1');
  assert.equal(guided.status, 200);
  const guidedBackend = guided.data.questions.filter((q) => q.category === BACKEND_CATEGORY);
  assert.equal(guidedBackend.length, 4);

  // Staff can toggle solve status for backend task IDs
  const toggle = await call('/api/admin/tasks/agb-v41-in/solve-status', {
    who: 'admin', method: 'PUT', body: { status: 'hard' },
  });
  assert.equal(toggle.status, 200);
  assert.equal(toggle.data.solveStatus, 'hard');
  const guidedAfter = await call('/api/catalog?guided=1');
  assert.equal(guidedAfter.data.questions.find((q) => q.id === 'agb-v41-in').solveStatus, 'hard');

  // Manual creation of 后端 questions is blocked
  const createPublic = await call('/api/questions', {
    who: 'member',
    method: 'POST',
    body: {
      title: 'Backend test', summary: 'Summary', prompt: 'Prompt',
      category: BACKEND_CATEGORY, domains: ['计算机技术'], templates: ['static'],
    },
  });
  assert.equal(createPublic.status, 400);
  assert.equal(createPublic.data.error, '后端闭卷题集由系统维护，不支持手动发起');

  const createAdmin = await call('/api/admin/questions', {
    who: 'admin',
    method: 'POST',
    body: {
      title: 'Backend admin test', summary: 'Summary', prompt: 'Prompt',
      category: BACKEND_CATEGORY, domains: ['计算机技术'], templates: ['static'],
    },
  });
  assert.equal(createAdmin.status, 400);
  assert.equal(createAdmin.data.error, '后端闭卷题集由系统维护，不支持手动发起');
});
