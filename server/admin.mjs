// Admin-only catalog overlays and traffic summaries. The caller enforces the role.
import { fail } from './http.mjs';
import { transaction } from './db.mjs';
import { effortKey } from './catalog.mjs';
import { GENERATION_MODES, HUMAN_INTERVENTIONS } from './generation.mjs';

const faceOf = (value) => ['gallery', 'arena'].includes(value) ? value : fail(400, '门面参数无效', 'invalid_face');
const intParam = (value, fallback, max, label) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(400, `${label}无效`, 'invalid_query');
  return n;
};

export function createAdmin({ db, catalog, library }) {
  const editorial = db.prepare('SELECT * FROM task_editorial WHERE task_id = ? AND face = ?');
  const setEditorial = db.prepare(`INSERT INTO task_editorial (task_id, face, commentary, weights_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, face) DO UPDATE SET
    commentary = excluded.commentary, weights_json = excluded.weights_json,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const daily = db.prepare('SELECT day, COUNT(*) AS pv, COUNT(DISTINCT ip_hash) AS unique_ips FROM page_views WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day');
  const paths = db.prepare('SELECT path, COUNT(*) AS pv FROM page_views WHERE day >= ? AND day <= ? GROUP BY path ORDER BY pv DESC, path LIMIT 20');
  const users = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_users FROM users');
  // Ballots each work has appeared in (skips excluded), matching the pre-fusion admin list.
  const votesPerWork = db.prepare(`SELECT task_id, work_id, COUNT(*) AS votes FROM (
    SELECT task_id, a_work AS work_id FROM votes WHERE choice != 'skip'
    UNION ALL SELECT task_id, b_work FROM votes WHERE choice != 'skip') GROUP BY task_id, work_id`);

  const task = (id) => catalog.task(id) ?? fail(404, '题目不存在', 'not_found');
  const iso = (ms) => new Date(ms).toISOString();
  return {
    works(query) {
      const taskId = query.get('task') || null;
      if (taskId) task(taskId);
      const status = query.get('status') || null;
      if (status && !['verified', 'unverified', 'questioned'].includes(status)) fail(400, '状态筛选无效', 'invalid_query');
      const face = query.get('face') || null;
      if (face) faceOf(face);
      const show = query.get('show') || null;
      if (show && !['on', 'off'].includes(show)) fail(400, '开关筛选无效', 'invalid_query');
      if (show && !face) fail(400, '请指定筛选门面', 'invalid_query');
      const source = query.get('source') || null;
      if (source && !['curated', 'upload'].includes(source)) fail(400, '来源筛选无效', 'invalid_query');
      // Harness supports free text; providers are official, unofficial or unset.
      const provenance = Object.fromEntries(['harness', 'provider'].map((field) => {
        const value = query.get(field) || null;
        if (value && value !== 'unset' && !(field === 'harness' && value === 'other') && !catalog[field](value)) fail(400, `${field === 'harness' ? 'Harness' : '服务商'}筛选无效`, 'invalid_query');
        return [field, value];
      }));
      const provenanceOf = (work, field) => work[field] ?? (work[`${field}Name`] ? 'other' : 'unset');
      const model = query.get('model') || null;
      if (model && model !== 'other' && !catalog.model(model)) fail(400, '模型筛选无效', 'invalid_query');
      const effort = query.get('effort') || null;
      if (effort && effort.length > 20) fail(400, '档位筛选无效', 'invalid_query');
      const generation = Object.fromEntries([['generationMode', GENERATION_MODES], ['humanIntervention', HUMAN_INTERVENTIONS]].map(([key, choices]) => {
        const value = query.get(key) || null;
        if (value && value !== 'unset' && !choices.includes(value)) fail(400, '生成信息筛选无效', 'invalid_query');
        return [key, value];
      }));
      const page = intParam(query.get('page'), 1, 100000, '页码');
      const pageSize = intParam(query.get('pageSize'), 30, 100, '每页数量');
      const search = String(query.get('search') ?? '').trim().toLocaleLowerCase();
      const curated = catalog.tasks().flatMap((t) => [...t.works.values()]);
      const uploads = library.uploads();
      const voteCounts = new Map(votesPerWork.all().map((row) => [`${row.task_id}/${row.work_id}`, row.votes]));
      const allWorks = [...curated, ...uploads].map((work) => ({ ...library.adminWork(work), votes: voteCounts.get(`${work.taskId}/${work.id}`) ?? 0 }));
      const efforts = [...new Set(allWorks.map((work) => work.effort).filter(Boolean))].sort();
      const rows = allWorks.filter((work) =>
        (!taskId || work.task === taskId) && (!status || work.status === status) &&
        (!source || work.source === source) && (!face || !show || Boolean(work[`show_${face}`]) === (show === 'on')) &&
        Object.entries(provenance).every(([field, value]) => !value || provenanceOf(work, field) === value) &&
        (!model || (model === 'other' ? !work.model : work.model === model)) &&
        (!effort || (effort === 'unset' ? !work.effort : effortKey(work.effort) === effortKey(effort))) &&
        Object.entries(generation).every(([key, value]) => !value || (value === 'unset' ? !work[key] : work[key] === value)) &&
        (!search || `${work.title} ${work.modelName} ${work.vendor} ${work.modelVersion} ${work.task} ${work.harnessName ?? ''} ${catalog.provider(work.provider)?.name ?? ''}`.toLocaleLowerCase().includes(search)));
      rows.sort((a, b) => a.task.localeCompare(b.task) || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
      return { works: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, efforts };
    },
    getEditorial(id, rawFace) {
      task(id);
      const face = faceOf(rawFace);
      const row = editorial.get(id, face);
      return { task: id, face, commentary: row?.commentary ?? '', weights: row?.weights_json ? JSON.parse(row.weights_json) : null,
        updatedAt: row ? iso(row.updated_at) : null };
    },
    saveEditorial(admin, id, body) {
      task(id);
      const face = faceOf(body?.face);
      if (typeof body.commentary !== 'string' || body.commentary.length > 4000) fail(400, '点评或策展文案无效', 'invalid_editorial');
      let weights = null;
      if (face === 'gallery' && body.weights !== undefined) fail(400, '展览馆不使用六维权重', 'invalid_weights');
      if (face === 'arena') {
        if (!Array.isArray(body.weights) || body.weights.length !== 6 || body.weights.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) ||
          Math.abs(body.weights.reduce((sum, n) => sum + n, 0) - 1) > 0.001) fail(400, '六维权重须为 6 个 0–1 数字，且总和为 1', 'invalid_weights');
        weights = body.weights;
      }
      transaction(db, () => {
        setEditorial.run(id, face, body.commentary.trim(), weights ? JSON.stringify(weights) : null, admin.id, Date.now());
        library.audit(admin, 'editorial', { taskId: id }, JSON.stringify({ face, commentary: body.commentary.trim(), weights }));
      });
      return this.getEditorial(id, face);
    },
    traffic(rawDays) {
      const days = intParam(rawDays, 30, 90, '天数');
      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const startMs = Date.parse(`${start}T00:00:00.000Z`);
      const byDay = new Map(daily.all(start, today).map((row) => [row.day, row]));
      const series = Array.from({ length: days }, (_, i) => {
        const day = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
        return { day, pv: byDay.get(day)?.pv ?? 0, uniqueIps: byDay.get(day)?.unique_ips ?? 0 };
      });
      const counts = users.get(startMs);
      return { days, daily: series, paths: paths.all(start, today), users: { total: counts.total, new: counts.new_users ?? 0 } };
    },
  };
}
