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

// comparisons: [{ a, b, y }] with entry indexes and y = 1 (a preferred), 0 (b), 0.5 (tie).
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
    for (const { a, b, y } of comparisons) {
      const p = 1 / (1 + Math.exp(beta[b] - beta[a]));
      const weight = p * (1 - p);
      gradient[a] += y - p;
      gradient[b] -= y - p;
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
export function rankEntries(votes, keyOf, { provisionalGames, strength = false }) {
  const entries = new Map();
  const touch = (work) => {
    const key = keyOf(work);
    if (!entries.has(key)) entries.set(key, { key, sample: work, games: 0, wins: 0, draws: 0, losses: 0, voters: new Set(), tasks: new Set() });
    return entries.get(key);
  };
  const comparisons = [];
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
    comparisons.push({ a, b, y: vote.choice === 'a' ? 1 : vote.choice === 'b' ? 0 : 0.5 });
  }
  const ranked = [...entries.values()].filter((entry) => entry.games > 0);
  const index = new Map(ranked.map((entry, i) => [entry, i]));
  const fitted = ranked.length ? fitBradleyTerry(ranked.length, comparisons.map(({ a, b, y }) => ({ a: index.get(a), b: index.get(b), y })), 1, { strength }) : [];
  return ranked.map((entry, i) => ({
    key: entry.key,
    sample: entry.sample,
    score: Math.round(fitted[i].score),
    interval: Math.round(fitted[i].interval),
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
