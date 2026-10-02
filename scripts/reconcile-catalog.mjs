// Reconcile a coordinated catalog release while the service is stopped.
// node scripts/reconcile-catalog.mjs <database> <old-data.json> <new-data.json> [--apply]
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { effortKey, entityKey, modelKey } from '../server/catalog.mjs';
import { transaction } from '../server/db.mjs';

const [database, oldFile, newFile, flag] = process.argv.slice(2);
if (!database || !oldFile || !newFile || (flag && flag !== '--apply')) throw new Error('Usage: reconcile-catalog.mjs <database> <old-data.json> <new-data.json> [--apply]');
const apply = flag === '--apply';
const oldData = JSON.parse(readFileSync(oldFile, 'utf8'));
const data = JSON.parse(readFileSync(newFile, 'utf8'));
const key = (task, id) => `${task}/${id}`;
const worksOf = (catalog) => new Map(catalog.tasks.flatMap((task) => task.results.map((work) => [key(task.id, work.id), work])));
const oldWorks = worksOf(oldData), newWorks = worksOf(data);
const removed = [...oldWorks.keys()].filter((id) => !newWorks.has(id));
const filled = new Map([...newWorks].filter(([id, work]) => oldWorks.has(id) && !effortKey(oldWorks.get(id).effort) && effortKey(work.effort)));
const normalize = (name) => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '');
const names = new Map();
for (const model of data.models) for (const name of [model.name, ...(model.aliases ?? [])]) {
  const normalized = normalize(name);
  if (!normalized) continue;
  const candidates = names.get(normalized) ?? new Map();
  candidates.set(model.id, model);
  names.set(normalized, candidates);
}
const matchModel = (name) => {
  const candidates = names.get(normalize(name));
  return candidates?.size === 1 ? [...candidates.values()][0] : null;
};
const db = new DatabaseSync(database, { readOnly: !apply });
try {
  db.exec('PRAGMA busy_timeout = 3000');
  // A retired work with a reference needs a separate, explicit attribution decision.
  const references = [];
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    const quote = (identifier) => '"' + identifier.replaceAll('"', '""') + '"';
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter((column) => /TEXT/i.test(column.type));
    for (const id of removed) {
      const workId = id.slice(id.indexOf('/') + 1);
      for (const column of columns) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE instr(${quote(column.name)}, ?) > 0`).get(workId).n;
        if (n) references.push({ id, table, column: column.name, n });
      }
    }
  }
  // Overrides for absent catalog works stay dormant; retain them as history.
  const blockers = references.filter((item) => item.table !== 'work_overrides' || item.column !== 'work_id');
  if (blockers.length) throw new Error(`Retired catalog works are still referenced: ${JSON.stringify(blockers)}`);
  const uploads = db.prepare("SELECT id, task_id, model_other FROM works WHERE model_id IS NULL AND model_other <> ''").all()
    .flatMap((work) => { const model = matchModel(work.model_other); return model ? [{ ...work, model }] : []; });
  const registered = new Map(uploads.map((work) => [key(work.task_id, work.id), work.model]));
  const patches = [];
  for (const table of ['votes', 'matches']) for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
    if (table === 'matches' && row.expires_at <= Date.now()) continue;
    for (const side of ['a', 'b']) {
      const column = table === 'votes' ? `${side}_correction` : `${side}_identity`;
      const raw = row[column] || row[`${side}_identity`];
      if (!raw) continue;
      const previous = JSON.parse(raw), next = { ...previous };
      const id = key(row.task_id, row[`${side}_work`]);
      if (previous.curated && filled.has(id) && !effortKey(previous.effort)) {
        next.effort = filled.get(id).effort;
        next.effortKey = effortKey(next.effort);
        next.configKey = entityKey(next);
      }
      const model = registered.get(id);
      if (model && !previous.modelId && normalize(previous.modelName) === normalize(uploads.find((work) => work.id === row[`${side}_work`])?.model_other)) {
        Object.assign(next, { modelId: model.id, modelName: model.name, vendor: model.vendor ?? '' });
        next.modelKey = modelKey(next);
        next.configKey = entityKey(next);
      }
      if (JSON.stringify(next) !== JSON.stringify(previous)) patches.push({ table, column, id: row.id, task: row.task_id, work: row[`${side}_work`], previous, next });
    }
  }
  const report = { apply, sourceCommit: data.sourceCommit, removed, retiredReferences: references, filledWorks: filled.size,
    uploads: uploads.map((work) => ({ task: work.task_id, id: work.id, modelId: work.model.id })),
    voteSides: patches.filter((patch) => patch.table === 'votes').length,
    matchSides: patches.filter((patch) => patch.table === 'matches').length };
  if (apply && (uploads.length || patches.length)) {
    const actor = db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
    if (!actor) throw new Error('An existing administrator is required for the audit record');
    const audit = db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
    transaction(db, () => {
      for (const work of uploads) {
        db.prepare("UPDATE works SET model_id = ?, model_other = '', model_vendor = '' WHERE id = ? AND model_id IS NULL AND model_other = ?").run(work.model.id, work.id, work.model_other);
        audit.run(Date.now(), actor.id, actor.name, 'catalog-model-reconciliation', work.task_id, work.id, JSON.stringify({ previous: work.model_other, modelId: work.model.id, sourceCommit: data.sourceCommit }));
      }
      for (const patch of patches) {
        db.prepare(`UPDATE ${patch.table} SET ${patch.column} = ? WHERE id = ?`).run(JSON.stringify(patch.next), patch.id);
        audit.run(Date.now(), actor.id, actor.name, 'catalog-identity-reconciliation', patch.task, patch.work,
          JSON.stringify({ table: patch.table, id: patch.id, side: patch.column[0], previous: patch.previous, next: patch.next, sourceCommit: data.sourceCommit }));
      }
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally { db.close(); }
