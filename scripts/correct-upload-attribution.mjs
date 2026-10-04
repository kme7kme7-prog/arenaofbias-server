// Offline, explicitly scoped repair for labels corrected before automatic vote correction.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { transaction } from '../server/db.mjs';
import { uploadAttribution } from '../server/vote-attribution.mjs';

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') options.apply = true;
  else if (['--db', '--task', '--work', '--old-name', '--model', '--digest', '--expected', '--actor', '--backup'].includes(args[i]) && args[i + 1])
    options[args[i].slice(2)] = args[++i];
  else throw new Error('Unknown or missing argument');
}
for (const field of ['db', 'task', 'work', 'old-name', 'model', 'digest', 'expected', 'actor']) if (!options[field]) throw new Error(`--${field} is required`);
const expected = Number(options.expected);
if (!Number.isInteger(expected) || expected < 1) throw new Error('--expected must be a positive count');
if (options.apply && (!options.backup || existsSync(resolve(options.backup)))) throw new Error('--apply requires a new --backup path; stop the service first');
const db = new DatabaseSync(resolve(options.db), { readOnly: !options.apply });
try {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000');
  const actor = db.prepare('SELECT id, name, role FROM users WHERE name = ?').get(options.actor);
  if (!actor || !['admin', 'moderator'].includes(actor.role)) throw new Error('An existing administrator is required');
  const work = db.prepare('SELECT * FROM works WHERE id = ? AND task_id = ?').get(options.work, options.task);
  if (!work || work.deleted_at !== null || work.status !== 'verified' || work.model_id !== options.model || work.digest !== options.digest)
    throw new Error('Current verified work, model or digest does not match the supplied evidence');
  const model = createCatalog(config.dist).model(options.model);
  if (!model) throw new Error('The expected registered model is absent from the active catalog');
  const current = { id: work.id, taskId: work.task_id, digest: work.digest, modelId: model.id, modelName: model.name, vendor: model.vendor, effort: work.effort };
  const rows = db.prepare("SELECT * FROM votes WHERE source = 'arena' AND task_id = ? AND (a_work = ? OR b_work = ?) AND json_valid(a_identity) AND json_valid(b_identity)").all(options.task, options.work, options.work);
  const repairs = [];
  for (const row of rows) for (const side of ['a', 'b']) {
    if (row[`${side}_work`] !== work.id) continue;
    const original = JSON.parse(row[`${side}_identity`]);
    const previous = JSON.parse(row[`${side}_correction`] ?? row[`${side}_identity`]);
    if (previous.modelName !== options['old-name']) continue;
    if (original.id !== work.id || original.taskId !== work.task_id || original.modelName !== options['old-name']
      || original.modelId !== null || original.digest !== options.digest || original.effort !== work.effort)
      throw new Error(`Original attribution or digest differs for ${row.id}/${side}`);
    const next = uploadAttribution(previous, current);
    if (!next) throw new Error(`Work identity or digest differs for ${row.id}/${side}`);
    repairs.push({ voteId: row.id, side, previous, next });
  }
  if (repairs.length !== expected) throw new Error(`Expected ${expected} corrections, found ${repairs.length}`);
  if (options.apply) {
    db.prepare('VACUUM INTO ?').run(resolve(options.backup));
    transaction(db, () => {
      for (const repair of repairs) {
        db.prepare(`UPDATE votes SET ${repair.side}_correction = ? WHERE id = ?`).run(JSON.stringify(repair.next), repair.voteId);
        db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(Date.now(), actor.id, actor.name, 'vote-identity-correction', work.task_id, work.id, JSON.stringify({ ...repair, reason: '修复已更正上传作品的历史错误模型归属；内容摘要核对一致' }));
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
    });
  }
  console.log(JSON.stringify({ apply: Boolean(options.apply), task: work.task_id, work: work.id, count: repairs.length,
    corrections: repairs.map(({ voteId, side, previous, next }) => ({ voteId, side, oldName: previous.modelName, modelId: next.modelId, modelName: next.modelName, effort: next.effort, digest: next.digest })) }));
} finally { db.close(); }
