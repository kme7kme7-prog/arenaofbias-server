// 「模一把」（Show1 决策 057）判定核心 —— 从 Show1 lib/guess-logic.ts 逐行移植为
// 无依赖 plain ESM。判定口径必须与旧服务端逐位一致（每日答案可复现），所以这里
// 不做任何「顺手优化」：散列常量、槽位分组、near 阈值全部照抄。
// 与旧版的差异只有两点（见 fusion/show1-adapter/DESIGN.md）：
//   1. 数据文件从 TS 的 json import 改为 readFileSync + JSON.parse（仓库惯例）；
//   2. 不移植 registerExtraModels（后台增量模型机制）——新部署没有
//      data/guess-models-extra.json，数据集冻结在这份快照上。
import { readFileSync } from 'node:fs';

const rawData = JSON.parse(
  readFileSync(new URL('./guess-models.json', import.meta.url), 'utf8'),
);

/** 四档难度（层叠：难度 k 的池 = difficulty ≤ k 的全部模型） */
export const GUESS_DIFFICULTIES = [1, 2, 3, 4];

/** 某难度的候选池（层叠：difficulty ≤ k，保持数据集原序即热度降序） */
export function poolForDifficulty(models, difficulty) {
  return models.filter((m) => m.difficulty <= difficulty);
}

/** 每日一题的答案池：普通池上限 = 2（困难与地狱不进每日） */
export const DAILY_DIFFICULTIES = [1, 2];
export function dailyPool(models) {
  return models.filter((m) => m.difficulty <= 2);
}

// ── 数据集适配层 ──
// 数据集按 popularity 降序；每日答案按下标取模派生，更新数据集时新模型必须
// 追加在数组末尾（本仓库快照已冻结，不再追加）。

/** 价格档边界：priceOut < 0.5 → 0 档；< 2 → 1；< 8 → 2；< 25 → 3；≥ 25 → 4 */
export const PRICE_BAND_EDGES = [0.5, 2, 8, 25];

/** 厂商 → 国家/地区（厂商格「同国家给黄」；新增厂商必须补行，'??' 只兜底） */
export const VENDOR_REGION = {
  // 中国
  DeepSeek: 'CN',
  'Moonshot AI': 'CN',
  'Zhipu AI (Z.ai)': 'CN',
  MiniMax: 'CN',
  Alibaba: 'CN',
  Xiaomi: 'CN',
  StepFun: 'CN',
  Tencent: 'CN',
  Baidu: 'CN',
  ByteDance: 'CN',
  '01.AI': 'CN',
  inclusionAI: 'CN',
  Meituan: 'CN',
  // 美国
  OpenAI: 'US',
  Anthropic: 'US',
  Google: 'US',
  Meta: 'US',
  xAI: 'US',
  Microsoft: 'US',
  'Thinking Machines': 'US',
  LMSYS: 'US',
  Stanford: 'US',
  NVIDIA: 'US',
  Poolside: 'US',
  Amazon: 'US',
  Inception: 'US',
  'Aion Labs': 'US',
  Sao10K: 'US',
  IBM: 'US',
  // 法国
  Mistral: 'FR',
  // 韩国
  Upstage: 'KR',
};

function priceBandOf(priceOut) {
  if (priceOut === null || !Number.isFinite(priceOut)) return null;
  for (let i = 0; i < PRICE_BAND_EDGES.length; i++)
    if (priceOut < PRICE_BAND_EDGES[i]) return i;
  return PRICE_BAND_EDGES.length;
}

function toModel(entry, group) {
  return {
    id: entry.id,
    name: entry.name,
    vendor: entry.org,
    region: VENDOR_REGION[entry.org] ?? '??',
    released: `${entry.year}-${String(entry.month).padStart(2, '0')}`,
    openWeights: entry.openWeights,
    contextK: entry.contextK,
    modalities: entry.modality.split('+'),
    reasoning: entry.reasoning,
    priceOut: entry.priceOut,
    priceTier: priceBandOf(entry.priceOut),
    popularity: entry.popularity,
    // 组内变体不带 difficulty，继承组的分池归属（分池以组为单位）
    difficulty: entry.difficulty ?? group?.difficulty,
    sinceDay: entry.sinceDay ?? group?.sinceDay,
    groupId: group?.id,
  };
}

// 合并组（决策 061）：带 variants 的条目展开为「组内每个小版本一个可猜模型」，
// 组条目本身不可猜也不可当答案——答案抽中组后再实例化为某个版本（answerForDate）
function normalizeEntry(entry) {
  if (!entry.variants?.length) return [toModel(entry)];
  return entry.variants.map((v) => toModel(v, entry));
}

export const GUESS_MODELS = rawData.models.flatMap(normalizeEntry);
export const modelById = new Map(GUESS_MODELS.map((m) => [m.id, m]));

/** 属性 key。顺序即反馈格渲染顺序，改顺序=改玩法 */
export const ATTRIBUTE_KEYS = [
  'vendor',
  'released',
  'openWeights',
  'contextK',
  'modalities',
  'reasoning',
  'priceTier',
];

// ── 手感参数：黄阈值是「接近但不中」的张力来源 ──
export const GUESS_CONFIG = {
  /** 发布时间差多少个月内算 near（黄）。0 = 不给黄，只给箭头 */
  releasedNearMonths: 6,
  /** 上下文窗口比值在多少倍以内算 near（黄）。1 = 不给黄 */
  contextNearRatio: 2,
};

/** 找不到该模型时抛给上层转 400 的语义错误 */
export class GuessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'unknown-model' | 'invalid-date'
  }
}

// ── 属性归一 ──

function monthIndex(released) {
  const match = /^(\d{4})-(\d{2})$/.exec(released);
  if (!match) throw new GuessError('invalid-date', `bad released: ${released}`);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/** 玩家输入 → 模型（name 不区分大小写匹配；null = 没猜到） */
export function resolveGuess(name) {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return GUESS_MODELS.find((m) => m.name.toLowerCase() === key) ?? null;
}

function judgeNumeric(guessValue, answerValue, nearThreshold, mode) {
  // 未公开：只标 unknown，不给箭头
  if (guessValue === null || answerValue === null)
    return { state: 'unknown', arrow: null };
  if (guessValue === answerValue) return { state: 'hit', arrow: null };
  const arrow = answerValue > guessValue ? 'up' : 'down';
  // 「接近」由 mode 决定口径：diff=绝对差 ≤ 阈值；ratio=倍数 ≤ 阈值。
  const near =
    mode === 'ratio'
      ? Math.max(guessValue, answerValue) / Math.min(guessValue, answerValue) <=
        nearThreshold
      : Math.abs(guessValue - answerValue) <= nearThreshold;
  return { state: near ? 'near' : 'miss', arrow };
}

/** 判定一次猜测（核心函数，与旧服务端同口径） */
export function judge(guess, answer) {
  const attributes = {};

  // 厂商：同厂商=绿；不同厂商但同国家/地区=黄；跨国=灰。无箭头
  attributes.vendor =
    guess.vendor === answer.vendor
      ? { state: 'hit', arrow: null }
      : guess.region === answer.region
        ? { state: 'near', arrow: null }
        : { state: 'miss', arrow: null };

  // 发布时间：月序号比较；near 阈值按月（绝对差口径）
  attributes.released = judgeNumeric(
    monthIndex(guess.released),
    monthIndex(answer.released),
    GUESS_CONFIG.releasedNearMonths,
    'diff',
  );

  // 开放权重：二值
  attributes.openWeights =
    guess.openWeights === answer.openWeights
      ? { state: 'hit', arrow: null }
      : { state: 'miss', arrow: null };

  // 上下文窗口：比值接近（ratio 口径）
  attributes.contextK = judgeNumeric(
    guess.contextK,
    answer.contextK,
    GUESS_CONFIG.contextNearRatio,
    'ratio',
  );

  // 模态（2026-09-29）：完整集合相同=绿，与模型身份及排列顺序无关。
  // 集合不同仍沿用同多模态=黄、一纯一多=灰的反馈。
  const guessModalities = new Set(guess.modalities);
  const answerModalities = new Set(answer.modalities);
  const sameModalities = guessModalities.size === answerModalities.size
    && [...guessModalities].every((m) => answerModalities.has(m));
  const guessMulti = guess.modalities.some((m) => m !== 'text');
  const answerMulti = answer.modalities.some((m) => m !== 'text');
  attributes.modalities =
    sameModalities
      ? { state: 'hit', arrow: null }
      : { state: guessMulti === answerMulti ? 'near' : 'miss', arrow: null };

  // 推理模型：二值
  attributes.reasoning =
    guess.reasoning === answer.reasoning
      ? { state: 'hit', arrow: null }
      : { state: 'miss', arrow: null };

  // 价格档：档位序数比较（0-4）。相邻档（差 1）给黄、差 ≥2 给灰 + 箭头；
  // 不走 judgeNumeric——比值口径会让低档位区间的黄灯整体失效
  if (guess.priceTier === null || answer.priceTier === null) {
    attributes.priceTier = { state: 'unknown', arrow: null };
  } else if (guess.priceTier === answer.priceTier) {
    attributes.priceTier = { state: 'hit', arrow: null };
  } else {
    attributes.priceTier = {
      state:
        Math.abs(guess.priceTier - answer.priceTier) === 1 ? 'near' : 'miss',
      arrow: answer.priceTier > guess.priceTier ? 'up' : 'down',
    };
  }

  return {
    guessId: guess.id,
    attributes,
    won: guess.id === answer.id,
  };
}

// ── 每日一题派生 ──
// 槽分「基础 / 追加」两类：基础槽 = 主数据集（槽序冻结）；追加槽 = 后台增量
// 条目，带 sinceDay，只从该日起参与当日取模。某日的模数 = 基础槽数 + 当日
// 已生效的追加槽数。（本仓库无增量条目，extraSlots 恒空，逻辑保留以保口径一致。）

/** 数据集冻结锚点：模一把上线日（决策 057）。改它=重排所有历史答案 */
export const GUESS_EPOCH = '2026-09-13';

/** UTC+8 日历日（模一把的「一天」按东八区切） */
export function guessDayKey(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 距 epoch 的天数（epoch=0）。用 Date.UTC 真历法差 */
export function dayNumber(date = new Date()) {
  const key = guessDayKey(date);
  const ms = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
  const epochMs = Date.UTC(
    Number(GUESS_EPOCH.slice(0, 4)),
    Number(GUESS_EPOCH.slice(5, 7)) - 1,
    Number(GUESS_EPOCH.slice(8, 10)),
  );
  return Math.round((ms - epochMs) / 86400000);
}

/**
 * 每日答案：确定性派生，无随机源。
 * 第一层散列（day 乘素数折叠）选答案槽（合并组 groupId??id 去重，基础槽与
 * 追加槽分流）；第二层在组内按「该槽第几次被抽中」轮转实例化版本。
 */
export function answerForDate(date = new Date(), pool = GUESS_MODELS) {
  // 负序号（上线前的日期）clamp 到 0
  const n = Math.max(0, dayNumber(date));
  const slots = new Map();
  for (const m of pool) {
    const key = m.groupId ?? m.id;
    const slot = slots.get(key);
    if (slot) slot.push(m);
    else slots.set(key, [m]);
  }
  const baseSlots = [];
  const extraSlots = [];
  for (const slot of slots.values())
    (slot[0].sinceDay === undefined ? baseSlots : extraSlots).push(slot);
  const select = (d) => {
    const h = (d * 2654435761) % 0xffffffff;
    const eligible = extraSlots.filter((s) => (s[0].sinceDay ?? 0) <= d);
    const r = h % (baseSlots.length + eligible.length);
    return r < baseSlots.length ? baseSlots[r] : eligible[r - baseSlots.length];
  };
  const slot = select(n);
  if (slot.length === 1) return slot[0];
  // 第二层：第 hitCount 次命中该槽取第 hitCount 个版本（轮转）
  let hits = 0;
  for (let d = 0; d < n; d++) if (select(d) === slot) hits++;
  return slot[hits % slot.length];
}
