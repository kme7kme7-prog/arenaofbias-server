import { modelKey } from './catalog.mjs';
import { isTextTask } from './categories.mjs';
import { transaction } from './db.mjs';

const localDay = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function selectFeatured(works, scores, previous) {
  const rated = new Map(scores.filter((row) => row.games >= 5).map((row) => [row.id, row.score - row.interval]));
  const cover = [];
  const models = new Map();
  for (const work of works) {
    if (!rated.has(work.id)) continue;
    const candidate = { work_id: work.id, conservative: rated.get(work.id) };
    cover.push(candidate);
    const key = modelKey(work);
    if (!models.has(key)) models.set(key, []);
    models.get(key).push(candidate);
  }
  const picks = [];
  const groups = [{ scope: 'cover', model_key: '', candidates: cover },
    ...[...models].map(([model_key, candidates]) => ({ scope: 'model', model_key, candidates }))];
  for (const { scope, model_key, candidates } of groups) {
    if (!candidates.length) continue;
    const old = previous.find((pick) => pick.scope === scope && pick.model_key === model_key);
    const incumbent = candidates.find((item) => item.work_id === old?.work_id);
    const best = candidates.sort((a, b) => b.conservative - a.conservative || a.work_id.localeCompare(b.work_id))[0];
    const chosen = incumbent && best.conservative < incumbent.conservative + 40 ? incumbent : best;
    picks.push({ scope, model_key, ...chosen });
  }
  return picks;
}

export function createFeatured({ db, catalog, library, arena, now = Date.now }) {
  const q = {
    picks: db.prepare('SELECT * FROM featured_picks WHERE task_id = ?'),
    day: db.prepare('SELECT day FROM featured_refreshes WHERE task_id = ?'),
    remove: db.prepare('DELETE FROM featured_picks WHERE task_id = ? AND scope = ? AND model_key = ?'),
    clear: db.prepare('DELETE FROM featured_picks WHERE task_id = ?'),
    pick: db.prepare(`INSERT INTO featured_picks (task_id, scope, model_key, work_id, conservative, picked_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    refresh: db.prepare(`INSERT INTO featured_refreshes (task_id, day) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET day = excluded.day`),
  };
  const pending = new Map();
  let closed = false;

  function current(taskId) {
    return q.picks.all(taskId).filter((pick) => {
      const work = library.work(taskId, pick.work_id);
      if (library.isEligible(work) && (pick.scope === 'cover' || modelKey(work) === pick.model_key)) return true;
      q.remove.run(taskId, pick.scope, pick.model_key);
      return false;
    });
  }

  function schedule(taskId, day) {
    if (closed || pending.has(taskId) || q.day.get(taskId)?.day === day) return;
    const job = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      const scores = await arena.workScores(taskId);
      if (isTextTask(catalog.task(taskId)) || !catalog.task(taskId)) return;
      const picks = selectFeatured(library.eligible(taskId), scores, current(taskId));
      transaction(db, () => {
        q.clear.run(taskId);
        for (const pick of picks) q.pick.run(taskId, pick.scope, pick.model_key, pick.work_id, pick.conservative, now());
        q.refresh.run(taskId, day);
      });
    }).catch((error) => console.error(`Featured refresh failed for ${taskId}`, error))
      .finally(() => pending.delete(taskId));
    pending.set(taskId, job);
  }

  return {
    read() {
      const result = {};
      const day = localDay(now());
      for (const task of catalog.tasks()) {
        if (isTextTask(task)) continue;
        const picks = current(task.id);
        if (picks.length) result[task.id] = {
          cover: picks.find((pick) => pick.scope === 'cover')?.work_id ?? null,
          models: Object.fromEntries(picks.filter((pick) => pick.scope === 'model').map((pick) => [pick.model_key, pick.work_id])),
        };
        schedule(task.id, day);
      }
      return result;
    },
    async drain() { await Promise.all([...pending.values()]); },
    async close() { closed = true; await this.drain(); },
  };
}
