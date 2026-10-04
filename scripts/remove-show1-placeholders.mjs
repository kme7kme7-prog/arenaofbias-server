// Offline maintenance: stop the service before --apply, then restart.
// Only the three retired Show1 placeholder tasks are eligible for this cleanup.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from '../server/db.mjs';

const tasks = ['show1-002', 'show1-003', 'show1-006'];
const tables = ['votes', 'matches', 'comments', 'reactions', 'drafts',
  'work_overrides', 'task_editorial', 'featured_picks', 'featured_refreshes',
  'curated_content_keys', 'question_overrides', 'works'];
const usage = 'Usage: remove-show1-placeholders.mjs --db <platform.db> [--apply --backup <new.db> --actor <name>]';
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') options.apply = true;
  else if (['--db', '--backup', '--actor'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'))
    options[args[i].slice(2)] = args[++i];
  else throw new Error(usage);
}
if (!options.db || !existsSync(options.db)) throw new Error(usage);
if (options.apply && (!options.backup || !options.actor)) throw new Error(usage);
const database = resolve(options.db);
const backup = options.backup ? resolve(options.backup) : null;
if (options.apply && existsSync(backup)) throw new Error('The backup path must be new');
const db = new DatabaseSync(database, { readOnly: !options.apply });
try {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  // These tasks exist only in the retired compatibility seed, never the shared catalog.
  if (db.prepare('SELECT COUNT(*) AS n FROM questions WHERE id IN (?, ?, ?)').get(...tasks).n)
    throw new Error('Unexpected shared question records: inspect before deleting');
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const selected = tables.filter(table => present.has(table));
  const counts = () => Object.fromEntries(selected.map(table => [table,
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id IN (?, ?, ?)`).get(...tasks).n]));
  const before = counts();
  if (!options.apply) console.log(JSON.stringify({ database, apply: false, tasks, before }));
  else {
    mkdirSync(dirname(backup), { recursive: true });
    db.prepare('VACUUM INTO ?').run(backup);
    transaction(db, () => {
      for (const table of selected) db.prepare(`DELETE FROM ${table} WHERE task_id IN (?, ?, ?)`).run(...tasks);
      db.prepare(`INSERT INTO audit (at, actor_name, action, detail)
        VALUES (?, ?, 'show1-placeholders-remove', ?)`)
        .run(Date.now(), options.actor, JSON.stringify({ tasks, before, backup }));
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
    });
    console.log(JSON.stringify({ database, backup, apply: true, tasks, before, after: counts() }));
  }
} finally { db.close(); }
