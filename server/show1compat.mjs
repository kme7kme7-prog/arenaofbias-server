// Show1 compatibility layer (fusion/show1-adapter/DESIGN.md): the old Show1 endpoints,
// same paths and shapes, backed by the read-only roster (server/show1/compat-data.json)
// and live ballots in the shared database. Retired snapshot ballots are never replayed.
// Roster response shapes follow the goldens in
// fusion/show1-adapter/golden/.
//
// Wiring (done by the app, not here): the snapshot is injected so tests can substitute
// a fixture —
//   import { readFileSync } from 'node:fs';
//   import { registerShow1Compat } from './show1compat.mjs';
//   const snapshot = JSON.parse(readFileSync(new URL('./show1/compat-data.json', import.meta.url), 'utf8'));
//   registerShow1Compat(router, { db, snapshot, config, limit });
//
// Notes:
//   - deps.limit reuses the app's rate-limit groups: limit.write for votes/comments/
//     reactions; limit.track (generous) for tracking — a built-in default applies when
//     no track limiter is supplied.
//   - handleSite sends every handler result with status 200. Endpoints whose contract
//     fixes another success status (201 vote/comment/reaction, 204 track) retarget this
//     response's writeHead via withStatus() and return their body normally.
//   - Compat votes are written with source='show1' (never counted by Bradley–Terry) and
//     a pair_key namespaced `show1:<formal 0|1>:<rid>+<rid>` so they cannot collide with
//     arena keys; migrated old-site votes keep source='legacy' and are excluded from
//     these reads and scores. The reset command removes their old deduplication rows.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './db.mjs';
import { fail, rateLimit, readJson } from './http.mjs';
import { buildShow1Boards, replayShow1Ratings } from './show1-ranking.mjs';
import { manualCorrections, voteAttribution, votesBeforeTaskMove } from './vote-attribution.mjs';
import { isTextTask, isAiJudgedTask } from './categories.mjs';

const forestTexts = JSON.parse(readFileSync(new URL('./playground-forest-texts.json', import.meta.url), 'utf8'));
const REACTION_EMOJI = { up: '👍', down: '👀', laugh: '🤯' };
const EMOJI_KIND = { '👍': 'up', '👀': 'down', '🤯': 'laugh' };
const MAPPED_EMOJIS = Object.keys(EMOJI_KIND);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const trim64 = (value) => String(value ?? '').trim().slice(0, 64);

// handleSite always answers 200; compat endpoints with a fixed success status point this
// response's writeHead at their own status and let the dispatcher send the body as usual.
function withStatus(res, status) {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (_status, headers) => writeHead(status, headers);
}

export function registerShow1Compat(router, deps) {
  const { db, snapshot, library } = deps;
  const limit = deps.limit ?? {};
  const write = limit.write ?? (() => {});
  const track = limit.track ?? rateLimit(60e3, 600);

  const q = {
    changes: db.prepare('SELECT total_changes() AS n'),
    dataVersion: db.prepare('PRAGMA data_version'),
    worksStamp: db.prepare('SELECT COUNT(*) AS n FROM works'),
    questionAudit: db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM audit WHERE action LIKE 'question%'"),
    contentGates: db.prepare('SELECT task_id, status, moderation, curated_as, author_role, content_key FROM works WHERE deleted_at IS NULL AND content_key IS NOT NULL'),
    liveFormal: db.prepare("SELECT * FROM votes WHERE source = 'show1' AND compat_mode = 'formal' ORDER BY created_at, id"),
    liveEntertainment: db.prepare("SELECT * FROM votes WHERE source = 'show1' AND (compat_mode IS NULL OR compat_mode <> 'formal') ORDER BY created_at, id"),
    voteByPair: db.prepare('SELECT * FROM votes WHERE user_id = ? AND pair_key = ?'),
    voteById: db.prepare('SELECT * FROM votes WHERE id = ?'),
    insertMatch: db.prepare(`INSERT INTO matches (id, user_id, task_id, a_work, b_work, a_token, b_token, created_at,
      expires_at, choice, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertVote: db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice,
      created_at, a_identity, b_identity, source, compat_mode, compat_weights_json, compat_weight_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'show1', ?, ?, 'cast')`),
    commentsOfTask: db.prepare(`SELECT comments.id, comments.side, comments.body, comments.created_at, users.name AS username
      FROM comments JOIN works ON works.id = comments.work_id LEFT JOIN users ON users.id = comments.user_id
      WHERE works.task_id = ? AND comments.deleted_at IS NULL
      ORDER BY comments.created_at DESC, comments.id DESC LIMIT 100`),
    commentById: db.prepare('SELECT * FROM comments WHERE id = ?'),
    insertComment: db.prepare('INSERT INTO comments (id, task_id, work_id, user_id, body, created_at, side) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    latestVote: db.prepare("SELECT * FROM votes WHERE user_id = ? AND task_id = ? AND source IN ('show1', 'legacy') ORDER BY created_at DESC LIMIT 1"),
    reactionCounts: db.prepare('SELECT work_id, emoji, COUNT(*) AS n FROM reactions WHERE task_id = ? GROUP BY work_id, emoji'),
    myReactions: db.prepare('SELECT work_id, emoji FROM reactions WHERE task_id = ? AND user_id = ?'),
    dropMapped: db.prepare("DELETE FROM reactions WHERE task_id = ? AND work_id = ? AND user_id = ? AND emoji IN ('👍', '👀', '🤯')"),
    dropEmoji: db.prepare('DELETE FROM reactions WHERE task_id = ? AND work_id = ? AND user_id = ? AND emoji = ?'),
    addReaction: db.prepare('INSERT OR IGNORE INTO reactions (task_id, work_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)'),
    pageView: db.prepare('INSERT INTO page_views (day, path, ip_hash, created_at) VALUES (?, ?, ?, ?)'),
    arenaEditorial: db.prepare("SELECT commentary, weights_json FROM task_editorial WHERE task_id = ? AND face = 'arena'"),
    liveWorks: db.prepare("SELECT id, task_id, model_id, model_other, model_vendor, title, content_key, entertainment_route FROM works WHERE status = 'verified' AND show_entertainment = 1 AND json_extract(moderation, '$.status') IN ('legacy', 'approved') AND curated_as IS NULL AND deleted_at IS NULL ORDER BY created_at, id"),
  };

  // Keep legacy arena numbers; other public questions retain their canonical task ID.
  // catalog.tasks() is the public question catalog, including reviewed database questions.
  // The merge runs one database round per catalog task, and taskOfRound resolves it for
  // every roster row — without the cache one roster read rebuilt the catalog hundreds of
  // times. Question changes always leave an audit row, which keys the cache together with
  // the package version; the TTL floor is a backstop for direct database edits.
  function buildPromptCatalog() {
    const taskByRound = { ...snapshot.taskByRound }, roundByTask = { ...snapshot.roundByTask };
    const prompts = new Map(snapshot.prompts.map((prompt) => [prompt.id, prompt]));
    for (const task of deps.catalog.tasks?.() ?? []) {
      const round = task.arenaId ?? roundByTask[task.id] ?? task.id;
      if (!/^(?:\d{3}|[a-z][a-z0-9-]{0,63})$/.test(round)
        || (taskByRound[round] && taskByRound[round] !== task.id)
        || (roundByTask[task.id] && roundByTask[task.id] !== round)) {
        throw new Error(`Conflicting arena question ID: ${task.id}`);
      }
      const previous = prompts.get(round);
      const kind = task.kind ?? (isTextTask(task) ? 'text' : 'web');
      taskByRound[round] = task.id;
      roundByTask[task.id] = round;
      prompts.set(round, {
        ...previous, id: round, kind,
        category: previous?.category ?? task.category,
        code: previous?.code ?? (kind === 'text' ? 'STORY' : 'WEB'),
        name: previous?.name ?? task.title, prompt: task.prompt,
        ...(task.promptVariants?.length ? { promptVariants: task.promptVariants } : {}),
        commentary: previous?.commentary ?? task.summary,
        detail: previous?.detail ?? '同一提示词 · 不同模型的结果',
      });
    }
    return { prompts: [...prompts.values()].filter((prompt) => !isAiJudgedTask(deps.catalog.task?.(taskByRound[prompt.id]) ?? prompt))
      .sort((a, b) => a.id.localeCompare(b.id)), taskByRound, roundByTask,
      aiRounds: new Set([...prompts.values()].filter((prompt) => isAiJudgedTask({ category: prompt.category })).map((prompt) => prompt.id)) };
  }
  let catalogCache = { signature: '', at: 0, value: null };
  // Reading the catalog version stats the package directory, which costs real
  // milliseconds on this host; signatures sample it at most every five seconds.
  // A package switch is also announced through the catalog takeover callback.
  let versionSample = { at: 0, value: '' };
  const catalogVersion = () => {
    const now = Date.now();
    if (now - versionSample.at >= 5_000) versionSample = { at: now, value: deps.catalog.version ?? '' };
    return versionSample.value;
  };
  function promptCatalog() {
    const stamp = q.questionAudit.get();
    const signature = `${stamp.n}|${stamp.m}|${catalogVersion()}`;
    const now = Date.now();
    if (catalogCache.value && catalogCache.signature === signature && now - catalogCache.at < 60_000) return catalogCache.value;
    catalogCache = { signature, at: now, value: buildPromptCatalog() };
    return catalogCache.value;
  }
  const taskOfRound = (round) => promptCatalog().taskByRound[round];
  const roundOfTask = (task) => promptCatalog().roundByTask[task];
  const promptOf = (id) => promptCatalog().prompts.find((prompt) => prompt.id === id) ?? null;
  const published = (round) => Object.hasOwn(promptCatalog().taskByRound, round);
  // AI-judged questions sit out arena scoring. The merged catalog already carries
  // every public question's category, so this stays on the cached catalog instead
  // of one catalog.task() query per roster row.
  const aiJudgedTaskId = (taskId) => promptCatalog().aiRounds.has(roundOfTask(taskId));
  // Datapack ids repeat across tasks (and old snapshot rids look like 004-grok-4.6), so a
  // datapack work's game id carries its round. Votes still store the work id with its task.
  const datapackRid = (round, id) => `dp-${round}-${id}`;
  const ridOf = (round, workId) => snapshot.upToRid[workId]
    ?? (/^(?:up-|legacy:)/.test(workId) ? workId : datapackRid(round, workId));
  // The roster sorted by rid once: every "first work of a mid/task" lookup is deterministic.
  // The content gate runs against one batched row fetch: per-work byContentKey
  // queries cost a users join and an audit subquery each, times ~900 works.
  // Rows are read fresh on every call chain, so moderation flips keep applying.
  const buildGates = () => !library ? null : new Map(q.contentGates.all().map((row) => [row.content_key,
    { taskId: row.task_id, status: row.status, moderation: JSON.parse(row.moderation),
      curatedAs: row.curated_as, authorRole: row.author_role, curated: false }]));
  const liveWorks = (gates = buildGates()) => {
    const { roundByTask, aiRounds } = promptCatalog();
    // A work must belong to the same public catalog used by prompts and ballots.
    // Pending/deleted community questions and unassigned inbox items stay out.
    const uploads = q.liveWorks.all().filter((row) => row.entertainment_route !== 1 && !snapshot.upToRid[row.id]
      && roundByTask[row.task_id]
      && !aiRounds.has(row.task_id)
      && (!gates || library.publicContent(gates.get(row.content_key))))
      .map((row) => ({ ...row, round: roundByTask[row.task_id] ?? row.task_id,
        modelName: row.model_id ? (deps.catalog.model(row.model_id)?.name ?? row.model_id) : row.model_other,
        vendor: row.model_id ? (deps.catalog.model(row.model_id)?.vendor ?? '') : row.model_vendor }));
    // Datapack works follow the same entertainment switch as uploads (on unless turned off);
    // their files use persistent public indexes; private p previews remain separate.
    const archive = deps.catalog.snapshot?.();
    const datapack = !library || !archive ? [] : archive.tasks().flatMap((task) => {
      const round = roundByTask[task.id];
      if (!round || aiRounds.has(round)) return [];
      return [...task.works.values()].filter((work) => library.publicCuratedContent(work)).map((work) => ({
        id: work.id, rid: datapackRid(round, work.id), task_id: task.id, round,
        model_id: work.modelId ?? null, model_other: work.modelId ? '' : (work.modelName ?? ''), title: work.title,
        content_key: library.curatedContentKey(work), modelName: work.modelName ?? work.modelId ?? '', vendor: work.vendor ?? '' }));
    });
    return [...uploads, ...datapack];
  };
  const workMap = () => Object.fromEntries([
    ...Object.entries(snapshot.workMap),
    ...liveWorks().map((row) => [row.rid ?? row.id, { up: row.id, key: row.content_key, task: row.task_id,
      round: row.round, mid: row.model_id, modelName: row.modelName, vendor: row.vendor, title: row.title }]),
  ]);
  const roster = () => Object.entries(workMap()).sort(([a], [b]) => a.localeCompare(b));
  const workOf = (taskId, mid) => {
    for (const [, work] of roster()) if (work.task === taskId && work.mid === mid) return work;
    return null;
  };
  const anyWorkOf = (taskId) => {
    for (const [, work] of roster()) if (work.task === taskId) return work;
    return null;
  };
  const midOfWorkId = (round, workId) => workMap()[ridOf(round, workId)]?.mid ?? null;

  // A live compat vote back to the old vote shape (goldens: votes_*.json). Tie votes
  // report side a as the "winner" with outcome 'draw', exactly like the old server.
  function oldShape(row, archive, manual) {
    const winnerIsA = row.choice !== 'b';
    const resolve = (side) => {
      const identity = JSON.parse(row[`${side}_identity`]);
      const work = library?.ballotWork(row.task_id, row[`${side}_work`], archive)
        ?? library?.ballotWork(identity.taskId, row[`${side}_work`], archive);
      return voteAttribution(row, side, identity, JSON.parse(row[`${side}_correction`] ?? 'null'), work, archive, manual);
    };
    const aIdentity = resolve('a'), bIdentity = resolve('b');
    const winnerIdentity = winnerIsA ? aIdentity : bIdentity;
    const loserIdentity = winnerIsA ? bIdentity : aIdentity;
    const winnerWork = winnerIsA ? row.a_work : row.b_work;
    const loserWork = winnerIsA ? row.b_work : row.a_work;
    const promptId = roundOfTask(row.task_id) ?? row.task_id;
    const prompt = promptOf(promptId);
    const vote = {
      id: row.id,
      promptId,
      winnerRid: ridOf(promptId, winnerWork),
      winnerMid: winnerIdentity.modelId,
      loserRid: ridOf(promptId, loserWork),
      loserMid: loserIdentity.modelId,
      mode: row.compat_mode ?? 'blind',
      ts: row.created_at,
      outcome: row.choice === 'tie' ? 'draw' : 'win',
      winnerName: winnerIdentity.modelName,
      loserName: loserIdentity.modelName,
      promptKind: prompt?.kind ?? null,
    };
    // Mirrors the old parseWeightsColumn: the key is absent when the prompt has no weights.
    const weights = row.compat_weights_json ? JSON.parse(row.compat_weights_json) : prompt?.weights;
    if (weights != null) vote.promptWeights = weights;
    return vote;
  }

  const byTimeThenId = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function currentVotes(scope) {
    const archive = deps.catalog.snapshot?.();
    const manual = manualCorrections(db);
    const moved = votesBeforeTaskMove(db);
    return (scope === 'formal' ? q.liveFormal : q.liveEntertainment).all()
      .filter((row) => !aiJudgedTaskId(row.task_id) && !moved(row))
      .map((row) => oldShape(row, archive, manual)).sort(byTimeThenId);
  }

  const scopeOf = (ctx) => {
    const scope = String(ctx.url.searchParams.get('scope') ?? '');
    if (scope !== 'entertainment' && scope !== 'formal') fail(400, '测评数据范围无效');
    return scope;
  };

  const promptsOf = () => promptCatalog().prompts.map((prompt) => {
    const row = q.arenaEditorial.get(taskOfRound(prompt.id) ?? '');
    return row ? { ...prompt, commentary: row.commentary, ...(row.weights_json ? { weights: JSON.parse(row.weights_json) } : {}) } : prompt;
  });
  // Historical HTML rows are indexes, not publication authority. Match the w-host
  // gate at read time so removed tasks / held works cannot enter the random pool.
  const snapshotWorks = (gates) => snapshot.works.filter((row) => {
    if (promptCatalog().aiRounds.has(row.promptId)) return false;
    if (!library || JSON.parse(row.content).kind !== 'html') return true;
    const key = snapshot.workMap[row.id]?.key;
    return !!key && library.publicContent(gates.get(key));
  });
  // Text uploads keep their original file inside the work package. The arena
  // renders text tasks natively, so the roster hands out the story shape the
  // frontend expects; anything unreadable falls back to the wrapped HTML page.
  // Wrapper pages without an original file expose the same text in <main>.
  const storyFromHtml = (html) => {
    if (/<script/i.test(html)) return null;
    const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
    if (!main) return null;
    const paragraphs = main[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (!paragraphs.length || paragraphs.length > 40 || paragraphs.some((line) => line.length > 800)) return null;
    return { kind: 'text', story: { paragraphs } };
  };
  const textStory = (row) => {
    if (!deps.config?.dataDir) return null;
    const dir = join(deps.config.dataDir, 'works', row.id);
    try {
      const raw = readFileSync(join(dir, 'original.txt'), 'utf8');
      const paragraphs = raw.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
      return paragraphs.length ? { kind: 'text', story: { paragraphs } } : null;
    } catch { /* Not a text upload; try the wrapper page. */ }
    try {
      return storyFromHtml(readFileSync(join(dir, 'index.html'), 'utf8'));
    } catch { return null; }
  };
  // Reading every text work's files is the roster's real cost, so parsed stories
  // are cached per work. Only the works row count (a work appeared or left) or a
  // catalog switch retires the whole cache — unrelated writes (sessions, votes,
  // captures, metadata edits) must not, or every request would rebuild it.
  // Rows added or hidden are picked up by the live query and cache misses; a TTL
  // floor also retires it after file-level fixes (story re-extraction) that
  // never touch SQLite. Gates and row filters stay uncached so moderation flips
  // keep applying immediately.
  let storyCache = { signature: '', at: 0, stories: new Map() };
  const storiesSnapshot = () => {
    const signature = `${q.worksStamp.get().n}|${catalogVersion()}`;
    const now = Date.now();
    if (storyCache.signature !== signature || now - storyCache.at >= 60_000) {
      storyCache = { signature, at: now, stories: new Map() };
    }
    return storyCache.stories;
  };
  const worksOf = () => {
    const kindByRound = new Map(promptCatalog().prompts.map((prompt) => [prompt.id, prompt.kind]));
    const stories = storiesSnapshot();
    const gates = buildGates();
    return [...snapshotWorks(gates), ...liveWorks(gates).map((row) => {
      let story = null;
      if (kindByRound.get(row.round) === 'text') {
        if (!stories.has(row.id)) stories.set(row.id, textStory(row));
        story = stories.get(row.id);
      }
      return {
        id: row.rid ?? row.id, promptId: row.round, modelId: row.model_id,
        modelName: row.modelName, vendor: row.vendor, title: row.title, isDemo: 0,
        content: JSON.stringify(story ?? { kind: 'html', src: `${deps.config.contentTemplate.replace('{token}', row.content_key)}/` }),
      };
    })];
  };

  // SQLite revisions cover writes through this connection and maintenance writes
  // through another connection. Catalog changes can rename live roster models.
  // Cache at most the two scopes; every category and matching ratings share it.
  let revision = '';
  const cache = new Map();
  const aggregates = (scope) => {
    const next = `${q.changes.get().n}|${q.dataVersion.get().data_version}|${deps.catalog.version ?? ''}`;
    if (revision !== next) { revision = next; cache.clear(); }
    if (!cache.has(scope)) {
      const votes = currentVotes(scope);
      cache.set(scope, { ratings: replayShow1Ratings(votes), boards: buildShow1Boards(votes, worksOf(), promptsOf()) });
    }
    return cache.get(scope);
  };

  // ---- read-only snapshot -----------------------------------------------------

  router.on('GET', '/api/prompts', () => ({ prompts: promptsOf() }));
  router.on('GET', '/api/works', () => ({ works: worksOf() }));
  // A native-reader projection of the same gated public roster. Original endpoints
  // and files stay intact; known legacy HTML is used only while its SHA matches.
  router.on('GET', '/api/playground/works', () => ({ works: worksOf().map(row => {
    const extracted = row.promptId === '013' && forestTexts[row.id];
    if (!extracted || !library) return row;
    const key = snapshot.workMap[row.id]?.key;
    const work = key && library.byContentKey(key);
    if (!work || !library.publicContent(work)) return row;
    try {
      const source = readFileSync(join(work.dir, work.entry ?? 'index.html'));
      if (sha256(source) === extracted.sha256) return { ...row, content: JSON.stringify({ kind: 'text', story: extracted.story }) };
    } catch { /* Unavailable or changed HTML retains the public renderer. */ }
    return row;
  }) }));

  router.on('GET', '/api/votes', (ctx) => ({ votes: currentVotes(scopeOf(ctx)) }));

  router.on('GET', '/api/ratings', (ctx) => aggregates(scopeOf(ctx)).ratings);

  router.on('GET', '/api/show1/leaderboard', (ctx) => {
    const scope = scopeOf(ctx);
    const category = ctx.url.searchParams.get('category') ?? 'all';
    if (!['all', 'text', 'web'].includes(category)) fail(400, '榜单赛道无效');
    const { boards } = aggregates(scope);
    return { scope, category, ...boards[category], allBoard: boards.all.board };
  });

  // ---- votes -------------------------------------------------------------------

  router.on('POST', '/api/votes', async (ctx) => {
    const user = ctx.user ?? fail(401, '请先登录再投票。');
    write(user.id);
    const body = await readJson(ctx.req);
    const id = String(body.id ?? '');
    if (!UUID4.test(id)) fail(400, '投票编号无效');
    const promptId = String(body.promptId ?? '');
    if (isAiJudgedTask(deps.catalog.task?.(taskOfRound(promptId)))) fail(409, '这道题由 AI 评分，暂不接受投票', 'ai-judged');
    if (!published(promptId)) fail(400, '题目不存在');
    const winnerRid = trim64(body.winnerRid);
    const loserRid = trim64(body.loserRid);
    const winnerMid = trim64(body.winnerMid);
    const loserMid = trim64(body.loserMid);
    const raw = [body.winnerRid, body.loserRid, body.winnerMid, body.loserMid].map((value) => String(value ?? '').trim());
    if (!winnerRid || !loserRid || !winnerMid || !loserMid || raw.some((value) => value.length > 64)
      || winnerRid === loserRid || winnerMid === loserMid) fail(400, '投票内容无效');
    const mode = String(body.mode ?? 'blind');
    if (!['blind', 'party', 'formal'].includes(mode)) fail(400, '投票模式无效');
    if (mode === 'formal' && user.role !== 'admin') fail(403, '正式测评为资格制，暂未开放。');
    const outcome = body.outcome == null ? 'win' : String(body.outcome);
    if (!['win', 'draw'].includes(outcome)) fail(400, '投票结果无效');
    const map = workMap();
    const winner = map[winnerRid];
    const loser = map[loserRid];
    if (!winner || !loser || winner.round !== promptId || loser.round !== promptId
      || winner.mid !== winnerMid || loser.mid !== loserMid) fail(400, '投票内容与作品不匹配');
    if (!user.email) return { counted: false, reason: 'unbound' };

    // a/b follow the rid order, like the migration's placeholder matches; the choice then
    // falls out of which side won (a draw is a tie, side a reports as the old "winner").
    const [aRid, bRid] = [winnerRid, loserRid].sort((x, y) => x.localeCompare(y));
    const a = map[aRid];
    const b = map[bRid];
    const choice = outcome === 'draw' ? 'tie' : aRid === winnerRid ? 'a' : 'b';
    const pairKey = `show1:${mode === 'formal' ? 1 : 0}:${aRid}+${bRid}`;

    // Migrated old-site votes keep the bare `rid+rid` pair_key (no namespace/scope flag),
    // so check both keys: a pair judged on the old site stays voted. Legacy rows carry no
    // mode, so a legacy entertainment vote also blocks a formal re-vote of the pair —
    // accepted trade-off (formal is admin-only).
    const legacyKey = `${aRid}+${bRid}`;
    const existing = q.voteByPair.get(user.id, pairKey) ?? q.voteByPair.get(user.id, legacyKey);
    if (existing) {
      if (existing.id !== id || existing.source === 'legacy') fail(409, '这一对作品你已经投过票了。', 'pair');
      if (existing.choice !== choice || existing.a_work !== a.up || existing.b_work !== b.up
        || existing.compat_mode !== mode) fail(409, '投票编号冲突，请重新提交', 'id');
      return { vote: oldShape(existing) }; // Idempotent replay of the stored ballot.
    }
    if (q.voteById.get(id)) fail(409, '投票编号冲突，请重新提交', 'id');

    // Count the current public roster, not historical ballots or model names.
    // Replays above remain idempotent even if a pool has since closed.
    if (mode !== 'formal') {
      const count = new Set(worksOf().filter((work) => work.promptId === promptId && !work.isDemo)
        .map((work) => work.id)).size;
      if (count < 10) fail(409, `作品收集中（${count}/10），暂未开放娱乐盲测`, 'pool');
    }
    const taskId = taskOfRound(promptId);
    const now = Date.now();
    const editorial = q.arenaEditorial.get(taskId);
    const weights = editorial?.weights_json ? JSON.parse(editorial.weights_json) : promptOf(promptId)?.weights ?? null;
    const archive = deps.catalog.snapshot?.();
    const identity = (entry) => {
      const work = library?.ballotWork(taskId, entry.up, archive);
      const digest = work?.curated ? archive?.entryDigest(work) : work?.digest;
      return JSON.stringify({
        taskId, id: entry.up, digest: digest ?? null, title: entry.title,
        modelId: entry.mid, modelName: entry.modelName, vendor: entry.vendor ?? deps.catalog.model(entry.mid)?.vendor ?? '', effort: '',
        effortKey: '', modelKey: entry.mid, configKey: entry.mid, ownerId: null,
      });
    };
    // Placeholder match in the migration's shape: decided at creation, immediately expired.
    const matchId = sha256(`show1:match:${id}`).slice(0, 16);
    try {
      transaction(db, () => {
        q.insertMatch.run(matchId, user.id, taskId, a.up, b.up,
          `w${sha256(`show1:match-token:${id}:a`).slice(0, 32)}`,
          `m${sha256(`show1:match-token:${id}:b`).slice(0, 32)}`,
          now, now, choice, now);
        q.insertVote.run(id, matchId, user.id, taskId, a.up, b.up, pairKey, choice, now, identity(a), identity(b), mode,
          weights ? JSON.stringify(weights) : null);
      });
    } catch (error) {
      // A concurrent first write can still hit UNIQUE (user_id, pair_key) or the id PK.
      if (/constraint/i.test(String(error?.message))) fail(409, '这一对作品你已经投过票了。', 'pair');
      throw error;
    }

    // Answer with the stored row mapped back to the old shape, so the response matches
    // what GET /api/votes will report — including side a as the "winner" of a draw.
    withStatus(ctx.res, 201);
    return { vote: oldShape(q.voteById.get(id)) };
  });

  // ---- comments ------------------------------------------------------------------

  const publicComment = (row, roundId) => ({
    id: row.id,
    roundId,
    side: row.side ?? null,
    body: row.body,
    createdAt: typeof row.created_at === 'number' ? row.created_at : Date.parse(row.created_at),
    username: row.username ?? null,
  });

  router.on('GET', '/api/comments', (ctx) => {
    const round = String(ctx.url.searchParams.get('round') ?? '');
    if (!published(round)) fail(400, '题目不存在');
    return { comments: q.commentsOfTask.all(taskOfRound(round)).map((row) => publicComment(row, round)) };
  });

  router.on('POST', '/api/comments', async (ctx) => {
    const user = ctx.user ?? fail(401, '请先登录再留言。');
    write(user.id);
    const body = await readJson(ctx.req);
    const id = String(body.id ?? '');
    const roundId = String(body.roundId ?? '');
    const side = String(body.side ?? '');
    const text = String(body.body ?? '').trim();
    if (!UUID4.test(id) || !['a', 'b'].includes(side) || !text || text.length > 280) fail(400, '留言内容无效');
    if (!published(roundId)) fail(400, '题目不存在');
    const taskId = taskOfRound(roundId);

    // Same rule as the migration: the comment belongs to the work of the mid on the side
    // the commenter backed in their latest vote on this task; no vote → any work there.
    let work = null;
    const vote = q.latestVote.get(user.id, taskId);
    if (vote) {
      const votedWork = side === 'a' ? vote.a_work : vote.b_work;
      let mid = null;
      if (typeof votedWork === 'string' && votedWork.startsWith('legacy:')) mid = votedWork.slice('legacy:'.length);
      else {
        try { mid = JSON.parse(side === 'a' ? vote.a_identity : vote.b_identity)?.modelId ?? null; } catch { mid = null; }
      }
      if (mid) work = workOf(taskId, mid);
    }
    work ??= anyWorkOf(taskId);
    if (!work) fail(400, '题目不存在');

    const now = Date.now();
    let row = { id, side, body: text, created_at: now, username: user.name };
    try {
      q.insertComment.run(id, taskId, work.up, user.id, text, now, side);
    } catch (error) {
      if (!/constraint/i.test(String(error?.message))) throw error;
      const existing = q.commentById.get(id);
      if (!existing) throw error;
      if (existing.user_id !== user.id || existing.task_id !== taskId || existing.side !== side || existing.body !== text) {
        fail(409, '留言编号冲突，请重新提交');
      }
      row = { ...existing, username: user.name }; // Idempotent replay of the stored comment.
    }
    withStatus(ctx.res, 201);
    return { comment: publicComment(row, roundId) };
  });

  // ---- reactions -----------------------------------------------------------------

  function reactionCounts(taskId, onlyMid = null) {
    const counts = {}, round = roundOfTask(taskId);
    for (const row of q.reactionCounts.all(taskId)) {
      const kind = EMOJI_KIND[row.emoji];
      const mid = kind ? midOfWorkId(round, row.work_id) : null;
      if (!mid || (onlyMid && mid !== onlyMid)) continue;
      (counts[mid] ??= { up: 0, down: 0, laugh: 0 })[kind] += row.n;
    }
    return counts;
  }

  router.on('GET', '/api/reactions', (ctx) => {
    const promptId = String(ctx.url.searchParams.get('prompt') ?? '');
    if (!published(promptId)) fail(400, '题目不存在');
    const taskId = taskOfRound(promptId);
    const mine = {};
    if (ctx.user) {
      for (const row of q.myReactions.all(taskId, ctx.user.id)) {
        const kind = EMOJI_KIND[row.emoji];
        const mid = kind ? midOfWorkId(promptId, row.work_id) : null;
        if (mid) mine[mid] = kind;
      }
    }
    return { counts: reactionCounts(taskId), mine };
  });

  router.on('POST', '/api/reactions', async (ctx) => {
    const user = ctx.user ?? fail(401, '请先登录再表态。');
    if (!user.email) fail(403, '请先绑定邮箱', 'email_required');
    write(user.id);
    const body = await readJson(ctx.req);
    const id = String(body.id ?? '');
    if (!UUID4.test(id)) fail(400, '表态编号无效');
    const promptId = String(body.promptId ?? '');
    if (!published(promptId)) fail(400, '题目不存在');
    const taskId = taskOfRound(promptId);
    const mid = trim64(body.mid);
    const work = mid ? workOf(taskId, mid) : null;
    if (!work) fail(400, '作品不存在');
    const kind = body.kind == null ? null : String(body.kind);
    if (kind !== null && !REACTION_EMOJI[kind]) fail(400, '表态类型无效');

    // One state per (user, work) slot: cancelling clears all three mapped emoji, switching
    // removes the other two; re-sending the same kind keeps the original created_at.
    transaction(db, () => {
      if (kind === null) q.dropMapped.run(taskId, work.up, user.id);
      else {
        for (const [other, emoji] of Object.entries(REACTION_EMOJI)) {
          if (other !== kind) q.dropEmoji.run(taskId, work.up, user.id, emoji);
        }
        q.addReaction.run(taskId, work.up, user.id, REACTION_EMOJI[kind], Date.now());
      }
    });
    withStatus(ctx.res, 201);
    return { mine: { [mid]: kind }, counts: { [mid]: reactionCounts(taskId, mid)[mid] ?? { up: 0, down: 0, laugh: 0 } } };
  });

  // ---- tracking --------------------------------------------------------------------

  // ip_hash = sha256(每日随机盐:ip)：salt lives only in memory and rotates with the
  // UTC+8 calendar day that also keys the page_views.day column.
  let daily = { day: '', salt: '' };
  const saltOf = (day) => {
    if (daily.day !== day) daily = { day, salt: randomBytes(16).toString('hex') };
    return daily.salt;
  };

  router.on('POST', '/api/track', async (ctx) => {
    try {
      track(ctx.ip);
      let body = {};
      try { body = await readJson(ctx.req); } catch { body = {}; }
      const path = String(body?.path ?? '');
      const roundPath = /^\/(?:#(?:arena|formal)|vote)\/(\d{3})$/.exec(path);
      const knownPath = ['/', '/admin.html', '/#home', '/#play', '/#event', '/#guess', '/#prompts', '/#rank', '/#rank/formal', '/#arena', '/#random', '/#terms', '/#privacy'].includes(path)
        || (roundPath && published(roundPath[1]));
      if (knownPath) {
        const now = Date.now();
        const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
        q.pageView.run(day, path, sha256(`${saltOf(day)}:${ctx.ip}`), now);
      }
    } catch { /* tracking is best-effort and never leaks an error */ }
    withStatus(ctx.res, 204);
    return { ok: true };
  });
}
