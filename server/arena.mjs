// Blind comparisons and the leaderboard.
//
// The server draws every pair, so a voter never chooses what to vote on. A match carries two
// opaque content tokens; the frames load from those tokens, so neither the page nor the
// frame address reveals which work (or model) is on which side until the vote is in.
//
// Sampling follows arenaofbias: first two different entries (model + effort), then one work
// of each, so an entry with many works is not shown more often. Pairs are weighted towards
// entries with few comparisons, prefer entries of similar strength, and avoid the previous
// round's works, ordinary voters' own uploads and pairs the voter has already judged.
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { effortKey, entityKey, modelKey, providerOf } from './catalog.mjs';
import { transaction } from './db.mjs';
import { fail, HttpError } from './http.mjs';
import { rankEntries, rankWorks } from './ranking.mjs';
import { generationOf } from './generation.mjs';
import { isTextTask } from './categories.mjs';
import { isStaff } from './roles.mjs';

const MATCH = { tierWidth: 150, sameTierRate: 0.9, blowoutGap: 400, rerolls: 2 };
const ANONYMOUS_MATCH_MAX = 10000;
// The dense solver grows roughly cubically with entry count: 40 entries took
// 112–128 ms locally, while 1000 blocked the main thread for 2.45 s. Use a
// conservative 200-entry cutoff so small boards avoid worker startup overhead.
const RANK_WORKER_ENTRY_THRESHOLD = 200;
export const pairKey = (taskId, a, b) => `${taskId}:${[a, b].sort().join('+')}`;
const token = () => `m${randomBytes(16).toString('hex')}`;
// `digest` pins the exact content: the packaged entry page or the uploaded file digest.
const identityOf = (work, digest = work.digest ?? null) => ({
  taskId: work.taskId, id: work.id, digest,
  title: work.title, modelId: work.modelId, modelName: work.modelName,
  vendor: work.vendor, effort: work.effort, effortKey: effortKey(work.effort),
  harnessId: work.harnessId ?? null, providerId: providerOf(work.providerId, work.providerOther),
  ...generationOf(work),
  modelKey: modelKey(work), configKey: entityKey(work), ownerId: work.ownerId,
});
const fromIdentity = (text) => {
  if (!text) return null;
  const { harnessVersion, modelVersion, generatedOn, evidenceUrl, providerOther, providerName, ...identity } = JSON.parse(text);
  return { ...identity, ...generationOf(identity), providerId: providerOf(identity.providerId, providerOther || providerName) };
};

export function createArena({ db, catalog, library, limits, random = Math.random }) {
  const q = {
    insertMatch: db.prepare('INSERT INTO matches (id, user_id, task_id, a_work, b_work, a_token, b_token, created_at, expires_at, datapack_root, datapack_version, a_identity, b_identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    match: db.prepare('SELECT * FROM matches WHERE id = ?'),
    lastMatch: db.prepare('SELECT * FROM matches WHERE user_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1'),
    matchByToken: db.prepare('SELECT * FROM matches WHERE (a_token = ? OR b_token = ?) AND expires_at > ?'),
    decide: db.prepare('UPDATE matches SET choice = ?, decided_at = ? WHERE id = ? AND choice IS NULL'),
    purge: db.prepare('DELETE FROM matches WHERE expires_at <= ? AND id NOT IN (SELECT match_id FROM votes)'),
    anonymousMatches: db.prepare('SELECT COUNT(*) AS n FROM matches WHERE user_id IS NULL AND id NOT IN (SELECT match_id FROM votes)'),
    insertVote: db.prepare("INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at, a_identity, b_identity, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'arena')"),
    votedPair: db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND pair_key = ?'),
    votedPairs: db.prepare('SELECT pair_key, a_work, b_work FROM votes WHERE user_id = ? AND task_id = ?'),
    votes: db.prepare("SELECT id, user_id, task_id, a_work, b_work, choice, a_identity, b_identity, a_correction, b_correction FROM votes WHERE source = 'arena' ORDER BY created_at"),
    votesOfTask: db.prepare("SELECT id, user_id, task_id, a_work, b_work, choice, a_identity, b_identity, a_correction, b_correction FROM votes WHERE task_id = ? AND source = 'arena' ORDER BY created_at"),
    userVotes: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?'),
    correctA: db.prepare('UPDATE votes SET a_correction = ? WHERE id = ?'),
    correctB: db.prepare('UPDATE votes SET b_correction = ? WHERE id = ?'),
    vote: db.prepare('SELECT * FROM votes WHERE id = ?'),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };

  let lastCleanup = 0;
  const cleanupExpiredMatches = (now = Date.now()) => {
    const result = q.purge.run(now);
    lastCleanup = now;
    return result.changes;
  };
  cleanupExpiredMatches();

  // The leaderboard only changes when votes or work states change; callers invalidate.
  let cache = new Map();
  const invalidate = () => { cache = new Map(); };

  // Eligibility follows current moderation/catalog membership; identity and score keys
  // come from the vote's saved snapshot and never drift with later label edits.
  // Votes without a snapshot (pre-snapshot test data) are not scored.
  // A vote counts only when BOTH saved identities match the provenance filters.
  // Historical provider ids normalize to the same categories as current works.
  // Harness free text is not kept in snapshots and counts as 'unset'.
  const provenanceMatch = (filters, item) => ['harness', 'provider'].every((field) => {
    const want = filters[field];
    const id = field === 'provider' ? providerOf(item.providerId, item.providerOther || item.providerName) : item.harnessId ?? null;
    return !want || (want === 'unset' ? !id : id === want);
  });

  async function countedVotes(taskId, snapshot, keyOf, filters = null, taskIds = null) {
    const works = new Map();
    const lookup = (task, id) => {
      const key = `${task}/${id}`;
      if (!works.has(key)) {
        const work = library.work(task, id, snapshot);
        works.set(key, library.isEligible(work) ? work : null);
      }
      return works.get(key);
    };
    const votes = [];
    const rankedKeys = new Set();
    let scanned = 0;
    for (const row of taskId ? q.votesOfTask.all(taskId) : q.votes.all()) {
      if (!row.a_identity || !row.b_identity || (taskIds && !taskIds.has(row.task_id))) continue;
      const a = lookup(row.task_id, row.a_work);
      const b = lookup(row.task_id, row.b_work);
      if (a && b) {
        const vote = {
          a: fromIdentity(row.a_correction) ?? fromIdentity(row.a_identity),
          b: fromIdentity(row.b_correction) ?? fromIdentity(row.b_identity),
          choice: row.choice, userId: row.user_id ?? `vote:${row.id}`,
        };
        if (filters && !(provenanceMatch(filters, vote.a) && provenanceMatch(filters, vote.b))) continue;
        votes.push(vote);
        const left = keyOf(vote.a), right = keyOf(vote.b);
        if (left !== right && rankedKeys.size <= RANK_WORKER_ENTRY_THRESHOLD) {
          rankedKeys.add(left);
          rankedKeys.add(right);
        }
      }
      if (++scanned % 100 === 0 && rankedKeys.size > RANK_WORKER_ENTRY_THRESHOLD)
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { votes, rankedEntryCount: rankedKeys.size };
  }

  const describe = (work, by) => ({
    model: work.modelId,
    modelName: work.modelName,
    vendor: work.vendor,
    effort: by === 'model' ? '' : work.effort,
  });

  function rankOffThread(votes, by, rankedEntryCount) {
    if (by === 'work' && rankedEntryCount <= RANK_WORKER_ENTRY_THRESHOLD)
      return Promise.resolve(rankWorks(votes, (work) => work.configKey ?? entityKey(work)));
    if (rankedEntryCount <= RANK_WORKER_ENTRY_THRESHOLD) return Promise.resolve(rankEntries(votes, by === 'model'
      ? (work) => work.modelKey ?? modelKey(work) : (work) => work.configKey ?? entityKey(work), limits));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./ranking-worker.mjs', import.meta.url), { workerData: { votes, by, limits } });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Ranking worker exited with ${code}`)); });
    });
  }

  function workScores(taskId, snapshot = catalog.snapshot()) {
    if (isTextTask(catalog.task(taskId))) return Promise.resolve([]);
    const cacheKey = `${snapshot.version}|${taskId}|work`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const activeCache = cache;
    const pending = Promise.resolve().then(async () => {
      const { votes, rankedEntryCount } = await countedVotes(taskId, snapshot, (work) => work.id);
      return rankOffThread(votes, 'work', rankedEntryCount);
    });
    activeCache.set(cacheKey, pending);
    void pending.catch(() => { if (activeCache.get(cacheKey) === pending) activeCache.delete(cacheKey); });
    return pending;
  }

  // `category` (the datapack's task category, e.g. 建模) scores only that category's tasks;
  // `domain` (e.g. 化学) only tasks naming it, and the two combine. A task with two domains
  // counts fully in both. The unscoped board also reports each entry's rank inside every category.
  // Totals count only comparisons the fit used: votes between works of one entry drop out.
  function leaderboard({ task = null, category = null, domain = null, by = 'config', snapshot = null, harness = null, provider = null } = {}) {
    const archive = snapshot ?? catalog.snapshot();
    const filters = harness || provider ? { harness, provider } : null;
    const cacheKey = `${archive.version}|${task ?? '*'}|${category ?? '*'}|${domain ?? '*'}|${by}${filters ? `|${harness ?? ''}|${provider ?? ''}` : ''}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const activeCache = cache;
    const pending = Promise.resolve().then(async () => {
      const keyOf = (work) => by === 'model' ? (work.modelKey ?? modelKey(work)) : (work.configKey ?? entityKey(work));
      const scoped = category || domain ? catalog.tasks().filter((t) => (!category || t.category === category) && (!domain || t.domains?.includes(domain))) : null;
      const { votes, rankedEntryCount } = await countedVotes(task, archive, keyOf, filters, scoped && new Set(scoped.map((t) => t.id)));
      const ranked = await rankOffThread(votes, by, rankedEntryCount);
      const scored = votes.filter((vote) => keyOf(vote.a) !== keyOf(vote.b));
      const pool = (task ? library.eligible(task, archive) : (scoped ?? catalog.tasks()).flatMap((t) => library.eligible(t.id, archive)))
        .filter((work) => !filters || provenanceMatch(filters, work));
      let standings;
      if (!task && !category && !domain) {
        standings = {};
        for (const name of new Set(catalog.tasks().map((t) => t.category).filter(Boolean))) {
          const board = await leaderboard({ category: name, by, snapshot, harness, provider });
          if (board.rows.length) standings[name] = Object.fromEntries(board.rows.map((row) => [row.key, row.rank]));
        }
      }
      const works = new Map();
      for (const work of pool) {
        const key = keyOf(work);
        if (!works.has(key)) works.set(key, { sample: work, count: 0 });
        works.get(key).count++;
      }
      const rankedKeys = new Set(ranked.map((row) => row.key));
      const result = {
        task,
        category,
        domain,
        by,
        ...(standings ? { standings } : {}),
        ...(filters ? { filters } : {}),
        totals: { votes: scored.length, voters: new Set(scored.map((vote) => vote.userId)).size, entries: ranked.length, tasks: new Set(scored.map((vote) => vote.a.taskId)).size },
        rows: ranked.map((row, i) => ({
          rank: i + 1,
          key: row.key,
          ...describe(row.sample, by),
          score: row.score,
          interval: row.interval,
          games: row.games,
          wins: row.wins,
          draws: row.draws,
          losses: row.losses,
          winRate: row.winRate,
          voters: row.voters,
          tasks: row.tasks,
          works: works.get(row.key)?.count ?? 0,
          provisional: row.provisional,
        })),
        unranked: [...works].filter(([key]) => !rankedKeys.has(key)).map(([key, { sample, count }]) => ({ key, ...describe(sample, by), works: count }))
          .sort((a, b) => a.modelName.localeCompare(b.modelName, 'en', { numeric: true }) || a.effort.localeCompare(b.effort)),
        provisionalGames: limits.provisionalGames,
        updatedAt: new Date().toISOString(),
      };
      return result;
    });
    activeCache.set(cacheKey, pending);
    void pending.catch(() => { if (activeCache.get(cacheKey) === pending) activeCache.delete(cacheKey); });
    return pending;
  }

  function candidatesFor(groups, votedRows, avoid) {
    const entries = [...groups].map(([key, works]) => [key, works.filter((work) => !avoid.has(work.id))]);
    const groupOf = new Map();
    for (let i = 0; i < entries.length; i++) for (const work of entries[i][1]) groupOf.set(work.id, i);
    const unavailable = new Map();
    for (const row of votedRows) {
      const a = groupOf.get(row.a_work), b = groupOf.get(row.b_work);
      if (a === undefined || b === undefined || a === b) continue;
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      unavailable.set(key, (unavailable.get(key) ?? 0) + 1);
    }
    const candidates = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (!entries[i][1].length || !entries[j][1].length ||
          (entries[i][1][0].promptVariant ?? '') !== (entries[j][1][0].promptVariant ?? '')) continue;
        const available = entries[i][1].length * entries[j][1].length - (unavailable.get(`${i}:${j}`) ?? 0);
        if (available > 0) candidates.push({ keys: [entityKey(entries[i][1][0]), entityKey(entries[j][1][0])], left: entries[i][1], right: entries[j][1], available });
      }
    }
    return candidates;
  }

  function pickWorks(taskId, chosen, voted, random) {
    let index = Math.floor(random() * chosen.available);
    if (!voted.size) return [chosen.left[Math.floor(index / chosen.right.length)], chosen.right[index % chosen.right.length]];
    for (const a of chosen.left) for (const b of chosen.right) {
      if (voted.has(pairKey(taskId, a.id, b.id))) continue;
      if (index-- === 0) return [a, b];
    }
    throw new Error('Candidate count changed while sampling');
  }

  function pick(candidates, board) {
    const rating = new Map(board.rows.map((row) => [row.key, row.score]));
    const games = new Map(board.rows.map((row) => [row.key, row.games]));
    const score = (key) => rating.get(key) ?? 1000;
    const tier = (key) => Math.floor(score(key) / MATCH.tierWidth);
    // Cold start first (arenaofbias 109): the fewer comparisons the rarer entry has, the likelier.
    const weight = ({ keys }) => 1 / (1 + Math.min(games.get(keys[0]) ?? 0, games.get(keys[1]) ?? 0));
    const roulette = (list) => {
      let ticket = random() * list.reduce((sum, candidate) => sum + weight(candidate), 0);
      for (const candidate of list) if ((ticket -= weight(candidate)) <= 0) return candidate;
      return list[list.length - 1];
    };
    // Soft matching (arenaofbias 046): mostly entries in the same strength band, never forced.
    const sameTier = candidates.filter(({ keys }) => tier(keys[0]) === tier(keys[1]));
    const list = sameTier.length && random() < MATCH.sameTierRate ? sameTier : candidates;
    let chosen = roulette(list);
    const gap = ({ keys }) => Math.abs(score(keys[0]) - score(keys[1]));
    for (let i = 0; i < MATCH.rerolls && gap(chosen) > MATCH.blowoutGap; i++) chosen = roulette(list);
    return chosen;
  }

  function poolStats(taskId) {
    const works = library.eligible(taskId);
    return { works: works.length, entries: new Set(works.map((work) => entityKey(work))).size };
  }

  return {
    invalidate,
    cleanupExpiredMatches,
    leaderboard,
    workScores,
    poolStats,

    async createMatch(user, taskId, previousId, snapshot = catalog.snapshot()) {
      if (!snapshot.task(taskId) && !catalog.task(taskId)) fail(404, '题目不存在');
      if (Date.now() - lastCleanup >= 60e3) cleanupExpiredMatches();
      const groups = new Map();
      for (const work of library.eligible(taskId, snapshot)) {
        if (user && !isStaff(user) && work.ownerId === user.id) continue;
        const key = JSON.stringify([work.promptVariant ?? '', entityKey(work)]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(work);
      }
      if (new Set([...groups.values()].map((works) => entityKey(works[0]))).size < 2)
        fail(409, '这道题还没有两个不同模型配置的已验证作品', 'insufficient');
      const votedRows = user ? q.votedPairs.all(user.id, taskId).filter((row) => row.pair_key.startsWith(`${taskId}:`)) : [];
      const voted = new Set(votedRows.map((row) => row.pair_key));
      const previous = previousId ? q.match.get(String(previousId)) : user ? q.lastMatch.get(user.id, taskId) : null;
      const avoid = new Set(previous?.task_id === taskId ? [previous.a_work, previous.b_work] : []);
      let candidates = candidatesFor(groups, votedRows, avoid);
      if (!candidates.length && avoid.size) candidates = candidatesFor(groups, votedRows, new Set());
      if (!candidates.length) fail(409, '这道题的组合你都已经评过了，换一道题试试', 'exhausted');

      const chosen = pick(candidates, await leaderboard({ task: taskId, snapshot }));
      const [first, second] = pickWorks(taskId, chosen, voted, random);
      const [a, b] = random() < 0.5 ? [first, second] : [second, first];
      const id = randomBytes(12).toString('hex');
      const now = Date.now();
      const tokens = [token(), token()];
      // Check immediately before inserting: concurrent draws can await the leaderboard.
      // Count only disposable anonymous rounds, preserving every recorded ballot.
      if (!user && q.anonymousMatches.get().n >= ANONYMOUS_MATCH_MAX) {
        const error = new HttpError(429, '当前体验人数较多，请稍后再试', 'anonymous-capacity');
        error.retryAfter = 60;
        throw error;
      }
      q.insertMatch.run(id, user?.id ?? null, taskId, a.id, b.id, tokens[0], tokens[1], now, now + limits.matchTtl,
        snapshot.root, snapshot.version, JSON.stringify(identityOf(a, a.curated ? snapshot.entryDigest(a) : a.digest)),
        JSON.stringify(identityOf(b, b.curated ? snapshot.entryDigest(b) : b.digest)));
      return {
        id,
        task: taskId,
        a: `${library.originOf(tokens[0])}/`,
        b: `${library.originOf(tokens[1])}/`,
        // Canvas framing per side so the parent can crop the iframe; the saved camera
        // itself is embedded by the content server, never exposed here.
        calibration: {
          a: library.calibrationOf?.(a, 'arena')?.framing ?? null,
          b: library.calibrationOf?.(b, 'arena')?.framing ?? null,
        },
        counted: Boolean(user?.email),
      };
    },

    vote(user, matchId, choice) {
      const match = q.match.get(String(matchId ?? ''));
      if (!match || match.expires_at <= Date.now() || (match.user_id && match.user_id !== user?.id)
        || !match.a_identity || !match.b_identity) fail(404, '这一组已经失效，请开始新的一组');
      if (match.choice) fail(409, '这一组已经提交过了');
      if (!['a', 'b', 'tie', 'skip'].includes(choice)) fail(400, '选择无效');
      const snapshot = catalog.at(match.datapack_root);
      const a = library.work(match.task_id, match.a_work, snapshot);
      const b = library.work(match.task_id, match.b_work, snapshot);
      const aIdentity = fromIdentity(match.a_identity);
      const bIdentity = fromIdentity(match.b_identity);
      let counted = false;
      let reason = choice === 'skip' ? 'skipped' : '';
      transaction(db, () => {
        q.decide.run(choice, Date.now(), match.id);
        if (choice === 'skip') return;
        if (!user) { reason = 'anonymous'; return; }
        if (!user.email) { reason = 'unbound'; return; }
        if (!library.isEligible(library.work(match.task_id, match.a_work)) || !library.isEligible(library.work(match.task_id, match.b_work))) { reason = 'changed'; return; }
        if (!isStaff(user) && (aIdentity.ownerId === user.id || bIdentity.ownerId === user.id)) { reason = 'own'; return; }
        const key = pairKey(match.task_id, match.a_work, match.b_work);
        if (q.votedPair.get(user.id, key)) { reason = 'duplicate'; return; }
        q.insertVote.run(randomBytes(12).toString('hex'), match.id, user.id, match.task_id, match.a_work, match.b_work, key, choice, Date.now(),
          match.a_identity, match.b_identity);
        counted = true;
      });
      if (counted) invalidate();
      const reveal = (work, identity) => work ? {
        ...library.toPublic(work, user),
        title: identity.title, model: identity.modelId, modelName: identity.modelName, vendor: identity.vendor, effort: identity.effort,
      } : null;
      return { choice, counted, reason, a: reveal(a, aIdentity), b: reveal(b, bIdentity) };
    },

    // The work behind a match token, for the content server.
    workForToken(key) {
      const match = q.matchByToken.get(key, key, Date.now());
      if (!match?.datapack_root) return null;
      let snapshot;
      try { snapshot = catalog.at(match.datapack_root); } catch { return null; } // Release already pruned.
      return library.work(match.task_id, match.a_token === key ? match.a_work : match.b_work, snapshot);
    },

    // Explicit correction of a saved vote. The caller supplies an authenticated admin
    // and a reason; the before/after identities are kept in the existing audit table.
    correctVote(admin, voteId, side, replacement, reason) {
      if (admin?.role !== 'admin') fail(403, '仅管理员可以操作');
      if (!['a', 'b'].includes(side) || !String(reason ?? '').trim()) fail(400, '更正侧与原因必填');
      if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)
        || Object.keys(replacement).some((key) => !['modelId', 'modelName', 'vendor', 'effort', 'harnessId', 'providerId'].includes(key))) fail(400, '仅可更正模型、厂商、档位、Harness 和服务商');
      for (const [field, lookup, label] of [['harnessId', 'harness', 'Harness'], ['providerId', 'provider', '服务商']]) {
        if (Object.hasOwn(replacement, field) && replacement[field] !== null && !(field === 'providerId' && replacement[field] === '') &&
          (typeof replacement[field] !== 'string' || !catalog[lookup](replacement[field]))) fail(400, `所选${label}不存在`);
      }
      const row = q.vote.get(voteId);
      if (!row) fail(404, '投票不存在');
      const original = fromIdentity(row[`${side}_identity`]);
      if (!original || !row.a_identity || !row.b_identity) fail(409, '旧票没有完整的当时身份快照，不能推断更正');
      const previous = fromIdentity(row[`${side}_correction`]) ?? original;
      const next = identityOf({ ...previous, ...replacement, taskId: previous.taskId, id: previous.id, ownerId: previous.ownerId });
      transaction(db, () => {
        (side === 'a' ? q.correctA : q.correctB).run(JSON.stringify(next), voteId);
        q.audit.run(Date.now(), admin.id, admin.name, 'vote-identity-correction', row.task_id, row[`${side}_work`],
          JSON.stringify({ voteId, side, previous, next, reason: String(reason).trim() }));
      });
      invalidate();
      return next;
    },

    votesBy: (userId) => q.userVotes.get(userId).n,
  };
}
