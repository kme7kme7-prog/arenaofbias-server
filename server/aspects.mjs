import { createHash } from 'node:crypto';
import { fitBradleyTerry, rankRanges } from './ranking.mjs';

// Guided blind voting trial (staff only). Besides the overall question, a trial match may carry
// one aspect question (测评点) from its category's pool. Trial answers are kept in guided_trial_votes,
// which no board reads; only the staff dimension chart (trialStandings) counts them.
// Pilot: 建模 and 静态网页. Aspect IDs are stable; the wording may change.
export const DIMENSIONS = { aesthetic: '审美能力', craft: '工程完备能力', logic: '逻辑能力', diverge: '发散能力' };

export const ASPECTS = {
  建模: [
    { id: 'lighting', dimension: 'aesthetic', question: '哪个的光影更有质感？', keyword: '光影',
      hint: '明暗过渡、阴影和灯光。' },
    { id: 'atmosphere', dimension: 'aesthetic', question: '哪个的氛围/环境更能衬托建模？', keyword: '氛围/环境',
      hint: '背景、地面、天空和配景。' },
    { id: 'material', dimension: 'aesthetic', question: '哪个的材质更让你觉得贴合场景？', keyword: '材质',
      hint: '表面的着色、纹理和反光是否契合作品风格与场景设定（如写实、体素或三渲二）。' },
    { id: 'floating', dimension: 'craft', question: '哪个建模的悬空或断连现象更少？', keyword: '悬空或断连',
      hint: '拖动旋转，看各部件的连接处和贴地的地方。两边都没有就选「都很好」。' },
    { id: 'clipping', dimension: 'craft', question: '哪个建模的穿模现象更少？', keyword: '穿模',
      hint: '拖动旋转、拉近看部件交界处，有没有零件互相插进对方内部或面片重叠闪烁。两边都没有就选「都很好」。' },
    { id: 'fidelity', dimension: 'logic', question: '哪个的造型更贴合题目？', keyword: '造型',
      hint: '对照提示词，看形状、结构和比例。' },
    { id: 'structure', dimension: 'logic', question: '哪个的结构关系更合乎常理？', keyword: '结构关系',
      hint: '看各部件的大小比例、支撑受力和组装位置合不合逻辑，有没有违背常识的错位拼装。' },
    { id: 'extra_idea', dimension: 'diverge', question: '哪个的巧思让你眼前一亮？', keyword: '巧思',
      hint: '题目没要求、但加得恰到好处的细节。' },
  ],
  静态网页: [
    { id: 'palette', dimension: 'aesthetic', question: '哪个的配色看着更舒服、更协调？', keyword: '配色',
      hint: '看主色与点缀色的搭配、背景与文字的明暗对比，以及色系是否贴合主题调性。' },
    { id: 'ornament', dimension: 'aesthetic', question: '哪个的装饰物更恰当、更耐看？', keyword: '装饰物',
      hint: '看图标、插画、边框、底纹或几何点缀，是在给版面加分，还是显得粗糙杂乱。' },
    { id: 'layout', dimension: 'craft', question: '哪个的排版更让你感到满意？', keyword: '排版',
      hint: '看页面布局与留白是否契合主题，以及网页/单页 PPT/海报里有没有意外的文字溢出、遮挡或挤压错位。' },
    { id: 'typography', dimension: 'craft', question: '哪个的字号层级更清晰易读？', keyword: '字号',
      hint: '看主副标题与正文的大小对比、行距宽窄，重点能不能一眼抓到，有没有字太小或怪异断行。' },
    { id: 'page_logic', dimension: 'logic', question: '哪个的内容结构更贴合题目场景？', keyword: '内容结构',
      hint: '对照提示词，看板块划分、信息主次与视觉形式是不是真正匹配网页/PPT/海报的用途，而非生搬硬套。' },
    { id: 'ai_template', dimension: 'diverge', question: '哪个的 AI 味模版感更少？', keyword: 'AI 味模版',
      hint: '看有没有廉价紫蓝渐变、千篇一律的圆角三栏卡片和乱塞的图标徽章。两边都不套路就选「都很好」，都很套路就选「都不好」。' },
  ],
};

// Balance dimensions first, then the available aspects within that dimension.
export function pickAspect(task, answered, random, off = new Set()) {
  const pool = (ASPECTS[task?.category] ?? []).filter(aspect => !off.has(aspect.id));
  if (!pool.length) return null;
  const counts = new Map(answered.map(row => [row.aspect_id, row.n]));
  const n = aspect => counts.get(aspect.id) ?? 0;
  const groups = new Map();
  for (const aspect of pool) {
    if (!groups.has(aspect.dimension)) groups.set(aspect.dimension, []);
    groups.get(aspect.dimension).push(aspect);
  }
  const pick = list => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const sum = list => list.reduce((total, aspect) => total + n(aspect), 0);
  const fewest = Math.min(...[...groups.values()].map(sum));
  const dimension = pick([...groups.values()].filter(list => sum(list) === fewest));
  const least = Math.min(...dimension.map(n));
  return pick(dimension.filter(aspect => n(aspect) === least));
}

export const publicAspect = (aspect) => aspect && {
  id: aspect.id, dimension: aspect.dimension, dimensionName: DIMENSIONS[aspect.dimension],
  question: aspect.question, keyword: aspect.keyword, hint: aspect.hint,
};

const OUTCOMES = { a: ['win', 'loss'], b: ['loss', 'win'], tie: ['tie', 'tie'] };
const tally = () => ({ win: 0, tie: 0, loss: 0, n: 0 });
const add = (cell, outcome) => { cell[outcome]++; cell.n++; };

// Counts behind the trial's dimension chart (staff only). Only pairs that carried an aspect question
// count. Per entry: wins, ties and losses on each dimension and its aspects, and on the overall
// question of the same pairs. A pair whose two works share an entry says nothing and is left out.
// `ballots` are { a, b, choice, aspectId, aspectChoice, userId, createdAt } with parsed identities.
export function trialStandings(ballots, keyOf, describe, { category = null } = {}) {
  const validCategory = category && Object.hasOwn(ASPECTS, category) ? category : null;
  const activeAspects = validCategory ? ASPECTS[validCategory] : Object.values(ASPECTS).flat();
  const activeById = new Map(activeAspects.map((aspect) => [aspect.id, aspect]));
  const entries = new Map(), voters = new Set();
  let pairs = 0, answered = 0, since = null, until = null;
  const entry = (identity, key) => {
    if (!entries.has(key)) entries.set(key, { key, ...describe(identity), overall: tally(),
      dimensions: Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, { ...tally(), aspects: {} }])) });
    return entries.get(key);
  };
  for (const ballot of ballots) {
    const aspect = activeById.get(ballot.aspectId);
    const outcome = OUTCOMES[ballot.choice];
    if (!aspect || !outcome || !ballot.a || !ballot.b) continue;
    const leftKey = keyOf(ballot.a), rightKey = keyOf(ballot.b);
    if (leftKey === rightKey) continue;
    const sides = [entry(ballot.a, leftKey), entry(ballot.b, rightKey)];
    pairs++;
    if (ballot.userId) voters.add(ballot.userId);
    since = since == null ? ballot.createdAt : Math.min(since, ballot.createdAt);
    until = until == null ? ballot.createdAt : Math.max(until, ballot.createdAt);
    sides.forEach((side, i) => add(side.overall, outcome[i]));
    const picked = OUTCOMES[ballot.aspectChoice];
    if (!picked) continue;
    answered++;
    sides.forEach((side, i) => {
      const cell = side.dimensions[aspect.dimension];
      add(cell, picked[i]);
      add(cell.aspects[aspect.id] ??= tally(), picked[i]);
    });
  }
  const answers = (row) => Object.values(row.dimensions).reduce((sum, cell) => sum + cell.n, 0);
  return {
    category: validCategory,
    categories: Object.keys(ASPECTS),
    dimensions: Object.entries(DIMENSIONS).map(([id, name]) => ({ id, name,
      aspects: activeAspects.filter((aspect) => aspect.dimension === id).map(({ id: aspectId, keyword }) => ({ id: aspectId, keyword })) })),
    totals: { pairs, answered, voters: voters.size, since: since == null ? null : new Date(since).toISOString(), until: until == null ? null : new Date(until).toISOString() },
    entries: [...entries.values()].sort((x, y) => answers(y) - answers(x) || y.overall.n - x.overall.n
      || String(x.modelName).localeCompare(String(y.modelName), 'en', { numeric: true }) || String(x.effort).localeCompare(String(y.effort))),
  };
}

// Anchored per-dimension fits; priors is a map of category-board Elo scores.
export function trialScores(ballots, keyOf, describe, priors = new Map(), { category = null, seedKey = '', rankRange = { draws: 2000, level: 0.95 } } = {}) {
  const result = trialStandings(ballots, keyOf, describe, { category });
  const activeAspects = result.category ? ASPECTS[result.category] : Object.values(ASPECTS).flat();
  const activeById = new Map(activeAspects.map((aspect) => [aspect.id, aspect]));
  result.dimensions = result.dimensions.filter(dimension => dimension.aspects.length);
  result.boards = {};
  const entries = result.entries, indexes = new Map(entries.map((row, i) => [row.key, i]));
  const scale = 400 / Math.log(10);
  for (const row of entries) row.prior = priors.get(row.key) ?? null;
  for (const dimension of result.dimensions) {
    const comparisons = [];
    for (const ballot of ballots) {
      if (activeById.get(ballot.aspectId)?.dimension !== dimension.id || !OUTCOMES[ballot.aspectChoice]) continue;
      const a = indexes.get(keyOf(ballot.a)), b = indexes.get(keyOf(ballot.b));
      if (a == null || b == null || a === b) continue;
      comparisons.push({ a, b, y: ballot.aspectChoice === 'a' ? 1 : ballot.aspectChoice === 'b' ? 0 : 0.5 });
    }
    const fitted = fitBradleyTerry(entries.length, comparisons, entries.map(row => ({
      mean: row.prior == null ? 0 : (row.prior - 1000) / scale, variance: row.prior == null ? 1 : 0.25,
    })), { anchored: true });
    entries.forEach((row, i) => Object.assign(row.dimensions[dimension.id], {
      score: Math.round(fitted[i].score), interval: Math.round(fitted[i].interval), thin: row.dimensions[dimension.id].n < 10,
    }));
    result.boards[dimension.id] = entries.filter(row => row.dimensions[dimension.id].n > 0)
      .map(row => { const { score, interval, n, thin } = row.dimensions[dimension.id]; return { key: row.key, score, interval, n, thin }; })
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).map((row, i) => ({ ...row, rank: i + 1 }));
    const board = result.boards[dimension.id];
    const seed = createHash('sha256').update(`${seedKey}|${dimension.id}`).digest().readUInt32BE(0);
    const ranges = rankRanges(board, { ...rankRange, seed });
    board.forEach((row, i) => { [row.rankLow, row.rankHigh] = ranges[i]; });
  }
  const metrics = rows => {
    const answered = rows.filter(row => OUTCOMES[row.aspectChoice]);
    const directional = answered.filter(row => row.choice !== 'tie' && row.aspectChoice !== 'tie');
    let agreementN = 0, agreement = 0;
    const pairs = new Map();
    for (const row of answered) {
      const ids = [row.a.id, row.b.id];
      if (!ids.every(Boolean)) continue;
      const key = JSON.stringify([row.a.taskId, ...[...ids].sort()]);
      const choice = row.aspectChoice === 'tie' ? 'tie' : ids[row.aspectChoice === 'a' ? 0 : 1];
      if (!row.userId) continue;
      if (!pairs.has(key)) pairs.set(key, { n: 0, choices: new Map(), users: new Map() });
      const pair = pairs.get(key);
      if (!pair.users.has(row.userId)) pair.users.set(row.userId, { n: 0, choices: new Map() });
      const user = pair.users.get(row.userId);
      // Count only earlier ballots from other voters, without enumerating their pairs.
      agreementN += pair.n - user.n;
      agreement += (pair.choices.get(choice) ?? 0) - (user.choices.get(choice) ?? 0);
      pair.n++; user.n++;
      pair.choices.set(choice, (pair.choices.get(choice) ?? 0) + 1);
      user.choices.set(choice, (user.choices.get(choice) ?? 0) + 1);
    }
    const rate = (n, d) => d ? n / d : null;
    const cell = { pairs: rows.length, n: answered.length, skipped: rows.length - answered.length,
      skipRate: rate(rows.length - answered.length, rows.length), tieRate: rate(answered.filter(row => row.aspectChoice === 'tie').length, answered.length),
      sameSideN: directional.length, sameSideRate: rate(directional.filter(row => row.choice === row.aspectChoice).length, directional.length),
      agreementN, agreementRate: rate(agreement, agreementN), eligible: answered.length >= 20, flags: [] };
    if (cell.eligible) {
      if (cell.sameSideRate > 0.9) cell.flags.push('same-side');
      if (cell.tieRate > 0.5) cell.flags.push('ties');
      if (cell.skipRate > 0.3) cell.flags.push('skips');
    }
    return cell;
  };
  result.health = activeAspects.map(aspect => {
    const rows = ballots.filter(row => row.aspectId === aspect.id && OUTCOMES[row.choice]);
    return { id: aspect.id, dimension: aspect.dimension, keyword: aspect.keyword, ...metrics(rows),
      byOrder: Object.fromEntries(['before', 'after'].map(order => [order, metrics(rows.filter(row => (row.aspectOrder ?? 'before') === order))])) };
  });
  return result;
}
