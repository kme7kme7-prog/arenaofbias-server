// One-time Show1 import. The source database is always opened read-only.
// Run --dry-run first; --apply requires a v7 (or later, e.g. post-compat v8) target.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HASH_PARAMS = JSON.stringify({ N: 32768, r: 8, p: 1, keylen: 64 });
// Temporary display equivalents. Show1 can switch to these same emoji later.
const REACTION_EMOJI = { up: '👍', down: '👀', laugh: '🤯' };
const SPLIT_MODELS = {
  'claude-fable-5.x': { 'Claude Fable 5.1': 'claude-fable-5.1', 'Claude Fable 5': 'claude-fable-5', 'Claude Fable 5.2 Max': 'claude-fable-5.2' },
  'claude-opus-5.x': { 'Claude Opus 5': 'claude-opus-5', 'Claude Opus 5.5?': 'claude-opus-5.5' },
  'muse-spark-1.3': { 'Muse Spark 1.3': 'muse-spark-1.3', 'Muse Spark 1.2': 'muse-spark-1.2' },
  'gemini-3.8-flash': { 'Gemini 3.8 Flash': 'gemini-3.8-flash', 'Gemini 3.7 Flash': 'gemini-3.7-flash' },
};
const TABLES = ['users', 'prompts', 'works', 'votes', 'comments', 'reactions', 'sessions', 'page_views', 'auth_limits', 'email_codes', 'guess_results'];
const OMITTED = {
  sessions: '旧会话不适用于新平台的令牌与 Cookie 策略，用户重新登录',
  page_views: '访问流水不属于新平台持久业务数据',
  auth_limits: '限流窗口是短期状态，不能跨平台续用',
  email_codes: '验证码短期有效且目标认证流程尚未接入',
  guess_results: '猜模型功能及目标表尚未实现',
};

const sha = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const promptText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const inside = (base, path) => path === base || path.startsWith(base + sep);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function optionsFrom(argv) {
  const options = { dryRun: true };
  const keys = { '--source-db': 'sourceDb', '--target-db': 'targetDb', '--source-works': 'sourceWorks', '--datapack': 'datapack', '--models': 'models', '--prompts': 'prompts', '--out-dir': 'outDir' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--apply') options.dryRun = false;
    else if (keys[arg] && argv[i + 1]) options[keys[arg]] = resolve(argv[++i]);
    else throw new Error(`未知或缺少参数：${arg}`);
  }
  for (const key of ['sourceDb', 'targetDb', 'sourceWorks', 'datapack', 'models', 'prompts', 'outDir']) {
    if (!options[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return options;
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function saveJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function mappedId(kind, oldId) {
  const digest = sha(`show1:${kind}:${oldId}`);
  // users/matches/votes/comments take plain hex; works keep the readable up- prefix.
  if (kind === 'work') return `up-${(BigInt(`0x${digest.slice(0, 16)}`) % (36n ** 8n)).toString(36).padStart(8, '0')}`;
  return digest.slice(0, 16);
}
function savedMap(path, computed) {
  if (existsSync(path)) {
    const previous = readJson(path);
    for (const [oldId, id] of Object.entries(previous)) {
      if (computed[oldId] && computed[oldId] !== id) throw new Error(`${basename(path)} 中 ${oldId} 的 ID 与确定性映射不符`);
    }
  }
  saveJson(path, computed);
}
function addIssue(report, table, sourceId, reason, detail = {}, blocking = false) {
  report.issues.push({ table, sourceId, reason, ...detail, blocking });
  report.tables[table].ambiguous++;
}
function modelResolver(registry) {
  const byId = new Map();
  const aliases = new Map();
  for (const parent of registry.models) for (const model of [parent, ...(parent.variants ?? [])]) {
    byId.set(model.id, { ...model, vendor: model.vendor ?? parent.vendor ?? '' });
    for (const alias of [model.id, ...(model.aliases ?? [])]) {
      const set = aliases.get(alias) ?? new Set();
      set.add(model.id);
      aliases.set(alias, set);
    }
  }
  return (oldId, oldName) => {
    // mimo-x-flash deliberately has no special case: unresolved models are imported with
    // model_id = NULL and flagged 待确认 in the report instead of being dropped.
    const split = SPLIT_MODELS[oldId];
    const ids = split ? [split[oldName]].filter(Boolean) : [...(aliases.get(oldId) ?? [])];
    return ids.length === 1 && byId.has(ids[0]) ? byId.get(ids[0]) : null;
  };
}

function sourcePath(root, src) {
  if (typeof src !== 'string' || !src.startsWith('/works/') || src.includes('?') || src.includes('#')) throw new Error('src 不是本地 /works/ 文件路径');
  const parts = src.slice('/works/'.length).split('/').map(decodeURIComponent);
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('/'))) throw new Error('src 路径不安全');
  const roots = [root, resolve(root, '..', '..', 'public', 'works')];
  for (const base of roots) {
    const full = resolve(base, ...parts);
    if (inside(base, full) && existsSync(full) && inside(realpathSync(base), realpathSync(full))) return full;
  }
  throw new Error('源文件不存在或越过作品目录');
}
function treeFiles(root) {
  const files = [];
  function visit(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('作品目录含符号链接');
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) files.push({ source: full, path: relative(root, full).replaceAll('\\', '/') });
      else throw new Error('作品目录含不支持的文件类型');
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function workContent(row, content, sourceWorks) {
  if (!content || typeof content !== 'object') throw new Error('content JSON 不是对象');
  let files;
  if (content.kind === 'html') {
    if (typeof content.html === 'string') files = [{ path: 'index.html', data: Buffer.from(content.html) }];
    else {
      const source = sourcePath(sourceWorks, content.src);
      if (!/\.html?$/i.test(source)) throw new Error('HTML 入口不是 .html 文件');
      if (basename(source).toLowerCase() === 'index.html') files = treeFiles(dirname(source));
      else files = [{ path: 'index.html', source }];
    }
  } else if (content.kind === 'text') {
    const story = content.story;
    if (!story || !Array.isArray(story.paragraphs) || story.paragraphs.some((part) => typeof part !== 'string')) throw new Error('文字作品 story 结构无效');
    const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(row.title)}</title><style>body{max-width:48rem;margin:3rem auto;padding:0 1.5rem;background:#f6f1e8;color:#29251e;font:1.15rem/1.9 system-ui,sans-serif}h1{font-size:1.5rem}p{white-space:pre-wrap}footer{margin-top:3rem;opacity:.7}</style><main>${story.heading ? `<h1>${escapeHtml(story.heading)}</h1>` : ''}${story.paragraphs.map((part) => `<p>${escapeHtml(part)}</p>`).join('')}${story.ending ? `<footer>${escapeHtml(story.ending)}</footer>` : ''}</main></html>`;
    files = [{ path: 'index.html', data: Buffer.from(html) }];
  } else if (content.kind === 'image') {
    const source = sourcePath(sourceWorks, content.src);
    const ext = extname(source).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'].includes(ext)) throw new Error('图片格式不支持');
    const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(row.title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171717}img{max-width:100%;max-height:100vh}</style><img src="image${ext}" alt="${escapeHtml(content.alt ?? row.title)}"></html>`;
    files = [{ path: 'index.html', data: Buffer.from(html) }, { path: `image${ext}`, source }];
  } else if (content.kind === 'web' && ['a', 'b'].includes(content.template)) {
    // These two early works were React components in Show1, not standalone uploads.
    const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${escapeHtml(row.title)}</title><body><h1>${escapeHtml(row.title)}</h1><p>旧版网页模板 ${content.template} 的独立作品文件正在补齐中，当前为占位页。</p></body></html>`;
    files = [{ path: 'index.html', data: Buffer.from(html) }];
  } else throw new Error(`content.kind=${String(content.kind)} 无独立作品文件`);
  if (!files.some((file) => file.path === 'index.html')) throw new Error('作品目录没有 index.html');
  const digest = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const data = file.data ?? readFileSync(file.source);
    bytes += data.length;
    digest.update(file.path).update('\0').update(data);
  }
  return { files, bytes, digest: digest.digest('hex') };
}

function makeReport(source, target, options) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, {
    source: source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    planned: 0, existing: 0, skipped: 0, ambiguous: 0, conflict: 0,
  }]));
  return {
    mode: options.dryRun ? 'dry-run' : 'apply',
    status: 'planned',
    sourceDb: options.sourceDb,
    targetDb: options.targetDb,
    targetVersion: target.prepare('PRAGMA user_version').get().user_version,
    tables,
    taskMap: {},
    reactionEmoji: REACTION_EMOJI,
    demoWorks: [],
    issues: [],
    omitted: OMITTED,
  };
}

function planMigration(source, target, options) {
  const report = makeReport(source, target, options);
  if (report.targetVersion < 7) throw new Error(`目标库 user_version=${report.targetVersion}，需要含隐藏待审字段的 v7 或更新`);
  // Placeholder matches are derived from source votes one-to-one; keep a sibling counter.
  const tables = {};
  for (const [name, counts] of Object.entries(report.tables)) {
    if (name === 'votes') tables.matches = { source: counts.source, planned: 0, existing: 0, skipped: 0, ambiguous: 0, conflict: 0 };
    tables[name] = counts;
  }
  report.tables = tables;
  const data = readJson(statSync(options.datapack).isDirectory() ? join(options.datapack, 'data.json') : options.datapack);
  const registry = readJson(options.models);
  const promptSummary = readJson(options.prompts);
  const targetTasks = new Map(data.tasks.map((task) => [task.id, task]));
  const promptHeads = new Map(promptSummary.map((prompt) => [prompt.id, prompt]));
  const resolveModel = modelResolver(registry);
  const userRows = source.prepare('SELECT * FROM users ORDER BY id').all();
  const promptRows = source.prepare('SELECT * FROM prompts ORDER BY id').all();
  const workRows = source.prepare('SELECT * FROM works ORDER BY id').all();
  const reactionRows = source.prepare('SELECT * FROM reactions ORDER BY id').all();
  // Votes in chronological order so that on a (user_id, pair_key) clash the earliest vote wins.
  const voteRows = source.prepare('SELECT * FROM votes ORDER BY created_at, id').all();
  const commentRows = source.prepare('SELECT * FROM comments ORDER BY created_at, id').all();
  const userMap = Object.fromEntries(userRows.map((row) => [row.id, mappedId('user', row.id)]));
  const workMap = Object.fromEntries(workRows.map((row) => [row.id, mappedId('work', row.id)]));
  const contentMapPath = join(options.outDir, 'content-map.json');
  const contentMap = existsSync(contentMapPath) ? readJson(contentMapPath) : {};
  const weights = {};
  const users = [], works = [], reactions = [], matches = [], votes = [], comments = [];
  const taskMap = new Map();
  const targetUserById = target.prepare('SELECT id, name_key FROM users WHERE id = ?');
  const targetUserByKey = target.prepare('SELECT id FROM users WHERE name_key = ?');
  const targetWorkById = target.prepare('SELECT id, task_id, model_id, title, digest, content_key FROM works WHERE id = ?');
  const targetWorkByKey = target.prepare('SELECT id FROM works WHERE content_key = ?');
  const targetReaction = target.prepare('SELECT 1 FROM reactions WHERE task_id = ? AND work_id = ? AND user_id = ? AND emoji = ?');
  const targetMatchById = target.prepare('SELECT id FROM matches WHERE id = ?');
  const targetVoteById = target.prepare('SELECT id FROM votes WHERE id = ?');
  const targetVoteByPair = target.prepare('SELECT id FROM votes WHERE user_id = ? AND pair_key = ?');
  const targetCommentById = target.prepare('SELECT id FROM comments WHERE id = ?');

  for (const row of promptRows) {
    const head = promptHeads.get(row.id);
    if (!head || !promptText(row.prompt).startsWith(promptText(head.prompt_head).slice(0, 60))) {
      addIssue(report, 'prompts', row.id, '题目摘要与源库正文不符', {}, true);
      continue;
    }
    const taskId = row.id === '004' ? 'chinese-architecture' : `show1-${row.id}`;
    if (row.id === '004' && !targetTasks.has(taskId)) {
      addIssue(report, 'prompts', row.id, '004 在目标数据包中缺少已确认的同题', { taskId }, true);
      continue;
    }
    if (!targetTasks.has(taskId)) addIssue(report, 'prompts', row.id, '作品可入库；公开展示前需在数据包中补齐题目定义', { taskId });
    taskMap.set(row.id, taskId);
    report.taskMap[row.id] = taskId;
    report.tables.prompts.skipped++; // Prompt definitions remain in the data repository.
    let parsed;
    try { parsed = JSON.parse(row.weights ?? head.weights); } catch { /* reported below */ }
    if (!Array.isArray(parsed) || parsed.length !== 6 || !parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      addIssue(report, 'prompts', row.id, '六维权重不是六个有限数', {}, true);
    } else if (weights[taskId] && JSON.stringify(weights[taskId]) !== JSON.stringify(parsed)) {
      addIssue(report, 'prompts', row.id, '多个旧题映射同一目标题但权重不同', { taskId }, true);
    } else weights[taskId] = parsed;
  }

  const usedUserIds = new Set();
  const usedNameKeys = new Set();
  const validUserIds = new Set();
  for (const row of userRows) {
    const id = userMap[row.id];
    const nameKey = normalize(row.username);
    const match = /^scrypt:([0-9a-f]+):([0-9a-f]+)$/i.exec(row.password_hash ?? '');
    if (!nameKey || !match || match[2].length !== 128 || (row.role && !['member', 'admin'].includes(row.role))) {
      addIssue(report, 'users', row.id, '用户名、角色或旧密码格式无效', {}, true);
      continue;
    }
    if (usedUserIds.has(id)) {
      report.tables.users.conflict++;
      addIssue(report, 'users', row.id, '新用户 ID 碰撞', { targetId: id }, true);
      continue;
    }
    if (usedNameKeys.has(nameKey)) {
      report.tables.users.conflict++;
      addIssue(report, 'users', row.id, '源库用户名规范化后发生冲突', { nameKey }, true);
      continue;
    }
    usedUserIds.add(id);
    usedNameKeys.add(nameKey);
    const existing = targetUserById.get(id);
    const sameName = targetUserByKey.get(nameKey);
    if ((existing && existing.name_key !== nameKey) || (sameName && sameName.id !== id)) {
      report.tables.users.conflict++;
      addIssue(report, 'users', row.id, '目标用户名或 ID 已被其他账号占用', { targetId: id }, true);
      continue;
    }
    validUserIds.add(id);
    if (existing) { report.tables.users.existing++; continue; }
    users.push({ id, name: row.username, nameKey, role: row.role === 'admin' ? 'admin' : 'member', salt: match[1], hash: match[2], createdAt: row.created_at });
    report.tables.users.planned++;
  }

  const usedWorkIds = new Set();
  const sourceWorkIndex = new Map();
  for (const row of workRows) {
    if (row.is_demo) report.demoWorks.push({ id: row.id, promptId: row.prompt_id, modelId: row.model_id });
    const taskId = taskMap.get(row.prompt_id);
    if (!taskId) {
      report.tables.works.skipped++;
      addIssue(report, 'works', row.id, '所属题目未映射', { promptId: row.prompt_id }, true);
      continue;
    }
    if (row.published !== 1) addIssue(report, 'works', row.id, '旧作品在 Show1 未发布，仍随迁移 verified 上架', { promptId: row.prompt_id });
    // Unresolvable models (e.g. mimo-x-flash) keep the work: model_id is stored NULL,
    // model_other keeps the source text, and the row is flagged 待确认 in the report.
    const model = resolveModel(row.model_id, row.model_name);
    if (!model) addIssue(report, 'works', row.id, '模型无法按终版映射唯一归一，待确认：model_id 置空、model_other 保留原值', { modelId: row.model_id, modelName: row.model_name });
    const modelId = model?.id ?? null;
    let content, payload;
    try {
      content = JSON.parse(row.content);
      payload = workContent(row, content, options.sourceWorks);
    } catch (error) {
      report.tables.works.skipped++;
      addIssue(report, 'works', row.id, '作品内容无法独立迁移', { detail: error.message }, true);
      continue;
    }
    const id = workMap[row.id];
    const existing = targetWorkById.get(id);
    const key = contentMap[row.id] ?? existing?.content_key ?? `w${randomBytes(16).toString('hex')}`;
    contentMap[row.id] = key;
    if (usedWorkIds.has(id)) {
      report.tables.works.conflict++;
      addIssue(report, 'works', row.id, '新作品 ID 碰撞', { targetId: id }, true);
      continue;
    }
    usedWorkIds.add(id);
    const keyOwner = targetWorkByKey.get(key);
    if ((existing && (existing.task_id !== taskId || (existing.model_id ?? null) !== modelId || existing.title !== row.title || existing.digest !== payload.digest || existing.content_key !== key)) || (keyOwner && keyOwner.id !== id)) {
      report.tables.works.conflict++;
      addIssue(report, 'works', row.id, '目标作品 ID 或 content_key 已被不同内容占用', { targetId: id }, true);
      continue;
    }
    const calibration = {};
    if (content.framing != null) calibration.framing = content.framing;
    if (content.camera != null) calibration.camera = content.camera;
    const work = { id, taskId, modelId, modelName: row.model_name, vendor: model?.vendor ?? '', title: row.title,
      key, payload, manualFile: content.kind === 'web', trial: Object.keys(calibration).length ? { calibration } : {}, createdAt: row.created_at };
    if (content.kind === 'web') addIssue(report, 'works', row.id, '旧 React 模板已用占位页上架，须补齐独立作品文件后替换', { template: content.template });
    sourceWorkIndex.set(row.id, { row, work });
    if (existing) { report.tables.works.existing++; continue; }
    works.push(work);
    report.tables.works.planned++;
  }

  const byPromptMid = new Map();
  for (const { row, work } of sourceWorkIndex.values()) {
    const key = `${row.prompt_id}\0${row.model_id}`;
    const list = byPromptMid.get(key) ?? [];
    list.push(work);
    byPromptMid.set(key, list);
  }
  // Shared mid → migrated work resolution (reactions and comments): several works may share
  // one legacy model id; the first by new-work-id order wins and the ambiguity is reported.
  const worksOfMid = (promptId, mid) => byPromptMid.get(`${promptId}\0${mid}`) ?? [];
  const pickWork = (table, sourceId, matching) => {
    if (matching.length > 1) addIssue(report, table, sourceId, '多个作品共享旧模型 ID，按作品 ID 排序取首个', { workCandidates: matching.map((work) => work.id) });
    return matching.map((work) => work.id).sort()[0];
  };
  const plannedReactions = new Set();
  for (const row of reactionRows) {
    const matching = worksOfMid(row.prompt_id, row.mid);
    const emoji = REACTION_EMOJI[row.kind];
    const taskId = taskMap.get(row.prompt_id);
    const userId = userMap[row.user_id];
    if (!taskId || !matching.length || !userId || !validUserIds.has(userId) || !emoji) {
      report.tables.reactions.skipped++;
      addIssue(report, 'reactions', row.id, '反应缺少作品、用户、题目或表情映射', {
        promptId: row.prompt_id, mid: row.mid, kind: row.kind, workCandidates: matching.map((work) => work.id),
      });
      continue;
    }
    const workId = pickWork('reactions', row.id, matching);
    const key = `${taskId}\0${workId}\0${userId}\0${emoji}`;
    if (plannedReactions.has(key)) { report.tables.reactions.skipped++; continue; }
    plannedReactions.add(key);
    if (targetReaction.get(taskId, workId, userId, emoji)) { report.tables.reactions.existing++; continue; }
    reactions.push({ taskId, workId, userId, emoji, createdAt: row.created_at });
    report.tables.reactions.planned++;
  }

  // Every source vote becomes one placeholder match plus one legacy vote. The match is
  // decided at creation (created_at = decided_at = expires_at = source created_at); its
  // a/b sides are the winner/loser ordered by the pair_key convention (lexicographically
  // smaller round id on side a), so the choice follows from which side won. Works are not
  // resolved: a_work/b_work stay `legacy:<mid>` and the vote carries the raw mids in
  // a_identity/b_identity with source='legacy'.
  const plannedPairs = new Set();
  const skipVote = (row, reason, detail = {}, blocking = false) => {
    report.tables.votes.skipped++;
    report.tables.matches.skipped++;
    addIssue(report, 'votes', row.id, reason, detail, blocking);
  };
  for (const row of voteRows) {
    const taskId = taskMap.get(row.prompt_id);
    if (!taskId) {
      skipVote(row, '所属题目未映射', { promptId: row.prompt_id }, true);
      continue;
    }
    let userId = null;
    if (row.user_id != null) {
      userId = userMap[row.user_id];
      if (!userId || !validUserIds.has(userId)) {
        skipVote(row, '投票用户无效或未迁入', { userId: row.user_id });
        continue;
      }
    }
    if (row.outcome !== 'win' && row.outcome !== 'draw') {
      skipVote(row, '未知 outcome，无法推出胜负', { outcome: row.outcome });
      continue;
    }
    const aWins = row.winner_rid < row.loser_rid;
    const midA = aWins ? row.winner_mid : row.loser_mid;
    const midB = aWins ? row.loser_mid : row.winner_mid;
    const choice = row.outcome === 'draw' ? 'tie' : aWins ? 'a' : 'b';
    const matchId = mappedId('match', row.id);
    const voteId = mappedId('vote', row.id);
    if (targetMatchById.get(matchId) || targetVoteById.get(voteId)) {
      report.tables.matches.existing++;
      report.tables.votes.existing++;
      continue;
    }
    // Target votes enforce UNIQUE (user_id, pair_key); SQLite lets NULL user_id through,
    // so anonymous votes are never deduplicated, only kept idempotent via their row id.
    if (userId) {
      const pairScope = `${userId}\0${row.pair_key}`;
      const clash = plannedPairs.has(pairScope) ? null : targetVoteByPair.get(userId, row.pair_key);
      if (plannedPairs.has(pairScope) || clash) {
        report.tables.votes.conflict++;
        report.tables.matches.conflict++;
        addIssue(report, 'votes', row.id, '同一用户同一 pair_key 已有一票，保留先到的一票', { pairKey: row.pair_key, keptId: clash?.id ?? null });
        continue;
      }
      plannedPairs.add(pairScope);
    }
    matches.push({
      id: matchId, userId, taskId, aWork: `legacy:${midA}`, bWork: `legacy:${midB}`,
      aToken: `w${sha(`show1:match-token:${row.id}:a`).slice(0, 32)}`,
      bToken: `m${sha(`show1:match-token:${row.id}:b`).slice(0, 32)}`,
      choice, createdAt: row.created_at,
    });
    votes.push({
      id: voteId, matchId, userId, taskId, aWork: `legacy:${midA}`, bWork: `legacy:${midB}`,
      pairKey: row.pair_key, choice, createdAt: row.created_at, aIdentity: midA, bIdentity: midB,
    });
    report.tables.matches.planned++;
    report.tables.votes.planned++;
  }

  // Show1 comments are archived per prompt with the side the commenter backed in the match
  // they had just decided (draws archive to side a). The work on that side is therefore the
  // winner of the commenter's latest vote on that prompt before the comment; the work is
  // then resolved through the same mid → migrated work lookup the reactions use.
  const votesByUserPrompt = new Map();
  for (const row of voteRows) {
    if (row.user_id == null) continue;
    const key = `${row.user_id}\0${row.prompt_id}`;
    const list = votesByUserPrompt.get(key) ?? [];
    list.push(row);
    votesByUserPrompt.set(key, list);
  }
  for (const row of commentRows) {
    const skipComment = (reason, detail = {}, blocking = false) => {
      report.tables.comments.skipped++;
      addIssue(report, 'comments', row.id, reason, detail, blocking);
    };
    const taskId = taskMap.get(row.round_id);
    if (!taskId) {
      skipComment('所属题目未映射', { roundId: row.round_id }, true);
      continue;
    }
    if (row.side !== 'a' && row.side !== 'b') {
      skipComment('侧位不是 a/b', { side: row.side });
      continue;
    }
    if (!row.body || !row.body.trim()) {
      skipComment('评论正文为空');
      continue;
    }
    if (row.user_id == null) {
      skipComment('评论没有 user_id，按迁移规则跳过');
      continue;
    }
    const userId = userMap[row.user_id];
    if (!userId || !validUserIds.has(userId)) {
      skipComment('评论用户无效或未迁入', { userId: row.user_id });
      continue;
    }
    const history = votesByUserPrompt.get(`${row.user_id}\0${row.round_id}`) ?? [];
    let decided = null;
    for (const vote of history) {
      if (vote.created_at <= row.created_at) decided = vote;
      else break;
    }
    if (!decided) {
      skipComment('评论之前找不到该用户在本题的对局，无法定位侧位作品', { roundId: row.round_id, side: row.side });
      continue;
    }
    if (decided.outcome !== 'win') {
      skipComment('评论前最近的对局不是胜局（平局没有站队侧），无法确定侧位作品', { voteId: decided.id, outcome: decided.outcome });
      continue;
    }
    const matching = worksOfMid(row.round_id, decided.winner_mid);
    if (!matching.length) {
      skipComment('侧位模型没有已迁入的作品', { mid: decided.winner_mid, voteId: decided.id });
      continue;
    }
    const id = mappedId('comment', row.id);
    if (targetCommentById.get(id)) { report.tables.comments.existing++; continue; }
    comments.push({ id, taskId, workId: pickWork('comments', row.id, matching), userId, body: row.body, createdAt: row.created_at });
    report.tables.comments.planned++;
  }

  for (const table of Object.keys(OMITTED)) report.tables[table].skipped = report.tables[table].source;
  report.manualDecisions = report.issues.filter((issue) => issue.blocking || issue.reason.includes('补齐') ||
    issue.reason.includes('待确认') || issue.reason.startsWith('反应缺少'));
  return { report, userMap, workMap, contentMap, weights, users, works, reactions, matches, votes, comments };
}

function reportMarkdown(report) {
  const lines = [
    `# Show1 数据迁移报告（${report.mode}）`, '',
    `状态：${report.status}；源库：${report.sourceDb}；目标库：${report.targetDb}（schema v${report.targetVersion}）`,
    ...(report.applyError ? [`执行错误：${report.applyError}`] : []), '',
    '| 表 | 源行数 | 拟新增 | 已存在 | 跳过 | 歧义/待办 | 冲突 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.tables).map(([name, n]) => `| ${name} | ${n.source} | ${n.planned} | ${n.existing} | ${n.skipped} | ${n.ambiguous} | ${n.conflict} |`),
    '', '## 题目映射', '', ...Object.entries(report.taskMap).map(([oldId, taskId]) => `- ${oldId} → ${taskId}`),
    '', '## 明确不迁移的表', '', ...Object.entries(report.omitted).map(([name, reason]) => `- ${name}：${reason}`),
    '', '## Demo 作品', '', ...report.demoWorks.map((row) => `- ${row.id}：题目 ${row.promptId}，模型 ${row.modelId}`),
    '', '## 全部歧义与待办', '',
    ...(report.issues.length ? report.issues.map((issue) => `- ${issue.table}/${issue.sourceId}：${issue.reason}；${JSON.stringify(issue)}`) : ['- 无']),
    '', '## 人工决策清单', '',
    ...(report.manualDecisions.length ? report.manualDecisions.map((issue) => `- ${issue.table}/${issue.sourceId}：${issue.reason}`) : ['- 无']),
    '',
  ];
  return lines.join('\n');
}

function writeArtifacts(options, plan) {
  mkdirSync(options.outDir, { recursive: true });
  for (const [name, value] of Object.entries({
    'user-map.json': plan.userMap, 'work-map.json': plan.workMap, 'content-map.json': plan.contentMap,
  })) savedMap(join(options.outDir, name), value);
  for (const [name, value] of Object.entries({
    'prompt-weights.json': plan.weights, 'task-map.json': plan.report.taskMap, 'report.json': plan.report,
  })) saveJson(join(options.outDir, name), value);
  writeFileSync(join(options.outDir, 'report.md'), reportMarkdown(plan.report));
}

function applyPlan(target, options, plan) {
  const worksRoot = join(dirname(options.targetDb), 'works');
  const stage = join(dirname(options.targetDb), `.show1-stage-${process.pid}`);
  if (existsSync(stage)) throw new Error(`暂存目录已存在：${stage}`);
  mkdirSync(stage, { recursive: true });
  const moved = [];
  try {
    for (const work of plan.works) {
      const finalDir = join(worksRoot, work.id);
      if (existsSync(finalDir)) throw new Error(`目标作品目录已存在但数据库没有对应行：${finalDir}`);
      for (const file of work.payload.files) {
        const output = join(stage, work.id, ...file.path.split('/'));
        mkdirSync(dirname(output), { recursive: true });
        if (file.source) copyFileSync(file.source, output);
        else writeFileSync(output, file.data);
      }
    }
    mkdirSync(worksRoot, { recursive: true });
    target.exec('BEGIN IMMEDIATE');
    try {
      const addUser = target.prepare(`INSERT INTO users (id, name, name_key, role, salt, hash, created_at, hash_params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const addWork = target.prepare(`INSERT INTO works (id, task_id, owner_id, title, summary, model_id, model_other,
        effort, note, status, content_key, source_name, root, entry, file_count, bytes, digest,
        checks, trial, created_at, updated_at, show_gallery, show_arena)
        VALUES (?, ?, NULL, ?, '', ?, ?, '', ?, 'verified', ?, ?, '', 'index.html', ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
      const addReaction = target.prepare(`INSERT INTO reactions (task_id, work_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)`);
      const addMatch = target.prepare(`INSERT INTO matches (id, user_id, task_id, a_work, b_work, a_token, b_token, created_at,
        expires_at, choice, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const addVote = target.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice,
        created_at, a_identity, b_identity, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')`);
      const addComment = target.prepare(`INSERT INTO comments (id, task_id, work_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const user of plan.users) addUser.run(user.id, user.name, user.nameKey, user.role, user.salt, user.hash, user.createdAt, HASH_PARAMS);
      for (const work of plan.works) {
        renameSync(join(stage, work.id), join(worksRoot, work.id));
        moved.push(join(worksRoot, work.id));
        const checks = [{ id: 'legacy', state: 'info', label: 'Show1 历史作品', detail: 'Show1 线上审核过的作品，随迁移直接 verified 上架' }];
        if (work.manualFile) checks.push({ id: 'legacy-template', state: 'warn', label: '旧 React 模板', detail: '当前是占位页，须补齐独立作品文件后替换' });
        addWork.run(work.id, work.taskId, work.title, work.modelId, work.modelId ? '' : work.modelName,
          'Show1 历史迁入', work.key, `show1-${work.id}.html`, work.payload.files.length,
          work.payload.bytes, work.payload.digest, JSON.stringify(checks), JSON.stringify(work.trial), work.createdAt, work.createdAt);
      }
      for (const match of plan.matches) addMatch.run(match.id, match.userId, match.taskId, match.aWork, match.bWork,
        match.aToken, match.bToken, match.createdAt, match.createdAt, match.choice, match.createdAt);
      for (const vote of plan.votes) addVote.run(vote.id, vote.matchId, vote.userId, vote.taskId, vote.aWork, vote.bWork,
        vote.pairKey, vote.choice, vote.createdAt, vote.aIdentity, vote.bIdentity);
      for (const comment of plan.comments) addComment.run(comment.id, comment.taskId, comment.workId, comment.userId, comment.body, comment.createdAt);
      for (const reaction of plan.reactions) addReaction.run(reaction.taskId, reaction.workId, reaction.userId, reaction.emoji, reaction.createdAt);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    for (const dir of moved) rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function runMigration(options) {
  mkdirSync(options.outDir, { recursive: true });
  const source = new DatabaseSync(options.sourceDb, { readOnly: true });
  const target = new DatabaseSync(options.targetDb, { readOnly: options.dryRun });
  try {
    target.exec('PRAGMA foreign_keys = ON');
    const plan = planMigration(source, target, options);
    plan.report.status = plan.report.issues.some((issue) => issue.blocking) ? 'needs-input' : 'ready';
    writeArtifacts(options, plan);
    if (!options.dryRun) {
      if (plan.report.status !== 'ready') throw new Error('存在阻塞问题，先查看 report.md 的人工决策清单');
      try {
        applyPlan(target, options, plan);
        plan.report.status = 'applied';
      } catch (error) {
        plan.report.status = 'failed';
        plan.report.applyError = error.message;
        writeArtifacts(options, plan);
        throw error;
      }
      writeArtifacts(options, plan);
    }
    return plan.report;
  } finally {
    source.close();
    target.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = optionsFrom(process.argv.slice(2));
  const report = runMigration(options);
  process.stdout.write(`${report.status}: ${join(options.outDir, 'report.md')}\n`);
}
