// Offline repair for ballots whose work was relabelled before automatic correction
// covered it. Dry-run by default; --apply needs the service stopped and a new backup.
// npm run reconcile:attribution -- --keys "astra-pro|high,astra-pro|max" --expected 80 --actor root [--apply --backup <file>]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { entityKey } from '../server/catalog.mjs';
import { config, limits } from '../server/config.mjs';
import { currentAttribution } from '../server/vote-attribution.mjs';

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') options.apply = true;
  else if (['--keys', '--expected', '--actor', '--backup'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error('Unknown or missing argument');
}
for (const field of ['keys', 'actor']) if (!options[field]) throw new Error(`--${field} is required`);
const keys = new Set(options.keys.split(',').map((key) => key.trim()).filter(Boolean));
if (options.apply && (!options.backup || existsSync(resolve(options.backup)))) throw new Error('--apply requires a new --backup path; stop the service first');
if (options.apply && !Number.isInteger(Number(options.expected))) throw new Error('--apply requires --expected from the dry run');

const platform = createPlatform({ config: { ...config, capture: false }, limits });
try {
  const { db, library, arena } = platform;
  const admin = db.prepare('SELECT id, name, role FROM users WHERE name = ?').get(options.actor);
  if (admin?.role !== 'admin') throw new Error('An existing administrator is required');
  const repairs = [];
  const unresolved = [];
  for (const row of db.prepare("SELECT * FROM votes WHERE source = 'arena' AND json_valid(a_identity) AND json_valid(b_identity) ORDER BY created_at").all()) {
    for (const side of ['a', 'b']) {
      const previous = JSON.parse(row[`${side}_correction`] ?? row[`${side}_identity`]);
      if (!keys.has(entityKey(previous))) continue;
      const work = library.ballotWork(row.task_id, row[`${side}_work`]);
      const next = currentAttribution(previous, work);
      if (next && keys.has(entityKey(next))) unresolved.push({ voteId: row.id, side, task: row.task_id, work: row[`${side}_work`], from: entityKey(previous), reason: 'target is also listed' });
      else if (next) repairs.push({ voteId: row.id, side, task: row.task_id, work: work.id, from: entityKey(previous), to: entityKey(next), next });
      else unresolved.push({ voteId: row.id, side, task: row.task_id, work: row[`${side}_work`], from: entityKey(previous),
        reason: !work ? 'work missing' : !work.curated && previous.digest !== work.digest ? 'upload content changed' : 'current label unchanged' });
    }
  }
  const tally = (items) => Object.entries(items.reduce((all, item) => {
    const label = `${item.from} -> ${item.to ?? item.reason} (${item.task}/${item.work})`;
    all[label] = (all[label] ?? 0) + 1;
    return all;
  }, {})).map(([label, count]) => ({ label, count }));
  if (options.apply) {
    if (repairs.length !== Number(options.expected)) throw new Error(`Expected ${options.expected} corrections, found ${repairs.length}`);
    db.prepare('VACUUM INTO ?').run(resolve(options.backup));
    for (const { voteId, side, next } of repairs) {
      arena.correctVote(admin, voteId, side, { modelId: next.modelId, modelName: next.modelName, vendor: next.vendor, effort: next.effort },
        '补齐管理员已更正作品的历史票归属或档位');
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
  }
  console.log(JSON.stringify({ apply: Boolean(options.apply), count: repairs.length, corrections: tally(repairs), unresolved: tally(unresolved) }, null, 2));
} finally { await platform.close(); }
