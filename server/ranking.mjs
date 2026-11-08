// Bradley–Terry ratings from pairwise blind votes.
//
// Each entry i has a strength β_i and P(i preferred over j) = 1 / (1 + e^(β_j − β_i)).
// A tie counts as half a win for each side. A weak N(0, 1) prior keeps entries with few
// comparisons near the average instead of letting two lucky votes decide the order.
// The posterior mode is found with Newton's method; its curvature gives the uncertainty.
// Scores are shown on the familiar Elo scale: 1000 is the average entry and 400 points
// is a factor of ten in the odds of being preferred. Unlike sequential Elo, the result does
// not depend on the order in which votes arrived.
const ELO = 400 / Math.LN10;
const CENTER = 1000;

function cholesky(matrix) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= lower[i][k] * lower[j][k];
      lower[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / lower[j][j];
    }
  }
  return lower;
}

function solveWith(lower, vector) {
  const n = lower.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = vector[i];
    for (let k = 0; k < i; k++) sum -= lower[i][k] * y[k];
    y[i] = sum / lower[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= lower[k][i] * x[k];
    x[i] = sum / lower[i][i];
  }
  return x;
}

// Comparisons have entry indexes, outcome y (1, 0, or 0.5), and optional weight w.
// Numeric prior is the original precision. Per-entry priors use logit mean/variance.
// Anchored work fits retain the configuration scale instead of recentering by work count.
export function fitBradleyTerry(size, comparisons, prior = 1, { anchored = false, strength = false } = {}) {
  if (!size) return [];
  const beta = new Float64Array(size);
  let hessian = null;
  for (let iteration = 0; iteration < 60; iteration++) {
    const gradient = new Float64Array(size);
    hessian = Array.from({ length: size }, () => new Float64Array(size));
    for (let i = 0; i < size; i++) {
      const precision = Array.isArray(prior) ? 1 / prior[i].variance : prior;
      const mean = Array.isArray(prior) ? prior[i].mean : 0;
      gradient[i] = -precision * (beta[i] - mean);
      hessian[i][i] = precision;
    }
    for (const { a, b, y, w = 1 } of comparisons) {
      const p = 1 / (1 + Math.exp(beta[b] - beta[a]));
      const weight = w * (p * (1 - p));
      gradient[a] += w * (y - p);
      gradient[b] -= w * (y - p);
      hessian[a][a] += weight;
      hessian[b][b] += weight;
      hessian[a][b] -= weight;
      hessian[b][a] -= weight;
    }
    const step = solveWith(cholesky(hessian), gradient);
    let largest = 0;
    for (const value of step) largest = Math.max(largest, Math.abs(value));
    // Damp very large first steps (an unbeaten entry) so Newton stays inside the basin.
    const scale = largest > 2 ? 2 / largest : 1;
    for (let i = 0; i < size; i++) beta[i] += step[i] * scale;
    if (largest < 1e-10) break;
  }
  // Covariance of β is the inverse Hessian at the mode; report scores relative to the mean.
  const lower = cholesky(hessian);
  const covariance = Array.from({ length: size }, (_, i) => {
    const unit = new Float64Array(size);
    unit[i] = 1;
    return solveWith(lower, unit);
  });
  const mean = beta.reduce((sum, value) => sum + value, 0) / size;
  const rowMeans = covariance.map((row) => row.reduce((sum, value) => sum + value, 0) / size);
  const grandMean = rowMeans.reduce((sum, value) => sum + value, 0) / size;
  return [...beta].map((value, i) => {
    const variance = Math.max(anchored ? covariance[i][i] : covariance[i][i] - 2 * rowMeans[i] + grandMean, 0);
    return { score: CENTER + ELO * (anchored ? value : value - mean), interval: 1.96 * ELO * Math.sqrt(variance),
      ...(strength ? { strength: value } : {}) };
  });
}

// votes: [{ a: work, b: work, choice: 'a' | 'b' | 'tie', userId }] where work carries the fields
// entityKey needs. Votes between two works of the same entry say nothing about the entry.
export function rankEntries(votes, keyOf, { provisionalGames, strength = false, voterModelKey = null, scoring = 2 }) {
  const entries = new Map();
  const touch = (work) => {
    const key = keyOf(work);
    if (!entries.has(key)) entries.set(key, { key, sample: work, games: 0, wins: 0, draws: 0, losses: 0, voters: new Set(), tasks: new Set(), taskWeights: new Map(), voterWeights: new Map() });
    return entries.get(key);
  };
  const comparisons = [];
  const voterVolumes = new Map();
  for (const vote of votes) {
    const a = touch(vote.a);
    const b = touch(vote.b);
    if (a === b) continue;
    for (const side of [a, b]) {
      side.games++;
      side.voters.add(vote.userId);
      side.tasks.add(vote.a.taskId);
    }
    if (vote.choice === 'tie') { a.draws++; b.draws++; }
    else if (vote.choice === 'a') { a.wins++; b.losses++; }
    else { b.wins++; a.losses++; }
    const comparison = { a, b, userId: vote.userId, taskId: vote.a.taskId, y: vote.choice === 'a' ? 1 : vote.choice === 'b' ? 0 : 0.5 };
    if (voterModelKey) {
      const left = voterModelKey(vote.a), right = voterModelKey(vote.b);
      if (!voterVolumes.has(vote.userId)) voterVolumes.set(vote.userId, new Map());
      const volumes = voterVolumes.get(vote.userId);
      volumes.set(left, (volumes.get(left) ?? 0) + 1);
      if (right !== left) volumes.set(right, (volumes.get(right) ?? 0) + 1);
      Object.assign(comparison, { volumes, left, right, baseWeight: vote.publicWeight ?? 1 });
    }
    comparisons.push(comparison);
  }
  const ranked = [...entries.values()].filter((entry) => entry.games > 0);
  const index = new Map(ranked.map((entry, i) => [entry, i]));
  if (scoring >= 3) for (const { a, b, volumes, left, right, baseWeight, userId, taskId } of comparisons) {
    const weight = volumes ? baseWeight * Math.min(1, Math.sqrt(20 / Math.max(volumes.get(left), volumes.get(right)))) : 1;
    for (const entry of [a, b]) {
      entry.taskWeights.set(taskId, (entry.taskWeights.get(taskId) ?? 0) + weight);
      entry.voterWeights.set(userId, (entry.voterWeights.get(userId) ?? 0) + weight);
    }
  }
  const fitted = ranked.length ? fitBradleyTerry(ranked.length, comparisons.map(({ a, b, y, volumes, left, right, baseWeight }) => ({
    a: index.get(a), b: index.get(b), y,
    w: volumes ? baseWeight * Math.min(1, Math.sqrt(20 / Math.max(volumes.get(left), volumes.get(right)))) : 1,
  })), 1, { strength }) : [];
  return ranked.map((entry, i) => ({
    key: entry.key,
    sample: entry.sample,
    score: Math.round(fitted[i].score),
    interval: Math.round(fitted[i].interval),
    ...(scoring >= 3 ? {
      intervalVotes: Math.round(fitted[i].interval),
      taskShare: Math.max(...entry.taskWeights.values()) / [...entry.taskWeights.values()].reduce((s, n) => s + n, 0),
      effectiveTasks: effectiveCount(entry.taskWeights.values()),
      effectiveVoters: effectiveCount(entry.voterWeights.values()),
    } : {}),
    games: entry.games,
    ...(strength ? { strength: fitted[i].strength } : {}),
    wins: entry.wins,
    draws: entry.draws,
    losses: entry.losses,
    winRate: (entry.wins + entry.draws / 2) / entry.games,
    voters: entry.voters.size,
    tasks: entry.tasks.size,
    provisional: entry.games < provisionalGames,
  })).sort((x, y) => y.score - x.score || y.games - x.games || x.key.localeCompare(y.key));
}

// One task at a time; same-configuration comparisons inform the work deviation.
export function rankWorks(votes, configKeyOf) {
  const configurations = new Map(rankEntries(votes, configKeyOf, { provisionalGames: 0, strength: true })
    .map((row) => [row.key, row.strength]));
  const works = new Map();
  const touch = (work) => {
    if (!works.has(work.id)) works.set(work.id, { id: work.id, config: configKeyOf(work), games: 0 });
    return works.get(work.id);
  };
  const comparisons = [];
  for (const vote of votes) {
    const a = touch(vote.a), b = touch(vote.b);
    if (a === b) continue;
    a.games++;
    b.games++;
    comparisons.push({ a, b, y: vote.choice === 'a' ? 1 : vote.choice === 'b' ? 0 : 0.5 });
  }
  const entries = [...works.values()].filter((work) => work.games > 0);
  const indexes = new Map(entries.map((work, i) => [work, i]));
  const fitted = fitBradleyTerry(entries.length,
    comparisons.map(({ a, b, y }) => ({ a: indexes.get(a), b: indexes.get(b), y })),
    entries.map((work) => ({ mean: configurations.get(work.config) ?? 0, variance: 0.25 })), { anchored: true });
  return entries.map((work, i) => ({ id: work.id, score: Math.round(fitted[i].score),
    interval: Math.round(fitted[i].interval), games: work.games }));
}


function effectiveCount(values) {
  const weights = [...values];
  return weights.reduce((s, n) => s + n, 0) ** 2 / weights.reduce((s, n) => s + n * n, 0);
}

export const widen = (intervalVotes, effectiveTasks, spread) =>
  Math.hypot(intervalVotes, 1.96 * spread / Math.sqrt(Math.max(1, effectiveTasks)));

// Tolerate arithmetic roundoff only at policy boundaries; retain reported precision.
const belowThreshold = (value, threshold) =>
  value < threshold - 1e-12 * Math.max(1, Math.abs(value), Math.abs(threshold));

export function eligibility(row, rule) {
  const reasons = [];
  if (rule.minimumTasks && row.tasks < rule.minimumTasks) reasons.push('tasks');
  if (rule.minimumTasks && belowThreshold(rule.maxTaskShare, row.taskShare)) reasons.push('task-share');
  if (belowThreshold(row.effectiveVoters, rule.minimumEffectiveVoters)) reasons.push('voters');
  return reasons;
}

// Mulberry32 and Box–Muller: local state makes identical snapshots reproducible.
function gaussian(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    let t = state += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

export function rankRanges(rows, { draws, level, seed }) {
  const normal = gaussian(seed);
  const ranks = rows.map(() => new Uint32Array(draws));
  for (let d = 0; d < draws; d++) {
    rows.map((row, i) => [row.score + row.interval / 1.96 * normal(), i])
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i], position) => { ranks[i][d] = position + 1; });
  }
  const tail = (1 - level) / 2;
  return ranks.map((r, i) => {
    r.sort();
    return [Math.min(i + 1, r[Math.floor(tail * (draws - 1))]),
      Math.max(i + 1, r[Math.ceil((1 - tail) * (draws - 1))])];
  });
}

export function composite(boards, weights) {
  const cats = Object.keys(weights), total = cats.reduce((s, c) => s + weights[c], 0);
  const parts = new Map();
  for (const c of cats) for (const row of boards[c] ?? []) parts.set(row.key, { ...parts.get(row.key), [c]: row });
  const full = [...parts].filter(([, p]) => cats.every((c) => p[c]));
  const centre = Object.fromEntries(cats.map((c) => [c, full.length ? full.reduce((s, [, p]) => s + p[c].score, 0) / full.length : 1000]));
  const partScores = (p) => Object.fromEntries(Object.entries(p).map(([c, row]) => [c,
    { rank: row.rank, aligned: row.score - centre[c] + 1000 }]));
  const rows = full.map(([key, p]) => ({ key,
    score: 1000 + cats.reduce((s, c) => s + weights[c] / total * (p[c].score - centre[c]), 0),
    interval: Math.hypot(...cats.map((c) => weights[c] / total * p[c].interval)),
    parts: partScores(p),
  })).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const partial = [...parts].filter(([, p]) => !cats.every((c) => p[c]))
    .map(([key, p]) => ({ key, parts: partScores(p), missing: cats.filter((c) => !p[c]) }));
  return { rows, partial };
}

// Runs in the ranking worker too, so rank sampling never blocks HTTP handling.
export function groupV3(rows, { rule, seed, singleTask = false, boards = null, minimumGames = 21, excludedModel = '' }) {
  const visible = rows.filter((r) => r.games >= minimumGames && r.key.split('|')[0] !== excludedModel)
    .map((r) => ({ ...r, interval: singleTask ? r.intervalVotes : widen(r.intervalVotes, r.effectiveTasks, rule.taskSpread) }));
  let ranked, partial = [], watch;
  if (boards) {
    const combined = composite(boards, rule.composite);
    const stats = new Map(visible.map((r) => [r.key, r]));
    ranked = combined.rows.filter((r) => stats.has(r.key)).map((r) => ({ ...stats.get(r.key), ...r }));
    partial = combined.partial.filter((r) => stats.has(r.key)).map((r) => {
      const { rank, score, interval, intervalVotes, ...rest } = stats.get(r.key);
      return { ...rest, ...r };
    });
    const keys = new Set([...ranked, ...partial].map((r) => r.key));
    watch = visible.filter((r) => !keys.has(r.key)).map((r) => ({ ...r, reasons: ['coverage'] }));
  } else {
    const tested = visible.map((r) => ({ ...r, reasons: eligibility(r, { ...rule, minimumTasks: singleTask ? 0 : rule.minimumTasks }) }));
    ranked = tested.filter((r) => !r.reasons.length).map(({ reasons, ...r }) => r);
    watch = tested.filter((r) => r.reasons.length);
  }
  const ranges = rankRanges(ranked, { ...rule.rankRange, seed });
  return { rows: ranked.map((r, i) => ({ ...r, rank: i + 1, rankLow: ranges[i][0], rankHigh: ranges[i][1] })),
    partial, watch: watch.map(({ rank, ...r }) => r) };
}
