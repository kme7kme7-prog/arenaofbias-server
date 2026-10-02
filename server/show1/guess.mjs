// Show1「模一把」兼容端点 —— 与旧 Express 服务端（Show1 server/index.js）同路径、
// 同形状、同判定口径。判定核心在 ./guess-logic.mjs（从 lib/guess-logic.ts 移植）。
// 差异说明：
//   - 不加载 data/guess-models-extra.json（新部署无增量模型文件，数据集冻结）；
//   - 204 响应直接写 ctx.res（handleSite 对返回值统一 sendJson 200，无 204 通路：
//     写完后再 sendJson 会抛 headers-sent，被 handleSite 的 catch 静默吞掉，
//     响应已完整送达，代价只是该连接的 keep-alive 被 destroy 收掉）。
// guess_results 表由独立迁移创建（v8，见 DESIGN.md），这里假定已存在。
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { fail, readJson, rateLimit } from '../http.mjs';
import {
  ATTRIBUTE_KEYS,
  GUESS_DIFFICULTIES,
  GUESS_EPOCH,
  GUESS_MODELS,
  answerForDate,
  dailyPool,
  dayNumber,
  guessDayKey,
  judge,
  modelById,
  poolForDifficulty,
  resolveGuess,
} from './guess-logic.mjs';

// 公开字段白名单（答案本身就是公开模型，但保持显式白名单，未来数据集加
// 私密字段不会意外泄漏）——字段与旧服务端 publicGuessModel 完全一致。
const publicGuessModel = (m) => ({
  id: m.id,
  name: m.name,
  vendor: m.vendor,
  released: m.released,
  openWeights: m.openWeights,
  contextK: m.contextK,
  modalities: m.modalities,
  reasoning: m.reasoning,
  priceOut: m.priceOut,
  priceTier: m.priceTier,
  difficulty: m.difficulty,
});

export function registerShow1Guess(router, { db, limit }) {
  // 旧服务端对 check/practice/result 用高频 guess 组限流；映射到共享后端用
  // matches 组（60/分）兜底 write 组。limit.guess 若日后配置则优先。
  const limiter = limit?.guess ?? limit?.matches ?? limit?.write ?? (() => {});
  const throttle = (ctx) => limiter(ctx.user?.id ?? ctx.ip);
  const resultLimit = rateLimit(60_000, 20);

  // 练习局全在内存：重启即失效（前端收到 game-expired 会开新局），不落库。
  const practiceGames = new Map(); // gameId → { answer, createdAt }
  const PRACTICE_MAX_GAMES = 5000;
  const PRACTICE_TTL = 3 * 3600e3;
  const cleanupPractice = (now) => {
    // Map entries stay in creation order; stop at the first live game.
    for (const [id, game] of practiceGames) {
      if (game.createdAt + PRACTICE_TTL > now) break;
      practiceGames.delete(id);
    }
  };

  const insertResult = db.prepare(
    `INSERT INTO guess_results (id, day_key, difficulty, answer_id, won, attempts, ip_hash, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const daySalt = db.prepare('SELECT salt FROM guess_day_salts WHERE day_key = ?');
  const createDaySalt = db.prepare('INSERT OR IGNORE INTO guess_day_salts (day_key, salt) VALUES (?, ?)');
  const firstResult = db.prepare('SELECT 1 FROM guess_results WHERE superseded = 0 AND day_key = ? AND (ip_hash = ? OR user_id = ?) LIMIT 1');

  // GET /api/guess/today → 数据集（无答案）+ 今天的日子编号。匿名可读。
  router.on('GET', '/api/guess/today', () => ({
    dayKey: guessDayKey(),
    dayNumber: dayNumber(),
    attributes: ATTRIBUTE_KEYS,
    models: GUESS_MODELS.map(publicGuessModel),
  }));

  // POST /api/guess/check — body { guessId, gameId?, final? }。无需登录：
  // 对局全在前端本地，接口只做纯判定（答案不在请求里，无法伪造）。
  router.on('POST', '/api/guess/check', async (ctx) => {
    throttle(ctx);
    const body = await readJson(ctx.req);
    const guessId = typeof body?.guessId === 'string' ? body.guessId : '';
    const final = body?.final === true;
    const guess = modelById.get(guessId) ?? resolveGuess(guessId);
    if (!guess) fail(400, '没有找到这个模型', 'unknown-model');
    // 带 gameId = 练习模式（答案在内存局表）；不带 = 每日一题（每日池派生）
    const gameId = typeof body?.gameId === 'string' ? body.gameId : null;
    let answer;
    if (gameId) {
      cleanupPractice(Date.now());
      const game = practiceGames.get(gameId);
      if (!game) fail(404, '这局练习已过期，开一把新的吧', 'game-expired');
      answer = game.answer;
    } else {
      answer = answerForDate(new Date(), dailyPool(GUESS_MODELS));
    }
    const feedback = judge(guess, answer);
    // 猜中或最后一次：随反馈附带答案（前端揭晓用）；否则不给，防试探
    return { feedback, answer: feedback.won || final ? publicGuessModel(answer) : null };
  });

  // POST /api/guess/practice/start — body { difficulty }。四档随机出题，
  // 合并组算一槽、组内再随机一个版本（练习局用真随机，不需要可复现派生）。
  router.on('POST', '/api/guess/practice/start', async (ctx) => {
    throttle(ctx);
    const body = await readJson(ctx.req);
    const n = Number(body?.difficulty);
    const difficulty = GUESS_DIFFICULTIES.includes(n) ? n : 1;
    const pool = poolForDifficulty(GUESS_MODELS, difficulty);
    if (!pool.length) fail(503, '这一档还没有收录模型，先玩别的难度吧');
    const slots = new Map();
    for (const m of pool) {
      const key = m.groupId ?? m.id;
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(m);
    }
    const groups = [...slots.values()];
    const slot = groups[randomInt(groups.length)];
    const answer = slot[randomInt(slot.length)];
    const now = Date.now();
    cleanupPractice(now);
    // 容量兜底：超上限时从最老的开始清（Map 迭代即插入序）
    if (practiceGames.size >= PRACTICE_MAX_GAMES) {
      const excess = practiceGames.size - PRACTICE_MAX_GAMES + 1;
      let i = 0;
      for (const key of practiceGames.keys()) {
        practiceGames.delete(key);
        if (++i >= excess) break;
      }
    }
    const gameId = randomBytes(12).toString('hex');
    practiceGames.set(gameId, { answer, createdAt: now });
    return { gameId };
  });

  // POST /api/guess/result — body { won, attempts(1–8), dayKey? }。无需登录；
  // answer_id 由服务端按 dayKey 从每日池重新派生，伪造不了答案归属。
  // difficulty 记 0（每日一题）；练习模式不上报。→ 204。
  router.on('POST', '/api/guess/result', async (ctx) => {
    throttle(ctx);
    resultLimit(ctx.ip || 'unknown');
    const body = await readJson(ctx.req);
    const won = body?.won === true;
    const attempts = Number(body?.attempts);
    const reportDay = typeof body?.dayKey === 'string' ? body.dayKey : guessDayKey();
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8)
      fail(400, '步数无效');
    // 只收 epoch 起到今天的 UTC+8 日历日；'YYYY-MM-DD' 字典序即日期序。
    // 往返核对挡幽灵日期（'2026-11-31' 会被 V8 进位成 12-01）
    const reportDate = new Date(`${reportDay}T00:00:00+08:00`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(reportDay) ||
      Number.isNaN(reportDate.getTime()) ||
      guessDayKey(reportDate) !== reportDay ||
      reportDay < GUESS_EPOCH ||
      reportDay > guessDayKey()
    )
      fail(400, '日期无效');
    const answer = answerForDate(reportDate, dailyPool(GUESS_MODELS));
    const now = Date.now();
    createDaySalt.run(reportDay, randomBytes(16).toString('hex'));
    const ipHash = createHash('sha256').update(`${daySalt.get(reportDay).salt}:${ctx.ip || 'unknown'}`).digest('hex');
    if (!firstResult.get(reportDay, ipHash, ctx.user?.id ?? null)) {
      insertResult.run(randomBytes(8).toString('hex'), reportDay, 0, answer.id,
        won ? 1 : 0, attempts, ipHash, ctx.user?.id ?? null, now);
    }
    ctx.res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end();
    return undefined;
  });
}
