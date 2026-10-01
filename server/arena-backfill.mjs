import { generationOf } from './generation.mjs';
import { isTextTask } from './categories.mjs';
import { transaction } from './db.mjs';

export const DUPLICATE_CURATED_WORKS = [
  'boeing-787/claude-opus-5.5-max-zip',
  'voxel-construction-site/claude-opus-5.5-max-zip',
  'sydney-opera-house/claude-opus-5.5-max-zip',
];

export function planArenaBackfill(db, catalog, exclude = new Set()) {
  const tasks = new Map();
  const changes = [];
  const touch = (id) => {
    if (!tasks.has(id)) tasks.set(id, { task: id, open: [], generation: [], nonstandard: [], excluded: [], curatedMissingGeneration: [] });
    return tasks.get(id);
  };
  const overrides = db.prepare('SELECT * FROM work_overrides');
  const flags = new Map(overrides.all().map((row) => [`${row.task_id}/${row.work_id}`, row]));
  for (const row of db.prepare('SELECT * FROM works WHERE deleted_at IS NULL ORDER BY task_id, id').all()) {
    const task = catalog.task(row.task_id, { role: 'admin' });
    if (!task || isTextTask(task)) continue;
    const summary = touch(row.task_id);
    const id = `${row.task_id}/${row.id}`;
    // Old-schema dry runs use the defaults of the published v17/v19 migrations.
    const mode = row.generation_mode ?? '', human = row.human_intervention ?? '';
    const nonstandard = mode === 'multi-turn' || ['prompt-guided', 'code-edited'].includes(human);
    if (nonstandard) summary.nonstandard.push(id);
    if (exclude.has(id)) { summary.excluded.push(id); continue; }
    const generation = nonstandard ? {} : {
      ...(['', 'agent'].includes(mode) ? { generation_mode: 'single-turn' } : {}),
      ...(human === '' ? { human_intervention: 'none' } : {}),
    };
    const open = row.status === 'verified' && catalog.task(row.task_id) &&
      ['legacy', 'approved'].includes(JSON.parse(row.moderation ?? '{"status":"legacy"}').status) && !row.show_arena;
    if (Object.keys(generation).length) summary.generation.push(id);
    if (open) summary.open.push(id);
    if (open || Object.keys(generation).length) changes.push({ task: row.task_id, id: row.id, curated: false,
      before: { generation_mode: mode, human_intervention: human, show_arena: row.show_arena },
      after: { generation_mode: mode, human_intervention: human, show_arena: row.show_arena,
        ...generation, ...(open ? { show_arena: 1 } : {}) } });
  }
  for (const task of catalog.snapshot().tasks()) {
    if (isTextTask(task)) continue;
    const summary = touch(task.id);
    for (const work of catalog.works(task.id)) {
      const id = `${task.id}/${work.id}`;
      const generation = generationOf(work);
      if (generation.generationMode === 'multi-turn' || ['prompt-guided', 'code-edited'].includes(generation.humanIntervention)) summary.nonstandard.push(id);
      if (exclude.has(id)) { summary.excluded.push(id); continue; }
      if (!generation.generationMode || !generation.humanIntervention) summary.curatedMissingGeneration.push(id);
      const old = flags.get(id);
      if (work.status !== 'verified' || old?.show_arena) continue;
      summary.open.push(id);
      changes.push({ task: task.id, id: work.id, curated: true,
        before: { show_gallery: old?.show_gallery ?? 1, show_arena: old?.show_arena ?? 0 },
        after: { show_gallery: old?.show_gallery ?? 1, show_arena: 1 } });
    }
  }
  return {
    tasks: [...tasks.values()].sort((a, b) => a.task.localeCompare(b.task)).map((task) => ({ ...task,
      openCount: task.open.length, generationCount: task.generation.length, nonstandardCount: task.nonstandard.length })),
    duplicates: DUPLICATE_CURATED_WORKS.map((id) => ({ id, present: Boolean(catalog.work(...id.split('/'))), excluded: exclude.has(id) })),
    changes,
  };
}

export function applyArenaBackfill(db, catalog, { exclude = new Set(), actor, backup, invalidate = () => {} }) {
  const plan = transaction(db, () => {
    const result = planArenaBackfill(db, catalog, exclude);
    const upload = db.prepare('UPDATE works SET generation_mode = ?, human_intervention = ?, show_arena = ?, updated_at = ? WHERE id = ?');
    const curated = db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, updated_by, updated_at)
      VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET
      show_arena = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    const audit = db.prepare(`INSERT INTO audit (at, actor_name, action, task_id, work_id, detail)
      VALUES (?, ?, 'arena-backfill', ?, ?, ?)`);
    const now = Date.now();
    for (const change of result.changes) {
      if (change.curated) curated.run(change.task, change.id, change.after.show_gallery, actor, now);
      else upload.run(change.after.generation_mode, change.after.human_intervention, change.after.show_arena, now, change.id);
      audit.run(now, actor, change.task, change.id, JSON.stringify({ before: change.before, after: change.after, backup }));
    }
    return result;
  });
  invalidate();
  return plan;
}
