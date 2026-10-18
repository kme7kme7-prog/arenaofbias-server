import { randomBytes } from 'node:crypto';
import { transaction } from './db.mjs';
import { fail } from './http.mjs';
import { isAiJudgedTask } from './categories.mjs';
import { isSenior } from './roles.mjs';
import { entityKey } from './catalog.mjs';
export { CURATED_BOARDS } from './curated-seed.mjs'; // Migration seed / legacy consumers only.

export function createCurated({ db, catalog, library, questions }) {
  const settings = () => db.prepare('SELECT * FROM curated_settings WHERE id=1').get();
  const assignments = () => db.prepare('SELECT * FROM curated_questions ORDER BY task_id').all();
  const sections = () => db.prepare('SELECT * FROM curated_sections ORDER BY sort_order,id').all();
  const available = id => {
    const task = catalog.task(id);
    return Boolean(task && !isAiJudgedTask(task) && !task.tags?.includes('arena-only') &&
      new Set(library.eligible(id).map(work => entityKey(work))).size >= 2);
  };
  const sectionDto = (row, rows, admin = false) => {
    const selected = rows.filter(q => q.section_id === row.id);
    const taskIds = selected.filter(q => available(q.task_id)).map(q => q.task_id);
    return { id: row.id, name: row.name, order: row.sort_order, questionCount: taskIds.length, taskIds,
      ...(admin ? { selectedQuestionCount: taskIds.length } : {}) };
  };
  const info = (admin = false) => {
    const s = settings(), rows = assignments();
    return { countingStartedAt: new Date(s.counting_started_at).toISOString(), revision: s.revision,
      sections: sections().map(row => sectionDto(row, rows, admin)) };
  };
  const checkName = value => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) fail(400, '分区名称为1至40字');
    return value.trim();
  };
  const mutate = (actor, revision, action, run) => {
    if (!isSenior(actor)) fail(403, '仅高级管理员可以操作');
    return transaction(db, () => {
      if (revision !== settings().revision) fail(409, '精选配置已更新，请重新载入', 'curated_revision_conflict');
      const result = run();
      db.prepare('UPDATE curated_settings SET revision=revision+1,updated_by=?,updated_at=? WHERE id=1').run(actor.id, Date.now());
      db.prepare('INSERT INTO audit(at,actor_id,actor_name,action,detail) VALUES (?,?,?,?,?)')
        .run(Date.now(), actor.id, actor.name, action, JSON.stringify(result));
      return { ...result, revision: settings().revision };
    });
  };
  const getSection = id => db.prepare('SELECT * FROM curated_sections WHERE id=?').get(id) ?? fail(404, '分区不存在', 'section_not_found');
  return {
    revision: () => settings().revision,
    startedAt: () => settings().counting_started_at,
    scope(sectionId = null) {
      if (sectionId) getSection(sectionId);
      return { startedAt: settings().counting_started_at, revision: settings().revision,
        taskIds: assignments().filter(row => (!sectionId || row.section_id === sectionId) && available(row.task_id)).map(row => row.task_id) };
    },
    contains: id => Boolean(db.prepare('SELECT 1 FROM curated_questions WHERE task_id=?').get(id)) && available(id),
    info,
    adminInfo(actor) {
      const all = questions ? questions.adminAll(actor) : catalog.tasks();
      const selected = new Map(assignments().map(q => [q.task_id, q.section_id]));
      const indexed = new Map(all.map(q => [q.id, q]));
      for (const id of selected.keys()) if (!indexed.has(id)) indexed.set(id, { id, title: id });
      return { ...info(true), questions: [...indexed.values()].map(q => ({ taskId: q.id, title: q.title,
        category: q.category, selected: selected.has(q.id), sectionId: selected.get(q.id) ?? null,
        available: available(q.id), ...(!available(q.id) ? { unavailableReason: '题目未公开、由AI评分或缺少可比较作品' } : {}) })) };
    },
    createSection(actor, body) {
      return mutate(actor, body.revision, 'curated-section-create', () => {
        const id = `section-${randomBytes(8).toString('hex')}`, now = Date.now();
        db.prepare('INSERT INTO curated_sections VALUES (?,?,?,?,?,?)').run(id, checkName(body.name), sections().length, now, now, actor.id);
        return { section: sectionDto(getSection(id), []) };
      });
    },
    editSection(actor, id, body) {
      return mutate(actor, body.revision, 'curated-section-edit', () => {
        getSection(id);
        db.prepare('UPDATE curated_sections SET name=?,updated_by=?,updated_at=? WHERE id=?').run(checkName(body.name), actor.id, Date.now(), id);
        return { section: sectionDto(getSection(id), assignments()) };
      });
    },
    orderSections(actor, body) {
      return mutate(actor, body.revision, 'curated-section-order', () => {
        const ids = sections().map(s => s.id), wanted = body.sectionIds;
        if (!Array.isArray(wanted) || wanted.length !== ids.length || new Set(wanted).size !== ids.length || wanted.some(id => !ids.includes(id))) fail(400, '请提供完整分区顺序');
        const save = db.prepare('UPDATE curated_sections SET sort_order=?,updated_by=?,updated_at=? WHERE id=?');
        wanted.forEach((id, i) => save.run(i, actor.id, Date.now(), id));
        return { sections: info().sections };
      });
    },
    deleteSection(actor, id, body) {
      return mutate(actor, body.revision, 'curated-section-delete', () => {
        getSection(id);
        if (assignments().some(q => q.section_id === id)) {
          if (!body.moveQuestionsTo) fail(409, '请先迁移或移出分区内题目', 'section_not_empty');
          if (body.moveQuestionsTo === id) fail(400, '不能迁移到自身');
          getSection(body.moveQuestionsTo);
          db.prepare('UPDATE curated_questions SET section_id=? WHERE section_id=?').run(body.moveQuestionsTo, id);
        }
        db.prepare('DELETE FROM curated_sections WHERE id=?').run(id);
        sections().forEach((s, i) => db.prepare('UPDATE curated_sections SET sort_order=? WHERE id=?').run(i, s.id));
        return { ok: true };
      });
    },
    saveQuestions(actor, body) {
      return mutate(actor, body.revision, 'curated-questions', () => {
        const rows = body.questions;
        if (!Array.isArray(rows) || new Set(rows.map(q => q?.taskId)).size !== rows.length) fail(400, '精选题目格式无效');
        const before = assignments(), existing = new Set(before.map(q => q.task_id));
        for (const row of rows) {
          if (typeof row?.taskId !== 'string' || typeof row.sectionId !== 'string') fail(400, '请选择题目和分区');
          getSection(row.sectionId);
          if (!existing.has(row.taskId) && !available(row.taskId)) fail(400, '该题暂不能加入精选');
        }
        db.exec('DELETE FROM curated_questions');
        const add = db.prepare('INSERT INTO curated_questions VALUES (?,?,?,?)');
        for (const row of rows) add.run(row.taskId, row.sectionId, actor.id, Date.now());
        return { questions: rows, previous: before.map(q => ({ taskId: q.task_id, sectionId: q.section_id })) };
      });
    },
  };
}
