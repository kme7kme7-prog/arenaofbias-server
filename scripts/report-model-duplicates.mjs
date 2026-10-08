// Read-only candidates for an explicit library.setMeta decision; never remap x: ranking keys.
// node scripts/report-model-duplicates.mjs --db <consistent-copy.db> [--dist <datapack-directory>]
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { createCatalog, entityKey, modelKey, providerOf } from '../server/catalog.mjs';
import { isAiJudgedTask, isTextTask } from '../server/categories.mjs';
import { generationOf } from '../server/generation.mjs';
import { createQuestions } from '../server/questions.mjs';
import { manualCorrections, voteAttribution, votesBeforeTaskMove } from '../server/vote-attribution.mjs';

const options = { dist: config.dist };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (['--db', '--dist'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error('Usage: report-model-duplicates.mjs --db <consistent-copy.db> [--dist <datapack-directory>]');
}
if (!options.db) throw new Error('--db is required; use a consistent copy or an offline local database');
const db = new DatabaseSync(resolve(options.db), { readOnly: true });
try {
  // One read transaction keeps all SELECTs on the same database snapshot. No migrations or service startup.
  db.exec('BEGIN');
  const questions = createQuestions(db);
  const catalog = createCatalog(resolve(options.dist), questions);
  questions.bindCatalog(catalog);
  const snapshot = catalog.snapshot();
  const uploads = new Map(db.prepare('SELECT * FROM works').all().map(row => [row.id, row]));
  const deletedQuestions = new Set(db.prepare('SELECT id FROM questions WHERE deleted_at IS NOT NULL').all().map(row => row.id));
  const overrides = new Map(db.prepare('SELECT * FROM work_overrides').all().map(row => [`${row.task_id}/${row.work_id}`, row]));
  const matches = [...uploads.values()].filter(row => !row.model_id).flatMap(row => {
    const model = catalog.modelNamed(row.model_other);
    return model ? [{ id: row.id, task: row.task_id, taskTitle: catalog.task(row.task_id, { role: 'admin' })?.title ?? row.task_id,
      modelOther: row.model_other, modelId: model.id, modelName: model.name,
      status: row.status, deletedAt: row.deleted_at, curatedAs: row.curated_as,
      validVotes: { config: 0, model: 0 } }] : [];
  });
  const candidates = new Map(matches.map(item => [item.id, item]));

  // The fields needed by library.ballotWork/countsVotes, without creating its upload directories.
  const workCache = new Map();
  function ballotWork(task, id) {
    const key = `${task}/${id}`;
    if (workCache.has(key)) return workCache.get(key);
    let work = snapshot.work(task, id);
    if (work) {
      const override = overrides.get(key);
      let patch = {};
      try { patch = JSON.parse(override?.display_json || '{}'); } catch { /* same as library.withDisplay */ }
      work = { ...work, status: override?.status ?? 'verified', moderation: { status: 'approved' } };
      for (const field of ['modelId', 'modelName', 'vendor', 'effort', 'harnessId', 'harnessOther', 'providerId', 'generationMode', 'humanIntervention']) {
        if (typeof patch[field] === 'string' || patch[field] === null) work[field] = patch[field];
      }
    } else {
      const row = uploads.get(id);
      const model = row?.model_id ? snapshot.model(row.model_id) : null;
      work = row && row.task_id === task && !deletedQuestions.has(task) ? {
        id: row.id, taskId: task, curated: false, curatedAs: row.curated_as,
        status: row.status, moderation: JSON.parse(row.moderation), digest: row.digest,
        modelId: row.model_id, modelName: row.model_id ? model?.name ?? row.model_id : row.model_other,
        vendor: row.model_id ? model?.vendor ?? '' : row.model_vendor, effort: row.effort,
        harnessId: row.harness_id, providerId: providerOf(row.provider_id, row.provider_other),
        generationMode: row.generation_mode, humanIntervention: row.human_intervention,
      } : null;
    }
    const question = work && catalog.task(work.taskId);
    const allowed = work && !work.curatedAs && question && work.status === 'verified'
      && (work.curated || ['legacy', 'approved'].includes(work.moderation?.status))
      && (isTextTask(question) || generationOf(work).generationMode === 'single-turn' && work.humanIntervention === 'none');
    workCache.set(key, allowed ? work : null);
    return workCache.get(key);
  }
  const parseIdentity = text => {
    if (!text) return null;
    const identity = JSON.parse(text);
    return { ...identity, ...generationOf(identity), providerId: providerOf(identity.providerId, identity.providerOther || identity.providerName) };
  };
  const manual = manualCorrections(db), moved = votesBeforeTaskMove(db);
  for (const row of db.prepare("SELECT * FROM votes WHERE source = 'arena' ORDER BY created_at").all()) {
    if (!candidates.has(row.a_work) && !candidates.has(row.b_work)) continue;
    if (isAiJudgedTask(catalog.task(row.task_id)) || moved(row) || !row.a_identity || !row.b_identity) continue;
    const sides = ['a', 'b'].map(side => {
      const identity = parseIdentity(row[`${side}_identity`]);
      const work = ballotWork(row.task_id, row[`${side}_work`]) ?? ballotWork(identity.taskId, row[`${side}_work`]);
      return work && voteAttribution(row, side, identity, parseIdentity(row[`${side}_correction`]), work, snapshot, manual);
    });
    if (!sides.every(Boolean)) continue;
    const related = [...new Set([row.a_work, row.b_work])].map(id => candidates.get(id)).filter(Boolean);
    for (const [by, keyOf] of [['config', work => work.configKey ?? entityKey(work)], ['model', work => work.modelKey ?? modelKey(work)]]) {
      if (keyOf(sides[0]) !== keyOf(sides[1])) for (const item of related) item.validVotes[by]++;
    }
  }
  matches.sort((a, b) => a.task.localeCompare(b.task) || a.id.localeCompare(b.id));
  console.log(JSON.stringify({ readOnly: true, schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
    unregisteredWorks: [...uploads.values()].filter(row => !row.model_id).length,
    count: matches.length, matches }, null, 2));
} finally { db.close(); }
