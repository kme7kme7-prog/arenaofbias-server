// Show1 keeps its sequential Elo and weighted radar rules independently of the
// arena's Bradley–Terry board. Inputs are ordered live ballots and the public roster;
// this module never writes ballots or identities.
const BASE = 1200;
const K = 32;
const RADAR_BASE = 50;
const DIMENSIONS = 6;
const DEFAULT_WEIGHTS = Array(DIMENSIONS).fill(1 / DIMENSIONS);
const FAMILY_NAMES = {
  'claude-fable-5.x': 'Claude Fable 5.x',
  'claude-opus-5.x': 'Claude Opus 5.x',
  'gemini-3.8-flash': 'Gemini 3.x',
  'muse-spark-1.3': 'Muse Spark 1.x',
  'glm-5.3-flash': 'GLM-5.3-Flash',
};

const displayRadar = (value) => Math.max(0, Math.min(100, RADAR_BASE + (value - BASE) / 4));
const expectedWin = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

export function replayShow1Ratings(votes) {
  const ratings = {};
  const games = {};
  for (const vote of votes) {
    if (vote.winnerMid === vote.loserMid) continue;
    const a = ratings[vote.winnerMid] ?? BASE;
    const b = ratings[vote.loserMid] ?? BASE;
    const expected = expectedWin(a, b);
    const score = vote.outcome === 'draw' ? 0.5 : 1;
    ratings[vote.winnerMid] = a + K * (score - expected);
    ratings[vote.loserMid] = b + K * ((1 - score) - (1 - expected));
    games[vote.winnerMid] = (games[vote.winnerMid] ?? 0) + 1;
    games[vote.loserMid] = (games[vote.loserMid] ?? 0) + 1;
  }
  return { ratings, games };
}

export function buildShow1Boards(votes, works, prompts) {
  const promptMap = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const names = new Map();
  const coverage = new Map();
  for (const work of works) {
    if (work.isDemo) continue;
    if (!names.has(work.modelId)) names.set(work.modelId, {
      name: FAMILY_NAMES[work.modelId] ?? work.modelName,
      // The old live roster's sigil used the concrete name even for a family row.
      sigil: work.modelName.slice(0, 1).toUpperCase(),
      retired: false,
    });
    if (!coverage.has(work.modelId)) coverage.set(work.modelId, new Set());
    coverage.get(work.modelId).add(work.promptId);
  }
  for (const vote of votes) {
    for (const [id, name] of [[vote.winnerMid, vote.winnerName], [vote.loserMid, vote.loserName]]) {
      if (names.has(id)) continue;
      const display = FAMILY_NAMES[id] ?? name ?? id;
      names.set(id, { name: display, sigil: display.slice(0, 1).toUpperCase(), retired: true });
    }
  }

  const categories = {};
  for (const category of ['all', 'text', 'web']) {
    const scoped = votes.filter((vote) => {
      if (vote.winnerMid === vote.loserMid) return false;
      const kind = promptMap.get(vote.promptId)?.kind ?? vote.promptKind;
      return kind && (category === 'all' || kind === category);
    });
    const entries = new Map();
    const touch = (id) => {
      if (!entries.has(id)) entries.set(id, {
        rating: BASE, wins: 0, losses: 0, draws: 0, topics: new Set(),
        radar: Array(DIMENSIONS).fill(BASE),
      });
      return entries.get(id);
    };
    for (const vote of scoped) {
      const a = touch(vote.winnerMid);
      const b = touch(vote.loserMid);
      const score = vote.outcome === 'draw' ? 0.5 : 1;
      const expected = expectedWin(a.rating, b.rating);
      a.rating += K * (score - expected);
      b.rating += K * (1 - score - (1 - expected));
      if (vote.outcome === 'draw') { a.draws++; b.draws++; }
      else { a.wins++; b.losses++; }
      a.topics.add(vote.promptId);
      b.topics.add(vote.promptId);

      const promptWeights = promptMap.get(vote.promptId)?.weights;
      const weights = vote.promptWeights ?? (promptWeights?.length === DIMENSIONS ? promptWeights : DEFAULT_WEIGHTS);
      for (let d = 0; d < DIMENSIONS; d++) {
        if (!(weights[d] > 0)) continue;
        const expected = expectedWin(a.radar[d], b.radar[d]);
        a.radar[d] += K * weights[d] * (score - expected);
        b.radar[d] += K * weights[d] * (1 - score - (1 - expected));
      }
    }

    const rows = [];
    for (const [modelId, info] of names) {
      const entry = entries.get(modelId);
      if (!entry || (coverage.has(modelId) && coverage.get(modelId).size < 2)) continue;
      const games = entry.wins + entry.losses + entry.draws;
      rows.push({
        modelId, ...info, rating: Math.round(entry.rating), games,
        wins: entry.wins, losses: entry.losses, draws: entry.draws,
        winrate: entry.wins / games, topics: entry.topics.size, trial: games < 30,
      });
    }
    rows.sort((a, b) => b.rating - a.rating || b.games - a.games || a.modelId.localeCompare(b.modelId));
    const average = Array.from({ length: DIMENSIONS }, (_, d) => {
      let sum = 0;
      for (const entry of entries.values()) sum += entry.radar[d];
      return entries.size ? displayRadar(sum / entries.size) : RADAR_BASE;
    });
    categories[category] = {
      board: {
        rows, totalVotes: scoped.length, modelCount: rows.length,
        promptCount: category === 'all' ? prompts.length : prompts.filter((prompt) => prompt.kind === category).length,
      },
      radar: { profiles: Object.fromEntries([...entries].map(([id, entry]) => [id, entry.radar.map(displayRadar)])), average },
      scopedPromptCount: new Set(scoped.map((vote) => vote.promptId)).size,
    };
  }
  return categories;
}
