// Offline maintenance: stop the server before --apply, then restart with the new
// code so retired snapshot ballots stay excluded. No database is selected implicitly.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resetVotes, voteResetCounts } from '../server/vote-reset.mjs';

const usage = 'Usage: reset-votes.mjs --db <platform.db> [--apply --backup <new-backup.db> --actor <name>]';
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--apply') options.apply = true;
  else if (['--db', '--backup', '--actor'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--'))
    options[flag.slice(2)] = args[++i];
  else throw new Error(usage);
}
if (!options.db || !existsSync(options.db)) throw new Error(`An existing database is required. ${usage}`);
if (options.apply && (!options.backup || !options.actor)) throw new Error(usage);
const database = resolve(options.db);
const backup = options.backup ? resolve(options.backup) : null;
if (options.apply && existsSync(backup)) throw new Error('The backup path must be new');
const db = new DatabaseSync(database, { readOnly: !options.apply });
try {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  if (!options.apply) console.log(JSON.stringify({ database, apply: false, ...voteResetCounts(db) }));
  else {
    mkdirSync(dirname(backup), { recursive: true });
    // VACUUM INTO includes committed WAL contents; copying just platform.db would not.
    db.prepare('VACUUM INTO ?').run(backup);
    const before = resetVotes(db, options.actor, backup);
    console.log(JSON.stringify({ database, backup, apply: true, before, after: voteResetCounts(db) }));
  }
} finally { db.close(); }
