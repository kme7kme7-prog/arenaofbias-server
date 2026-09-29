// Show1「模一把」移植保真测试：判定口径、每日答案派生、UTC+8 日历、
// /today 形状对 golden、check 双模式、result 落库。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { HttpError, createRouter, fail, sendJson } from '../server/http.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import {
  ATTRIBUTE_KEYS,
  GUESS_DIFFICULTIES,
  GUESS_EPOCH,
  GUESS_MODELS,
  VENDOR_REGION,
  answerForDate,
  dailyPool,
  dayNumber,
  guessDayKey,
  judge,
  modelById,
  poolForDifficulty,
  resolveGuess,
} from '../server/show1/guess-logic.mjs';
import { registerShow1Guess } from '../server/show1/guess.mjs';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/show1-golden/guess_today.json', import.meta.url), 'utf8'),
);

test('guess result migration preserves rows and marks later IP/day or user/day records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const step of MIGRATIONS.slice(0, -1)) {
      if (typeof step === 'function') step(db);
      else db.exec(step);
    }
    const add = db.prepare(`INSERT INTO guess_results (id, day_key, ip_hash, user_id, created_at)
      VALUES (?, '2026-09-20', ?, ?, ?)`);
    add.run('first', 'ip-a', 'u-a', 1);
    add.run('later-ip', 'ip-a', 'u-b', 2);
    add.run('later-user', 'ip-b', 'u-a', 3);
    add.run('other', 'ip-c', 'u-c', 4);
    const before = db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n;
    MIGRATIONS.at(-1)(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n, before);
    assert.deepEqual(db.prepare('SELECT id, superseded FROM guess_results ORDER BY created_at').all().map((row) => ({ ...row })), [
      { id: 'first', superseded: 0 }, { id: 'later-ip', superseded: 1 },
      { id: 'later-user', superseded: 1 }, { id: 'other', superseded: 0 },
    ]);
    assert.deepEqual(db.prepare('PRAGMA index_list(guess_results)').all().filter((row) => row.name.startsWith('guess_result_')).map((row) => row.partial), [1, 1]);
    MIGRATIONS.at(-1)(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n, before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results WHERE superseded = 1').get().n, 2);
    const addArchived = db.prepare(`INSERT INTO guess_results (id, day_key, ip_hash, user_id, created_at, superseded)
      VALUES (?, '2026-09-20', 'ip-a', 'u-a', 5, ?)`);
    addArchived.run('archived', 1);
    assert.throws(() => addArchived.run('duplicate-active', 0), /UNIQUE constraint failed/);
  } finally { db.close(); }
});

// ── 纯逻辑：judge() 逐属性 hit/near/miss/箭头 ──

const mk = (over = {}) => ({
  id: 'x',
  name: 'X',
  vendor: 'OpenAI',
  region: 'US',
  released: '2026-01',
  openWeights: true,
  contextK: 128,
  modalities: ['text'],
  reasoning: true,
  priceOut: 2,
  priceTier: 2,
  popularity: 50,
  difficulty: 2,
  ...over,
});
const attr = (guess, answer, key) => judge(guess, answer).attributes[key];

test('judge: vendor 同厂商绿 / 同地区黄 / 跨国灰', () => {
  assert.deepEqual(attr(mk({ vendor: 'OpenAI', region: 'US' }), mk({ vendor: 'OpenAI', region: 'US' }), 'vendor'), { state: 'hit', arrow: null });
  // 猜 xAI 答 OpenAI：都是美国 → 黄
  assert.deepEqual(attr(mk({ vendor: 'xAI', region: 'US' }), mk({ vendor: 'OpenAI', region: 'US' }), 'vendor'), { state: 'near', arrow: null });
  assert.deepEqual(attr(mk({ vendor: 'DeepSeek', region: 'CN' }), mk({ vendor: 'OpenAI', region: 'US' }), 'vendor'), { state: 'miss', arrow: null });
});

test('judge: released 月序号 ≤6 个月黄，带箭头', () => {
  assert.deepEqual(attr(mk({ released: '2026-01' }), mk({ released: '2026-01' }), 'released'), { state: 'hit', arrow: null });
  // 差 6 个月整 = near（阈值含端点），答案更新 → up
  assert.deepEqual(attr(mk({ released: '2026-01' }), mk({ released: '2026-07' }), 'released'), { state: 'near', arrow: 'up' });
  // 差 1 个月，答案更早 → down
  assert.deepEqual(attr(mk({ released: '2026-02' }), mk({ released: '2026-01' }), 'released'), { state: 'near', arrow: 'down' });
  // 跨年：2025-12 → 2026-06 正好 6 个月 = near
  assert.deepEqual(attr(mk({ released: '2025-12' }), mk({ released: '2026-06' }), 'released'), { state: 'near', arrow: 'up' });
  // 差 7 个月 = miss + 箭头
  assert.deepEqual(attr(mk({ released: '2026-01' }), mk({ released: '2026-08' }), 'released'), { state: 'miss', arrow: 'up' });
  assert.deepEqual(attr(mk({ released: '2026-08' }), mk({ released: '2026-01' }), 'released'), { state: 'miss', arrow: 'down' });
});

test('judge: openWeights 二值', () => {
  assert.deepEqual(attr(mk({ openWeights: true }), mk({ openWeights: true }), 'openWeights'), { state: 'hit', arrow: null });
  assert.deepEqual(attr(mk({ openWeights: false }), mk({ openWeights: true }), 'openWeights'), { state: 'miss', arrow: null });
});

test('judge: contextK 比值 ≤2 黄，null 为 unknown', () => {
  assert.deepEqual(attr(mk({ contextK: 128 }), mk({ contextK: 128 }), 'contextK'), { state: 'hit', arrow: null });
  // 200/128 ≈ 1.56 ≤ 2 → near；答案更大 → up
  assert.deepEqual(attr(mk({ contextK: 128 }), mk({ contextK: 200 }), 'contextK'), { state: 'near', arrow: 'up' });
  // 恰 2 倍 = near（含端点）
  assert.deepEqual(attr(mk({ contextK: 128 }), mk({ contextK: 256 }), 'contextK'), { state: 'near', arrow: 'up' });
  // 超 2 倍 = miss + 箭头
  assert.deepEqual(attr(mk({ contextK: 128 }), mk({ contextK: 300 }), 'contextK'), { state: 'miss', arrow: 'up' });
  assert.deepEqual(attr(mk({ contextK: 1000 }), mk({ contextK: 128 }), 'contextK'), { state: 'miss', arrow: 'down' });
  // 任一侧未公开 → unknown 无箭头
  assert.deepEqual(attr(mk({ contextK: null }), mk({ contextK: 128 }), 'contextK'), { state: 'unknown', arrow: null });
  assert.deepEqual(attr(mk({ contextK: 128 }), mk({ contextK: null }), 'contextK'), { state: 'unknown', arrow: null });
});

test('judge: modalities 相同绿 / 不同多模态黄 / 一纯一多灰', () => {
  const answer = GUESS_MODELS.find((m) => m.name === 'Claude Opus 4.6');
  assert.ok(answer);
  for (const name of ['GPT-4.1', 'Claude Opus 5', 'Claude Fable 5', 'Claude Opus 4.6']) {
    const guess = GUESS_MODELS.find((m) => m.name === name);
    assert.ok(guess, name);
    const feedback = judge(guess, answer);
    assert.deepEqual(feedback.attributes.modalities, { state: 'hit', arrow: null }, name);
    assert.equal(feedback.won, guess.id === answer.id, name);
  }
  const cases = [
    [['text'], ['text'], 'hit'],
    [['text', 'image', 'audio', 'video'], ['video', 'audio', 'image', 'text'], 'hit'],
    [['text', 'image'], ['image', 'text', 'image'], 'hit'],
    [['text', 'image'], ['text', 'image', 'video'], 'near'],
    [['text', 'image'], ['text', 'audio'], 'near'],
    [['text'], ['text', 'image'], 'miss'],
  ];
  for (const [left, right, state] of cases) {
    const a = mk({ id: 'guess', modalities: left });
    const b = mk({ id: 'answer', modalities: right });
    assert.deepEqual(attr(a, b, 'modalities'), { state, arrow: null });
    assert.deepEqual(attr(b, a, 'modalities'), { state, arrow: null });
  }
  for (const model of GUESS_MODELS)
    assert.deepEqual(attr(model, model, 'modalities'), { state: 'hit', arrow: null }, model.name);
});

test('judge: reasoning 二值', () => {
  assert.deepEqual(attr(mk({ reasoning: true }), mk({ reasoning: true }), 'reasoning'), { state: 'hit', arrow: null });
  assert.deepEqual(attr(mk({ reasoning: false }), mk({ reasoning: true }), 'reasoning'), { state: 'miss', arrow: null });
});

test('judge: priceTier 相邻档黄、差≥2 灰、null unknown', () => {
  assert.deepEqual(attr(mk({ priceTier: 2 }), mk({ priceTier: 2 }), 'priceTier'), { state: 'hit', arrow: null });
  // 差 1 = near + 箭头；答案更贵 → up
  assert.deepEqual(attr(mk({ priceTier: 1 }), mk({ priceTier: 2 }), 'priceTier'), { state: 'near', arrow: 'up' });
  // 0↔1 也是 near（不走比值口径——这是旧版修过的坑）
  assert.deepEqual(attr(mk({ priceTier: 0 }), mk({ priceTier: 1 }), 'priceTier'), { state: 'near', arrow: 'up' });
  // 差 2 = miss；答案更便宜 → down
  assert.deepEqual(attr(mk({ priceTier: 4 }), mk({ priceTier: 2 }), 'priceTier'), { state: 'miss', arrow: 'down' });
  assert.deepEqual(attr(mk({ priceTier: null }), mk({ priceTier: 2 }), 'priceTier'), { state: 'unknown', arrow: null });
  assert.deepEqual(attr(mk({ priceTier: 2 }), mk({ priceTier: null }), 'priceTier'), { state: 'unknown', arrow: null });
});

test('judge: won = id 全等；反馈键顺序 = ATTRIBUTE_KEYS', () => {
  const a = modelById.get('glm-5');
  assert.equal(judge(a, a).won, true);
  assert.deepEqual(Object.keys(judge(a, a).attributes), [...ATTRIBUTE_KEYS]);
  const b = modelById.get('glm-5-1');
  assert.equal(judge(a, b).won, false);
  // 同组近亲：厂商/模态多数命中、月份给黄——玩家由此推出正确版本号
  assert.equal(judge(a, b).attributes.vendor.state, 'hit');
});

test('judge: 数据集归一后 region 全部登记（无 ?? 兜底）', () => {
  const unregistered = GUESS_MODELS.filter((m) => m.region === '??');
  assert.deepEqual([...new Set(unregistered.map((m) => m.vendor))], []);
  for (const m of GUESS_MODELS) assert.ok(VENDOR_REGION[m.vendor], `${m.vendor} 未登记`);
});

// ── 纯逻辑：日期与每日答案派生 ──

test('guessDayKey / dayNumber：UTC+8 边界与 epoch 锚点', () => {
  // UTC 16:00 整 = 东八区次日 00:00
  assert.equal(guessDayKey(new Date('2026-09-12T16:00:00Z')), '2026-09-13');
  assert.equal(guessDayKey(new Date('2026-09-12T15:59:59Z')), '2026-09-12');
  // epoch 当天 = 0；前一天 = -1；golden 日 2026-09-28 = 15
  assert.equal(dayNumber(new Date('2026-09-13T00:00:00+08:00')), 0);
  assert.equal(dayNumber(new Date('2026-09-12T23:59:59+08:00')), -1);
  assert.equal(dayNumber(new Date('2026-09-28T08:00:00+08:00')), 15);
  assert.equal(GUESS_EPOCH, '2026-09-13');
  // 与 golden 对拍：今天的 dayKey/dayNumber 口径一致（同一天跑测试时严格相等）
  if (guessDayKey() === GOLDEN.dayKey) assert.equal(dayNumber(), GOLDEN.dayNumber);
});

test('answerForDate：对数据文件独立重算逐日一致（含组内轮转）', () => {
  // 独立重算实现：直接读原始 JSON、自行展开 variants/分槽/散列，
  // 不复用 guess-logic.mjs 的任何函数（日期换算只取 dayNumber 这个历法事实）。
  const raw = JSON.parse(
    readFileSync(new URL('../server/show1/guess-models.json', import.meta.url), 'utf8'),
  );
  const regionOf = (org) => VENDOR_REGION[org] ?? '??';
  const expand = [];
  for (const entry of raw.models) {
    const variants = entry.variants?.length ? entry.variants : [entry];
    for (const v of variants) {
      expand.push({
        id: v.id,
        difficulty: v.difficulty ?? entry.difficulty,
        sinceDay: v.sinceDay ?? entry.sinceDay,
        groupId: entry.variants?.length ? entry.id : undefined,
        region: regionOf(v.org),
      });
    }
  }
  assert.equal(expand.length, GUESS_MODELS.length);
  const pool = expand.filter((m) => m.difficulty <= 2);
  const referenceAnswer = (n) => {
    n = Math.max(0, n);
    const slots = new Map();
    for (const m of pool) {
      const key = m.groupId ?? m.id;
      if (slots.has(key)) slots.get(key).push(m);
      else slots.set(key, [m]);
    }
    const base = [];
    const extra = [];
    for (const slot of slots.values())
      (slot[0].sinceDay === undefined ? base : extra).push(slot);
    const select = (d) => {
      const h = (d * 2654435761) % 0xffffffff;
      const eligible = extra.filter((s) => (s[0].sinceDay ?? 0) <= d);
      const r = h % (base.length + eligible.length);
      return r < base.length ? base[r] : eligible[r - base.length];
    };
    const slot = select(n);
    if (slot.length === 1) return slot[0].id;
    let hits = 0;
    for (let d = 0; d < n; d++) if (select(d) === slot) hits++;
    return slot[hits % slot.length].id;
  };
  // 覆盖 epoch 前（clamp）、epoch 当天、golden 日及前后共 60 个 dayNumber
  for (let n = -3; n <= 56; n++) {
    const date = new Date(Date.UTC(2026, 8, 13 + n, 0, 0, 0) - 8 * 3600 * 1000);
    // 上面的构造保证 guessDayKey(date) = 2026-09-13 + n 天
    assert.equal(dayNumber(date), n);
    const expected = referenceAnswer(n);
    const actual = answerForDate(date, dailyPool(GUESS_MODELS)).id;
    assert.equal(actual, expected, `dayNumber ${n} 答案不一致`);
  }
  // golden 日（2026-09-28 = dayNumber 15）手工锚点：散列命中独立条目
  assert.equal(referenceAnswer(15), 'hy4-preview');
  assert.equal(answerForDate(new Date('2026-09-28T12:00:00+08:00'), dailyPool(GUESS_MODELS)).id, 'hy4-preview');
  // 组内轮转确实发生：0..56 天里同一多版本槽被多次命中时实例化了不同版本
  // （hy4-preview 所在槽是独立条目；找每日池里真实的多版本组验证轮转）
  const versionsBySlot = new Map();
  for (let n = 0; n <= 56; n++) {
    const id = referenceAnswer(n);
    const model = expand.find((m) => m.id === id);
    const key = model.groupId ?? model.id;
    if (!versionsBySlot.has(key)) versionsBySlot.set(key, new Set());
    versionsBySlot.get(key).add(id);
  }
  const rotated = [...versionsBySlot.entries()].filter(([, v]) => v.size > 1);
  assert.ok(rotated.length > 0, '多版本槽命中多次时应轮转实例化不同版本');
  // 答案分散性下界（实测 57 天 18 个不同答案——散列聚簇是旧端同款行为）
  assert.ok(new Set(Array.from({ length: 57 }, (_, n) => referenceAnswer(n))).size >= 15);
});

test('poolForDifficulty 层叠：简单 ⊂ 普通 ⊂ 困难 ⊂ 地狱=全库；dailyPool = ≤2', () => {
  const sizes = GUESS_DIFFICULTIES.map((d) => poolForDifficulty(GUESS_MODELS, d).length);
  assert.ok(sizes[0] > 0 && sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] < sizes[3]);
  assert.equal(sizes[3], GUESS_MODELS.length);
  assert.deepEqual(dailyPool(GUESS_MODELS), poolForDifficulty(GUESS_MODELS, 2));
});

test('resolveGuess：按 name 不区分大小写；id 不在此函数职责内', () => {
  assert.equal(resolveGuess('glm-5')?.id, 'glm-5');
  assert.equal(resolveGuess('  GLM-5 ').id, 'glm-5');
  assert.equal(resolveGuess('不存在的模型'), null);
  assert.equal(resolveGuess(''), null);
});

// ── HTTP 端点 ──

// 复刻 app.mjs handleSite 的核心路径（路由分发 + sendJson + HttpError 兜底），
// 保证与生产走线一致——尤其是 /result 直写 204 后 sendJson 抛错被吞的那一段。
function createFixture(user = null) {
  // guess_results 由 v8 迁移建好（openDatabase 直接跑到最新版本），无需手工建表。
  const db = openDatabase(':memory:');
  const router = createRouter();
  registerShow1Guess(router, { db, limit: {} });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://test.invalid');
      const route = router.match(req.method, url.pathname);
      if (!route) fail(404, '接口不存在');
      const ctx = { req, res, url, params: route.params, ip: '203.0.113.7', user };
      return sendJson(res, 200, (await route.handler(ctx)) ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      return sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
    }
  });
  return { db, server };
}

describe('guess endpoints', () => {
  let db, server, base;
  const user = { id: 'u-test-1', name: 'tester', role: 'member' };
  before(async () => {
    ({ db, server } = createFixture(user));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    db.close();
  });
  const get = (path) => fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));

  test('GET /api/guess/today：形状与 golden 一致，答案不下发', async () => {
    const { status, body } = await get('/api/guess/today');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ['dayKey', 'dayNumber', 'attributes', 'models']);
    assert.equal(body.dayKey, guessDayKey());
    assert.equal(body.dayNumber, dayNumber());
    assert.deepEqual(body.attributes, GOLDEN.attributes);
    assert.deepEqual(body.attributes, [...ATTRIBUTE_KEYS]);
    // golden 每个模型 id 都在，且白名单字段逐一相等
    const ours = new Map(body.models.map((m) => [m.id, m]));
    assert.equal(body.models.length, GOLDEN.models.length);
    for (const goldenModel of GOLDEN.models) {
      const found = ours.get(goldenModel.id);
      assert.ok(found, `golden 模型 ${goldenModel.id} 缺失`);
      assert.deepEqual(found, goldenModel);
    }
    // 白名单字段集合（无 region/groupId/popularity/sinceDay 等内部字段）
    for (const m of body.models)
      assert.deepEqual(Object.keys(m), ['id', 'name', 'vendor', 'released', 'openWeights', 'contextK', 'modalities', 'reasoning', 'priceOut', 'priceTier', 'difficulty']);
  });

  test('POST /api/guess/check：每日路径——未中不给答案，final=true 揭晓', async () => {
    const answer = answerForDate(new Date(), dailyPool(GUESS_MODELS));
    const other = GUESS_MODELS.find((m) => m.id !== answer.id);
    // 未中、非 final：answer = null
    const r1 = await post('/api/guess/check', { guessId: other.id });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.feedback.guessId, other.id);
    assert.equal(r1.body.feedback.won, false);
    assert.equal(r1.body.answer, null);
    assert.deepEqual(Object.keys(r1.body.feedback.attributes), [...ATTRIBUTE_KEYS]);
    // 未中、final=true：附带公开答案
    const r2 = await post('/api/guess/check', { guessId: other.id, final: true });
    assert.equal(r2.body.answer.id, answer.id);
    assert.deepEqual(Object.keys(r2.body.answer), ['id', 'name', 'vendor', 'released', 'openWeights', 'contextK', 'modalities', 'reasoning', 'priceOut', 'priceTier', 'difficulty']);
    // 猜中：无论 final 都附带答案，feedback 与 judge() 逐位一致
    const r3 = await post('/api/guess/check', { guessId: answer.id });
    assert.equal(r3.body.feedback.won, true);
    assert.deepEqual(r3.body.feedback, judge(answer, answer));
    assert.deepEqual(r3.body.feedback.attributes.modalities, { state: 'hit', arrow: null });
    assert.equal(r3.body.answer.id, answer.id);
    // name 兜底解析（不区分大小写）
    const r4 = await post('/api/guess/check', { guessId: answer.name.toUpperCase() });
    assert.equal(r4.body.feedback.guessId, answer.id);
  });

  test('POST /api/guess/check：unknown-model 400 / game-expired 404', async () => {
    const r1 = await post('/api/guess/check', { guessId: 'no-such-model' });
    assert.equal(r1.status, 400);
    assert.deepEqual(r1.body, { code: 'unknown-model', error: '没有找到这个模型' });
    const r2 = await post('/api/guess/check', { guessId: 'glm-5', gameId: 'deadbeef'.repeat(3) });
    assert.equal(r2.status, 404);
    assert.deepEqual(r2.body, { code: 'game-expired', error: '这局练习已过期，开一把新的吧' });
  });

  test('practice/start → check：练习路径走局内答案', async () => {
    const r1 = await post('/api/guess/practice/start', { difficulty: 1 });
    assert.equal(r1.status, 200);
    assert.match(r1.body.gameId, /^[0-9a-f]{24}$/);
    const r2 = await post('/api/guess/check', { guessId: 'glm-5', gameId: r1.body.gameId, final: true });
    assert.equal(r2.status, 200);
    // 练习池 = difficulty ≤ 1
    assert.equal(r2.body.answer.difficulty, 1);
    const answer = modelById.get(r2.body.answer.id);
    const sameModalities = GUESS_MODELS.find((m) => m.id !== answer.id
      && m.modalities.length === answer.modalities.length
      && m.modalities.every((value) => answer.modalities.includes(value)));
    assert.ok(sameModalities);
    const same = await post('/api/guess/check', { guessId: sameModalities.id, gameId: r1.body.gameId });
    assert.equal(same.body.feedback.won, false);
    assert.deepEqual(same.body.feedback.attributes.modalities, { state: 'hit', arrow: null });
    const correct = await post('/api/guess/check', { guessId: answer.id, gameId: r1.body.gameId });
    assert.equal(correct.body.feedback.won, true);
    assert.deepEqual(correct.body.feedback.attributes.modalities, { state: 'hit', arrow: null });
    // 非法 difficulty 回落简单档
    const r3 = await post('/api/guess/practice/start', { difficulty: 99 });
    assert.equal(r3.status, 200);
    // 地狱档（全库）
    const r4 = await post('/api/guess/practice/start', { difficulty: 4 });
    assert.equal(r4.status, 200);
  });

  test('POST /api/guess/result：204 + 落库字段正确', async () => {
    const todayKey = guessDayKey();
    const answer = answerForDate(new Date(), dailyPool(GUESS_MODELS));
    const r = await post('/api/guess/result', { won: true, attempts: 3 });
    assert.equal(r.status, 204);
    const rows = db.prepare('SELECT * FROM guess_results').all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.match(row.id, /^[0-9a-f]{16}$/);
    assert.equal(row.day_key, todayKey);
    assert.equal(row.difficulty, 0);
    assert.equal(row.answer_id, answer.id);
    assert.equal(row.won, 1);
    assert.equal(row.attempts, 3);
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.user_id, user.id);
    assert.ok(Number.isInteger(row.created_at));
    const repeat = await post('/api/guess/result', { won: false, attempts: 8 });
    assert.equal(repeat.status, 204);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results WHERE day_key = ?').get(todayKey).n, 1);
    assert.equal(db.prepare('SELECT won, attempts FROM guess_results WHERE day_key = ?').get(todayKey).won, 1);
  });

  test('POST /api/guess/result：显式 dayKey 按该日派生 answer_id', async () => {
    const day = '2026-09-20'; // epoch 起第 7 天，合法历史日
    const expected = answerForDate(new Date(`${day}T00:00:00+08:00`), dailyPool(GUESS_MODELS));
    const r = await post('/api/guess/result', { won: false, attempts: 8, dayKey: day });
    assert.equal(r.status, 204);
    const row = db.prepare('SELECT * FROM guess_results WHERE day_key = ?').get(day);
    assert.equal(row.answer_id, expected.id);
    assert.equal(row.won, 0);
    assert.equal(row.attempts, 8);
  });

  test('POST /api/guess/result：非法输入 400', async () => {
    for (const attempts of [0, 9, 1.5, 'x']) {
      const r = await post('/api/guess/result', { won: true, attempts });
      assert.equal(r.status, 400, `attempts=${attempts}`);
      assert.equal(r.body.error, '步数无效');
    }
    const before = db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n;
    for (const dayKey of ['2026-11-31', '2026-09-12', '2999-01-01', 'not-a-date', '2026-9-13']) {
      const r = await post('/api/guess/result', { won: true, attempts: 1, dayKey });
      assert.equal(r.status, 400, `dayKey=${dayKey}`);
      assert.equal(r.body.error, '日期无效');
    }
    // 明天（未来日）也拒
    const tomorrow = guessDayKey(new Date(Date.now() + 86400000));
    const r = await post('/api/guess/result', { won: true, attempts: 1, dayKey: tomorrow });
    assert.equal(r.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n, before);
  });

  test('POST /api/guess/result：每 IP 超过一分钟额度返回 429', async () => {
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const result = await post('/api/guess/result', { won: true, attempts: 1 });
      if (result.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  });
});
