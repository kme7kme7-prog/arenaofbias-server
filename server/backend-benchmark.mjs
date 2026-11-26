// AGB-Bench v4.1 closed-book backend benchmark questions and leaderboard data.
import { fail } from './http.mjs';

export const BACKEND_CATEGORY = '后端';

export const BACKEND_TIERS = Object.freeze([
  Object.freeze({
    id: 'agb-v41-ez',
    tier: 'EZ',
    name: '基础维护卷',
    title: 'AGB-Bench v4.1 · EZ 基础维护卷',
    weight: 1,
    weightLabel: '×1',
    languages: ['Python'],
    languageLabel: 'Python',
    defaultSolveStatus: 'solved',
    statusLabel: '头部基本解决',
    summary: '常规协议状态与存量代码局部修复 · 闭卷自动化判分（合成总榜权重 ×1）',
    capability: '常规协议状态与存量代码局部修复',
  }),
  Object.freeze({
    id: 'agb-v41-hd',
    tier: 'HD',
    name: '底层系统卷',
    title: 'AGB-Bench v4.1 · HD 底层系统卷',
    weight: 2,
    weightLabel: '×2',
    languages: ['Go', 'C'],
    languageLabel: 'Go + C',
    defaultSolveStatus: 'solved',
    statusLabel: '头部基本解决',
    summary: '并发状态协同与底层核心引擎维护 · 闭卷自动化判分（合成总榜权重 ×2）',
    capability: '并发状态协同与底层核心引擎维护',
  }),
  Object.freeze({
    id: 'agb-v41-in',
    tier: 'IN',
    name: '高耦合排障卷',
    title: 'AGB-Bench v4.1 · IN 高耦合排障卷',
    weight: 1,
    weightLabel: '×1',
    languages: ['Python'],
    languageLabel: 'Python',
    defaultSolveStatus: 'solving',
    statusLabel: '深水区分化',
    summary: '复杂模块多故障定位与连锁回归控制 · 闭卷自动化判分（合成总榜权重 ×1）',
    capability: '复杂模块多故障定位与连锁回归控制',
  }),
  Object.freeze({
    id: 'agb-v41-at',
    tier: 'AT',
    name: '架构演进卷',
    title: 'AGB-Bench v4.1 · AT 架构演进卷',
    weight: 2,
    weightLabel: '×2',
    languages: ['Python'],
    languageLabel: 'Python',
    defaultSolveStatus: 'solved',
    statusLabel: '头部基本解决',
    summary: '跨模块系统级设计与大规模重构扩展 · 闭卷自动化判分（合成总榜权重 ×2）',
    capability: '跨模块系统级设计与大规模重构扩展',
  }),
]);

export const BACKEND_TASK_IDS = new Set(BACKEND_TIERS.map((item) => item.id));

const TIER_MAP = new Map(BACKEND_TIERS.map((item) => [item.tier, item]));
const WEIGHTS = Object.freeze({ EZ: 1, HD: 2, IN: 1, AT: 2 });

const RAW_ENTRIES = [
  {
    name: 'Claude Opus 5.6 灰测',
    vendor: 'Anthropic',
    effort: 'XHigh',
    harness: 'ClaudeCode',
    ez: 100.0, ezTokM: 9.79, ezBrs: 100.0, ezNote: '',
    hd: 100.0, hdTokM: 65.79, hdBrs: 100.0, hdNote: '',
    in: 59.67, inTokM: 66.54, inBrs: 97.5, inNote: '',
    at: 98.29, atTokM: 18.32, atBrs: 100.0, atNote: '',
    total600: 556.25,
    totalTokensM: 160.44,
    status: 'unreliable',
    badge: '灰测环境',
  },
  {
    name: 'Gemini 4 Neon',
    vendor: 'Google',
    effort: 'High',
    harness: 'AGY',
    ez: 85.58, ezTokM: 6.04, ezBrs: 100.0, ezNote: '',
    hd: 100.0, hdTokM: 41.61, hdBrs: 100.0, hdNote: 'diff0.93x',
    in: 54.29, inTokM: 64.87, inBrs: 97.1, inNote: '',
    at: 95.06, atTokM: 9.01, atBrs: 100.0, atNote: '',
    total600: 529.99,
    totalTokensM: 121.53,
    status: 'focus1',
    badge: '焦点',
  },
  {
    name: 'GPT-6.2 Astra',
    vendor: 'OpenAI',
    effort: 'Max',
    harness: 'Codex',
    ez: 90.23, ezTokM: 6.43, ezBrs: 100.0, ezNote: '',
    hd: 91.62, hdTokM: 20.37, hdBrs: 100.0, hdNote: '',
    in: 52.82, inTokM: 10.65, inBrs: 97.1, inNote: '',
    at: 98.29, atTokM: 6.21, atBrs: 100.0, atNote: '',
    total600: 522.87,
    totalTokensM: 43.66,
    status: 'focus1',
    badge: '焦点',
  },
  {
    name: 'Claude Opus 5.5',
    vendor: 'Anthropic',
    effort: 'XHigh',
    harness: 'ClaudeCode',
    ez: 99.89, ezTokM: 13.8, ezBrs: 100.0, ezNote: '',
    hd: 88.75, hdTokM: 29.95, hdBrs: 100.0, hdNote: '',
    in: 45.65, inTokM: 11.42, inBrs: 96.4, inNote: '',
    at: 98.29, atTokM: 28.71, atBrs: 100.0, atNote: '',
    total600: 519.62,
    totalTokensM: 83.88,
    status: 'normal',
    badge: '',
  },
  {
    name: 'GPT-6.2 Sol',
    vendor: 'OpenAI',
    effort: 'Max',
    harness: 'Codex',
    ez: 87.91, ezTokM: 10.75, ezBrs: 100.0, ezNote: '',
    hd: 91.74, hdTokM: 10.87, hdBrs: 100.0, hdNote: '',
    in: 49.26, inTokM: 12.18, inBrs: 99.3, inNote: '',
    at: 98.29, atTokM: 6.42, atBrs: 100.0, atNote: '',
    total600: 517.23,
    totalTokensM: 40.23,
    status: 'normal',
    badge: '',
  },
  {
    name: 'Gemini 4 Carbon',
    vendor: 'Google',
    effort: 'High',
    harness: 'AGY',
    ez: 85.12, ezTokM: 12.43, ezBrs: 100.0, ezNote: '',
    hd: 91.76, hdTokM: 62.77, hdBrs: 100.0, hdNote: '',
    in: 52.52, inTokM: 48.32, inBrs: 95.3, inNote: '',
    at: 96.9, atTokM: 13.01, atBrs: 100.0, atNote: '',
    total600: 514.96,
    totalTokensM: 136.53,
    status: 'normal',
    badge: '',
  },
  {
    name: 'GPT-6.2 Astra',
    vendor: 'OpenAI',
    effort: 'XHigh',
    harness: 'Codex',
    ez: 90.4, ezTokM: 8.53, ezBrs: 100.0, ezNote: '',
    hd: 98.48, hdTokM: 12.58, hdBrs: 100.0, hdNote: '',
    in: 50.25, inTokM: 8.38, inBrs: 97.1, inNote: '',
    at: 81.7, atTokM: 4.57, atBrs: 100.0, atNote: '',
    total600: 501.01,
    totalTokensM: 34.06,
    status: 'normal',
    badge: '',
  },
  {
    name: 'Gemini 4 Hydrogen',
    vendor: 'Google',
    effort: 'XHigh',
    harness: 'AGY',
    ez: 78.53, ezTokM: 16.4, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 75.58, hdTokM: 53.46, hdBrs: 100.0, hdNote: '',
    in: 50.88, inTokM: 50.7, inBrs: 96.4, inNote: '',
    at: 96.9, atTokM: 28.11, atBrs: 100.0, atNote: '',
    total600: 474.37,
    totalTokensM: 148.66,
    status: 'normal',
    badge: '',
  },
  {
    name: 'GPT-6.1 Terra',
    vendor: 'OpenAI',
    effort: 'Max',
    harness: 'Codex',
    ez: 90.03, ezTokM: 14.55, ezBrs: 100.0, ezNote: '',
    hd: 86.32, hdTokM: 13.07, hdBrs: 93.4, hdNote: '',
    in: 47.06, inTokM: 24.78, inBrs: 96.1, inNote: '',
    at: 80.32, atTokM: 6.6, atBrs: 100.0, atNote: '',
    total600: 470.37,
    totalTokensM: 59.0,
    status: 'normal',
    badge: '',
  },
  {
    name: 'GLM 5.4',
    vendor: 'Z.ai',
    effort: 'Max',
    harness: 'ZCode',
    ez: 92.54, ezTokM: 178.2, ezBrs: 100.0, ezNote: '8h',
    hd: 61.48, hdTokM: 181.64, hdBrs: 100.0, hdNote: '4.5h',
    in: 51.12, inTokM: 213.79, inBrs: 98.9, inNote: '3.5h',
    at: 72.33, atTokM: 171.32, atBrs: 100.0, atNote: '7.8h',
    total600: 411.28,
    totalTokensM: 744.95,
    hours: [8.0, 4.5, 3.5, 7.8],
    status: 'focus3',
    badge: '23.8h',
  },
  {
    name: 'Grok 4.7',
    vendor: 'xAI',
    effort: 'XHigh',
    harness: 'Cursor',
    ez: 79.06, ezTokM: 10.71, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 61.56, hdTokM: 29.13, hdBrs: 85.2, hdNote: '',
    in: 47.23, inTokM: 66.78, inBrs: 94.3, inNote: '',
    at: 44.37, atTokM: 17.17, atBrs: 100.0, atNote: '',
    total600: 338.15,
    totalTokensM: 123.78,
    status: 'normal',
    badge: '',
  },
  {
    name: 'DeepSeek V4.1 Flash 1017',
    vendor: 'DeepSeek',
    effort: 'Max',
    harness: 'ZCode',
    ez: 57.58, ezTokM: 37.05, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 57.39, hdTokM: 169.12, hdBrs: 100.0, hdNote: '',
    in: 49.08, inTokM: 201.35, inBrs: 96.8, inNote: '',
    at: 50.12, atTokM: 59.08, atBrs: 100.0, atNote: '',
    total600: 321.68,
    totalTokensM: 466.61,
    status: 'focus2',
    badge: '焦点',
  },
  {
    name: 'GLM 5.3',
    vendor: 'Z.ai',
    effort: 'Max',
    harness: 'ZCode',
    ez: 45.22, ezTokM: 80.56, ezBrs: 30.4, ezNote: '超时熔断',
    hd: 56.23, hdTokM: 80.68, hdBrs: 100.0, hdNote: '',
    in: 43.76, inTokM: 120.77, inBrs: 93.2, inNote: '',
    at: 49.67, atTokM: 46.93, atBrs: 100.0, atNote: '1.2h',
    total600: 300.78,
    totalTokensM: 328.94,
    status: 'focus2',
    badge: '焦点',
  },
  {
    name: 'MiniMax M3.1 Flash',
    vendor: 'MiniMax',
    effort: 'XHigh',
    harness: 'MiniMaxCode',
    ez: 63.5, ezTokM: 92.0, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 57.62, hdTokM: 41.0, hdBrs: 100.0, hdNote: '',
    in: 44.31, inTokM: 180.0, inBrs: 91.4, inNote: '',
    at: 28.29, atTokM: 34.0, atBrs: 100.0, atNote: '',
    total600: 279.63,
    totalTokensM: 347.0,
    status: 'normal',
    badge: '',
  },
  {
    name: 'LongCat 2.5',
    vendor: 'Meituan',
    effort: 'Max',
    harness: 'MiniMaxCode',
    ez: 58.96, ezTokM: 53.27, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 53.73, hdTokM: 36.38, hdBrs: 100.0, hdNote: '',
    in: 44.02, inTokM: 48.77, inBrs: 95.0, inNote: '',
    at: 20.95, atTokM: 18.3, atBrs: 100.0, atNote: '',
    total600: 252.34,
    totalTokensM: 156.72,
    status: 'normal',
    badge: '',
  },
  {
    name: 'Hy4 V3转算',
    vendor: 'Tencent',
    effort: 'High',
    harness: 'Workbuddy',
    ez: 58.69, ezTokM: null, ezBrs: 100.0, ezNote: '超时熔断',
    hd: 53.73, hdTokM: null, hdBrs: 100.0, hdNote: '',
    in: 17.57, inTokM: null, inBrs: 45.9, inNote: '',
    at: 26.08, atTokM: null, atBrs: 100.0, atNote: '',
    total600: 235.88,
    totalTokensM: null,
    status: 'unreliable',
    badge: 'V3旧版转算',
  },
  {
    name: 'MiniMax M3.1 Flash',
    vendor: 'MiniMax',
    effort: 'Max',
    harness: 'MiniMaxCode',
    ez: 64.76, ezTokM: 130.14, ezBrs: 78.3, ezNote: '超时熔断',
    hd: 48.73, hdTokM: 66.57, hdBrs: 100.0, hdNote: '',
    in: 37.41, inTokM: 219.18, inBrs: 88.5, inNote: '',
    at: 17.63, atTokM: 35.14, atBrs: 100.0, atNote: '',
    total600: 234.89,
    totalTokensM: 451.02,
    status: 'normal',
    badge: '',
  },
  {
    name: 'Kimi K3.1 Pro V3转算',
    vendor: 'Moonshot AI',
    effort: 'Max',
    harness: 'KimiCode',
    ez: 69.04, ezTokM: null, ezBrs: 100.0, ezNote: '',
    hd: 28.56, hdTokM: null, hdBrs: 93.4, hdNote: '',
    in: 8.63, inTokM: null, inBrs: 21.2, inNote: '',
    at: 29.02, atTokM: null, atBrs: 100.0, atNote: '',
    total600: 192.83,
    totalTokensM: null,
    status: 'unreliable',
    badge: 'V3旧版转算',
  },
  {
    name: 'Qwen3.8 Flash',
    vendor: 'Alibaba',
    effort: 'XHigh',
    harness: 'ZCode',
    ez: 68.2, ezTokM: 138.48, ezBrs: 100.0, ezNote: '超时熔断',
    hd: null, hdTokM: null, hdBrs: null, hdNote: '未完赛',
    in: 47.84, inTokM: 297.32, inBrs: 93.5, inNote: '',
    at: 59.98, atTokM: 64.62, atBrs: 100.0, atNote: '',
    total600: 236.0,
    totalTokensM: 500.41,
    status: 'partial',
    badge: '缺HD卷',
  },
  {
    name: 'GLM 5.4',
    vendor: 'Z.ai',
    effort: 'Low',
    harness: 'ZCode',
    ez: null, ezTokM: null, ezBrs: null, ezNote: '',
    hd: null, hdTokM: null, hdBrs: null, hdNote: '',
    in: null, inTokM: null, inBrs: null, inNote: '',
    at: 45.44, atTokM: 86.87, atBrs: 100.0, atNote: '2.5h',
    total600: 90.88,
    totalTokensM: 86.87,
    status: 'focus3',
    badge: '仅测AT',
  },
];

const isComplete = (entry) =>
  typeof entry.ez === 'number'
  && typeof entry.hd === 'number'
  && typeof entry.in === 'number'
  && typeof entry.at === 'number';

export const weightedTotal600 = (entry) =>
  Math.round(((entry.ez ?? 0) * 1 + (entry.hd ?? 0) * 2 + (entry.in ?? 0) * 1 + (entry.at ?? 0) * 2) * 100) / 100;

export function verifyBackendBenchmarkData() {
  for (const entry of RAW_ENTRIES) {
    const expected = weightedTotal600(entry);
    if (expected !== entry.total600) {
      throw new Error(`Backend benchmark total mismatch for ${entry.name} (${entry.effort}): expected ${expected}, got ${entry.total600}`);
    }
  }
  return true;
}

verifyBackendBenchmarkData();

function tierRow(entry, tierCode, rank) {
  const key = tierCode.toLowerCase();
  return {
    rank,
    name: entry.name,
    vendor: entry.vendor,
    effort: entry.effort,
    harness: entry.harness,
    tier: tierCode,
    score: entry[key],
    tokensM: entry[`${key}TokM`],
    brs: entry[`${key}Brs`],
    note: entry[`${key}Note`],
    status: entry.status,
    unreliable: entry.status === 'unreliable',
    badge: entry.badge,
    complete: isComplete(entry),
    total600: entry.total600,
    total100: Number((entry.total600 / 6).toFixed(2)),
  };
}

function tierRows(tierCode) {
  const key = tierCode.toLowerCase();
  return RAW_ENTRIES
    .filter((entry) => typeof entry[key] === 'number')
    .slice()
    .sort((a, b) => (
      b[key] - a[key]
      || (b[`${key}Brs`] ?? -1) - (a[`${key}Brs`] ?? -1)
      || (a[`${key}TokM`] ?? Infinity) - (b[`${key}TokM`] ?? Infinity)
      || a.name.localeCompare(b.name, 'en')
    ))
    .map((entry, index) => tierRow(entry, tierCode, index + 1));
}

function overallRow(entry, rank) {
  return {
    rank,
    ...entry,
    unreliable: entry.status === 'unreliable',
    total100: Number((entry.total600 / 6).toFixed(2)),
    complete: isComplete(entry),
  };
}

const OVERALL_ROWS = RAW_ENTRIES
  .filter(isComplete)
  .slice()
  .sort((a, b) => b.total600 - a.total600 || (a.totalTokensM ?? Infinity) - (b.totalTokensM ?? Infinity) || a.name.localeCompare(b.name, 'en'))
  .map((entry, index) => overallRow(entry, index + 1));

const PARTIAL_ROWS = RAW_ENTRIES
  .filter((entry) => !isComplete(entry))
  .map((entry) => overallRow(entry, null));

const TIER_SUMMARIES = BACKEND_TIERS.map((item) => {
  const rows = tierRows(item.tier);
  return {
    code: item.tier,
    questionId: item.id,
    name: item.name,
    title: item.title,
    weight: item.weight,
    weightLabel: item.weightLabel,
    languages: [...item.languages],
    languageLabel: item.languageLabel,
    capability: item.capability,
    statusLabel: item.statusLabel,
    topScore: rows[0]?.score ?? null,
    count: rows.length,
  };
});

export function backendQuestions(solveStatuses = new Map()) {
  return BACKEND_TIERS.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    prompt: '',
    category: BACKEND_CATEGORY,
    domains: ['计算机技术', '工程技术'],
    tags: [BACKEND_CATEGORY, ...item.languages],
    templates: [],
    acceptsUploads: false,
    benchmarkOnly: true,
    languages: [...item.languages],
    languageLabel: item.languageLabel,
    date: '2026-11-26',
    solveStatus: solveStatuses.get(item.id) ?? item.defaultSolveStatus,
    subcategory: '',
    curatedSectionId: null,
    benchmark: {
      suite: 'AGB-Bench v4.1',
      tier: item.tier,
      weight: item.weight,
      weightRatio: '1:2:1:2',
      maxScore: 100,
      languages: [...item.languages],
      languageLabel: item.languageLabel,
      statusLabel: item.statusLabel,
      rows: tierRows(item.tier),
    },
  }));
}

export function backendLeaderboard(tier = null) {
  const raw = tier == null ? '' : String(tier).trim();
  const normalizedTier = raw ? raw.toUpperCase() : null;
  if (normalizedTier && !TIER_MAP.has(normalizedTier)) {
    fail(400, '后端榜单分区无效', 'invalid_query');
  }
  return {
    kind: 'backend-benchmark',
    suite: 'AGB-Bench v4.1',
    version: 'v4.1',
    ratio: '1:2:1:2',
    weights: WEIGHTS,
    maxScore600: 600,
    maxScore100: 100,
    updatedAt: '2026-11-26',
    tier: normalizedTier,
    tiers: TIER_SUMMARIES,
    rows: normalizedTier ? tierRows(normalizedTier) : OVERALL_ROWS,
    partialRows: normalizedTier ? [] : PARTIAL_ROWS,
  };
}
