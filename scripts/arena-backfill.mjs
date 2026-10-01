// Offline maintenance: stop the service before --apply and restart afterward to
// invalidate leaderboard caches. Dry runs open the database read-only, without migrations.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCatalog } from '../server/catalog.mjs';
import { applyArenaBackfill, planArenaBackfill } from '../server/arena-backfill.mjs';

const usage = 'Usage: arena-backfill.mjs --db <platform.db> --dist <datapack-dir> [--exclude task/id,...] [--apply --backup <new-backup.db> --actor <name>]';
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--apply') options.apply = true;
  else if (['--db', '--dist', '--exclude', '--backup', '--actor'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--'))
    options[flag.slice(2)] = args[++i];
  else throw new Error(usage);
}
if (!options.db || !existsSync(options.db) || !options.dist) throw new Error(usage);
if (options.apply && (!options.backup || !options.actor)) throw new Error(usage);
const database = resolve(options.db);
const backup = options.backup ? resolve(options.backup) : null;
if (options.apply && existsSync(backup)) throw new Error('The backup path must be new');
const exclude = new Set((options.exclude ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const db = new DatabaseSync(database, { readOnly: !options.apply });
try {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (options.apply && schemaVersion < 19) throw new Error('Apply requires schema v19 or later; upgrade the schema manually before applying. Dry-run does not migrate.');
  // Maintenance needs task membership only, including old-schema dry runs; no user DTOs.
  const questions = db.prepare('SELECT * FROM questions').all().filter((row) => !row.deleted_at).map((row) => ({
    ...row, templates: JSON.parse(row.templates), moderation: JSON.parse(row.moderation ?? '{"status":"legacy"}'),
  }));
  const publicQuestion = (row) => ['legacy', 'approved'].includes(row.moderation.status);
  const catalog = createCatalog(resolve(options.dist), {
    all: () => questions.filter(publicQuestion),
    get: (id, viewer) => questions.find((row) => row.id === id && (viewer?.role === 'admin' || publicQuestion(row))) ?? null,
  });
  if (options.apply) {
    mkdirSync(dirname(backup), { recursive: true });
    db.prepare('VACUUM INTO ?').run(backup);
  }
  const plan = options.apply ? applyArenaBackfill(db, catalog, { exclude, actor: options.actor, backup }) : planArenaBackfill(db, catalog, exclude);
  const { changes, ...summary } = plan;
  console.log(JSON.stringify({ database, schemaVersion, minimumApplySchema: 19, datapack: catalog.version, apply: Boolean(options.apply),
    ...(options.apply ? { backup, cache: 'Restart the stopped service to invalidate leaderboard caches; poolStats reads live state.' } : {}),
    changedCount: changes.length, ...summary }, null, 2));
} finally { db.close(); }
