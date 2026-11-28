import { createHash } from 'node:crypto';
import { fitBradleyTerry, rankRanges } from './ranking.mjs';

// Guided blind voting trial (staff only). Besides the overall question, a trial match may carry
// one aspect question (测评点) from its category's pool. Trial answers are kept in guided_trial_votes,
// which no board reads; only the staff dimension chart (trialStandings) counts them.
// Pilot: 建模, 静态网页, 文学 and 音乐. Aspect IDs are stable; the wording may change.
export const DIMENSIONS = { aesthetic: '审美能力', craft: '工程完备能力', logic: '逻辑能力', diverge: '发散能力', natural: '语言自然能力' };

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
  文学: [
    { id: 'lit_constraint', dimension: 'craft', question: '哪篇更符合提示词的要求？', keyword: '提示词的要求',
      hint: '对照提示词，看体裁格式、字数篇幅、禁用词、指定文风或分段要求有没有漏项、犯规或敷衍凑数。两边都严格达标就选「都很好」。' },
    { id: 'lit_coherence', dimension: 'logic', question: '哪篇的前后逻辑与细节推演更严谨自洽？', keyword: '前后逻辑',
      hint: '看因果链条、人物动机、时间线与设定细节是否合乎情理，有没有前后矛盾、强行降智或硬凹反转。' },
    { id: 'lit_plot', dimension: 'diverge', question: '哪篇的情节构思更有新意、不落俗套？', keyword: '情节构思',
      hint: '看故事走向、切入角度、意象设计或反转处理有没有让人眼前一亮的巧思，而不是一眼能猜到结尾的老套桥段。' },
    { id: 'lit_ai_flavor', dimension: 'natural', question: '哪篇的 AI 味更淡、读起来更自然？', keyword: 'AI 味',
      hint: '看有没有明显的“不是……而是……”句式堆砌、生硬翻译腔、排比金句强行升华、机械工整的段落结构或滥用破折号与引号黑话。两边都很自然就选「都很好」，都很重就选「都不好」。' },
    { id: 'lit_diction', dimension: 'natural', question: '哪篇的用词把握更准确、更贴合语境？', keyword: '用词把握',
      hint: '看遣词造句的分寸感、语体色彩与人物口吻是否对味，有没有词不达意、用力过猛的辞藻堆砌，或违和的书面语/网络热词混搭。' },
  ],
  音乐: [
    { id: 'music_melody', dimension: 'aesthetic', question: '哪首的旋律更好听、不别扭？', keyword: '旋律',
      hint: '看主旋律是否顺耳好听、有记忆点，有没有生硬断档或怪异别扭的跳音。' },
    { id: 'music_timbre', dimension: 'aesthetic', question: '哪首的音色层次更舒服、更有质感？', keyword: '音色层次',
      hint: '感受乐器与人声听起来是否自然舒服、层次分明，而不是刺耳干瘪或糊成一团。' },
    { id: 'music_mix', dimension: 'craft', question: '哪首的混音平衡做得更到位？', keyword: '混音平衡',
      hint: '看人声、伴奏和低频之间音量比例是否协调，声场是否干净不炸耳、不互相打架。' },
    { id: 'music_theme', dimension: 'logic', question: '哪首更贴合题目要求的曲风主题？', keyword: '曲风主题',
      hint: '对照题目给出的曲风、情绪和主题要求，看哪首真正做到了对味贴合。' },
    { id: 'music_idea', dimension: 'diverge', question: '哪首的编曲巧思让你眼前一亮？', keyword: '编曲巧思',
      hint: '听听有没有题目没明说但加得恰到好处的细节，比如转调、停顿留白或加花。' },
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
export function trialScores(ballots, keyOf, describe, priors = new Map(), { category = null, seedKey = '', rankRange = { draws: 2000, level: 0.95 }, voterModelKey = keyOf, fullWeightUserId = null } = {}) {
  const result = trialStandings(ballots, keyOf, describe, { category });
  const activeAspects = result.category ? ASPECTS[result.category] : Object.values(ASPECTS).flat();
  const activeById = new Map(activeAspects.map((aspect) => [aspect.id, aspect]));
  result.dimensions = result.dimensions.filter(dimension => dimension.aspects.length);
  result.boards = {};
  const entries = result.entries, indexes = new Map(entries.map((row, i) => [row.key, i]));
  const scale = 400 / Math.log(10);
  for (const row of entries) row.prior = priors.get(row.key) ?? null;
  for (const dimension of result.dimensions) {
    const comparisons = [], voterVolumes = new Map();
    for (const ballot of ballots) {
      if (activeById.get(ballot.aspectId)?.dimension !== dimension.id || !OUTCOMES[ballot.aspectChoice]) continue;
      const a = indexes.get(keyOf(ballot.a)), b = indexes.get(keyOf(ballot.b));
      if (a == null || b == null || a === b) continue;
      const comparison = { a, b, y: ballot.aspectChoice === 'a' ? 1 : ballot.aspectChoice === 'b' ? 0 : 0.5 };
      if (!fullWeightUserId || ballot.userId !== fullWeightUserId) {
        const voter = ballot.userId ?? ballot;
        if (!voterVolumes.has(voter)) voterVolumes.set(voter, new Map());
        const volumes = voterVolumes.get(voter);
        const left = voterModelKey(ballot.a), right = voterModelKey(ballot.b);
        volumes.set(left, (volumes.get(left) ?? 0) + 1);
        if (right !== left) volumes.set(right, (volumes.get(right) ?? 0) + 1);
        Object.assign(comparison, { volumes, left, right });
      }
      comparisons.push(comparison);
    }
    const weighted = comparisons.map(({ a, b, y, volumes, left, right }) => ({ a, b, y,
      w: volumes ? Math.min(1, Math.sqrt(20 / Math.max(volumes.get(left), volumes.get(right)))) : 1,
    }));
    const fitted = fitBradleyTerry(entries.length, weighted, entries.map(row => ({
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
