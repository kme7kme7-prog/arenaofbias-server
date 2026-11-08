// Read-only report using the same ballot attribution and moderation as public boards.
// Usage: DIST_DIR=... DATA_DIR=... node scripts/estimate-task-spread.mjs [database]
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { config, limits } from '../server/config.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { createQuestions } from '../server/questions.mjs';
import { createLibrary } from '../server/library.mjs';
import { createArena } from '../server/arena.mjs';
import { isAiJudgedTask } from '../server/categories.mjs';

const database = process.argv[2] ?? join(config.dataDir, 'platform.db');
const dataDir = dirname(database);
// Library's existing-directory initialization must not create anything in a report run.
for (const dir of ['drafts', 'works', 'media']) {
  if (!existsSync(join(dataDir, dir))) throw new Error(`Missing existing data directory: ${dir}`);
}
const db = new DatabaseSync(database, { readOnly: true });
try {
  db.exec('BEGIN'); // One consistent read transaction across every task.
  const catalog = createCatalog(config.dist, createQuestions(db));
  catalog.refresh();
  const legacy = JSON.parse(readFileSync(new URL('../server/show1/compat-data.json', import.meta.url)));
  const library = createLibrary({ db, catalog, config: { ...config, dataDir }, limits,
    legacyRounds: new Set(legacy.works.map(w => w.promptId)), maintenance: false });
  const arena = createArena({ db, catalog, library, limits, maintenance: false });
  const tasks = [];
  for (const task of catalog.tasks().filter(t => !isAiJudgedTask(t))) {
    const board = await arena.leaderboard({ task: task.id, by: 'model', weightedTrial: true });
    tasks.push({ id: task.id, votes: board.totals.votes, rows: board.rows.filter(r => r.games >= 21) });
  }
  tasks.sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  const selected = tasks.slice(0, 36), models = new Map();
  for (const task of selected) for (const row of task.rows) {
    if (!models.has(row.key)) models.set(row.key, []);
    models.get(row.key).push(row);
  }
  const estimates = [...models].filter(([, rows]) => rows.length >= 8).map(([key, rows]) => {
    const mean = rows.reduce((s, r) => s + r.score, 0) / rows.length;
    const observed = rows.reduce((s, r) => s + (r.score - mean) ** 2, 0) / (rows.length - 1);
    const noise = rows.reduce((s, r) => s + (r.interval / 1.96) ** 2, 0) / rows.length;
    return { key, tasks: rows.length, variance: Math.max(0, observed - noise) };
  });
  const variances = estimates.map(r => r.variance).sort((a, b) => a - b), n = variances.length;
  const spread = n ? Math.sqrt(n % 2 ? variances[(n - 1) / 2] : (variances[n / 2 - 1] + variances[n / 2]) / 2) : null;
  console.log(JSON.stringify({ tasks: selected.map(({ id, votes }) => ({ id, votes })), models: estimates,
    spread, configured: limits.board.taskSpread, changeSuggested: spread == null ? null : Math.abs(spread - limits.board.taskSpread) > 10,
    methodology: 'Weighted public model task fits; at least 21 games per task and 8 tasks per model; median nonnegative variance after subtracting vote noise.' }, null, 2));
} finally { db.close(); }
