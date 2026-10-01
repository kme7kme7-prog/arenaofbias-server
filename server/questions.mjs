// Community questions need human approval before joining the public catalog.
// Prompt text is stored verbatim (apart from outer whitespace), at version 1.
import { randomBytes } from 'node:crypto';
import { avatarOf } from './auth.mjs';
import { transaction } from './db.mjs';
import { fail } from './http.mjs';
import { compatibleTemplates, defaultTemplates, requireCategory } from './categories.mjs';

const tagName = (value) => String(value).normalize('NFKC').trim().replace(/^#+/, '').trim();
const tagKey = (value) => tagName(value).toLowerCase();
const authorModeration = ({ status, reason, at }) => ({ status, ...(status === 'rejected' ? { reason } : {}), at });

function required(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `请填写${label}`);
  if (value.trim().length > max) fail(400, `${label}最多 ${max} 字`);
  return value.trim();
}

export function normalizeTags(input = [], existing = [], category = null) {
  if (!Array.isArray(input)) fail(400, '标签格式不正确');
  const names = new Map(existing.map((name) => [tagKey(name), name]));
  const unique = new Map();
  for (const raw of input) {
    if (typeof raw !== 'string') fail(400, '标签格式不正确');
    const name = tagName(raw), key = tagKey(name);
    if (!key || name.length > 24 || /[<>{}\n\r,，]/.test(name)) fail(400, '标签为 1–24 字，不能包含特殊符号');
    if (category && key === tagKey(category)) continue;
    unique.set(key, names.get(key) ?? name);
  }
  if (unique.size > 6) fail(400, '每道题最多添加 6 个标签');
  return [...unique.values()];
}

export function createQuestions(db) {
  const select = `SELECT questions.*, COALESCE(NULLIF(users.nickname, ''), users.name) AS owner_name, users.avatar AS owner_avatar FROM questions JOIN users ON users.id = questions.owner_id`;
  const publicRow = (row) => ['legacy', 'approved'].includes(JSON.parse(row.moderation).status);
  const all = db.prepare(`${select} WHERE questions.deleted_at IS NULL ORDER BY questions.created_at DESC, questions.id`);
  const one = db.prepare(`${select} WHERE questions.id = ? AND questions.deleted_at IS NULL`);
  const owned = db.prepare(`${select} WHERE questions.owner_id = ? AND questions.deleted_at IS NULL ORDER BY questions.created_at DESC, questions.id`);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE owner_id = ? AND deleted_at IS NULL AND json_extract(moderation, '$.status') = 'pending'`);
  const insert = db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const audit = db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const works = db.prepare('SELECT id, owner_id, task_id FROM works WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at, id');
  const votes = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE task_id = ?');
  const deleteWork = db.prepare('UPDATE works SET deleted_at = ?, updated_at = ? WHERE id = ?');
  const deleteQuestion = db.prepare('UPDATE questions SET deleted_at = ? WHERE id = ?');
  const setModeration = db.prepare('UPDATE questions SET moderation = ?, category = ?, templates = ?, tags = ? WHERE id = ?');
  const fromRow = (row, privateView = false) => row ? {
    id: row.id, title: row.title, summary: row.summary, prompt: row.prompt,
    category: row.category, tags: JSON.parse(row.tags), templates: JSON.parse(row.templates),
    owner: row.owner_name, ownerAvatar: avatarOf({ id: row.owner_id, avatar: row.owner_avatar }), version: row.version, community: true,
    createdAt: new Date(row.created_at).toISOString(),
    date: new Date(row.created_at).toISOString().slice(0, 10),
    ...(privateView ? { moderation: privateView === 'admin' ? JSON.parse(row.moderation) : authorModeration(JSON.parse(row.moderation)) } : {}),
  } : null;

  return {
    all: () => all.all().filter(publicRow).map((row) => fromRow(row)),
    get(id, viewer = null) {
      const row = one.get(id);
      const privileged = row && (viewer?.id === row.owner_id || viewer?.role === 'admin');
      return row && (publicRow(row) || privileged) ? fromRow(row, viewer?.role === 'admin' ? 'admin' : privileged) : null;
    },
    byOwner: (id, viewer = null) => owned.all(id).map((row) => fromRow(row, viewer?.role === 'admin' ? 'admin' : true)),
    pendingCount: () => all.all().filter((row) => JSON.parse(row.moderation).status === 'pending').length,
    adminAll() {
      return all.all().map((row) => {
        const samples = works.all(row.id).map((work) => ({ id: work.id, taskId: work.task_id }));
        return { ...fromRow(row, 'admin'), ownerId: row.owner_id, ownerName: row.owner_name, works: samples.length, samples };
      });
    },
    create(user, body, existingTags = []) {
      const category = requireCategory(body.category);
      const title = required(body.title, '题目标题', 70);
      const summary = required(body.summary, '测试简述', 400);
      const prompt = required(body.prompt, '完整提示词', 20000);
      const tags = normalizeTags(body.tags, existingTags, category);
      if (!compatibleTemplates(category, body.templates)) fail(400, '提交格式与题目分类不匹配');
      const templates = [...new Set(body.templates)];
      if (pending.get(user.id).n >= 3) fail(429, '你已有 3 道题目在等待审核');
      const id = `q-${randomBytes(8).toString('hex')}`;
      const now = Date.now();
      insert.run(id, user.id, title, summary, prompt, JSON.stringify(tags), JSON.stringify(templates), now, JSON.stringify({ status: 'pending', at: now }), category);
      audit.run(now, user.id, user.name, 'question-create', id, null, title);
      return fromRow(one.get(id), user.role === 'admin' ? 'admin' : true);
    },
    review(actor, id, body) {
      if (actor.role !== 'admin') fail(403, '仅管理员可以操作');
      const row = one.get(id);
      if (!row) fail(404, '题目不存在');
      if (!['approved', 'rejected'].includes(body.status)) fail(400, '题目审核结果无效');
      if (body.reason != null && typeof body.reason !== 'string') fail(400, '审核理由格式不正确');
      const reason = (body.reason ?? '').trim();
      if (reason.length > 500) fail(400, '审核理由最多 500 字');
      if (body.status === 'rejected' && !reason) fail(400, '请填写拒绝理由');
      const category = body.status === 'approved'
        ? requireCategory(Object.hasOwn(body, 'category') ? body.category : row.category) : row.category;
      const previousTemplates = JSON.parse(row.templates);
      const changedCategory = category !== row.category;
      const templates = changedCategory && !compatibleTemplates(category, previousTemplates)
        ? defaultTemplates(category) : previousTemplates;
      const tags = body.status === 'approved' ? JSON.parse(row.tags).filter((tag) => tagKey(tag) !== tagKey(category)) : JSON.parse(row.tags);
      const moderation = { status: body.status, source: 'human', reason, reviewer: actor.name, at: Date.now() };
      const detail = { ...moderation,
        ...(changedCategory ? { category: { from: row.category, to: category } } : {}),
        ...(templates !== previousTemplates ? { templates: { from: previousTemplates, to: templates } } : {}),
      };
      transaction(db, () => {
        setModeration.run(JSON.stringify(moderation), category, JSON.stringify(templates), JSON.stringify(tags), id);
        audit.run(moderation.at, actor.id, actor.name, 'question-review', id, null, JSON.stringify(detail));
      });
      return fromRow(one.get(id), 'admin');
    },
    remove(actor, id) {
      const row = one.get(id);
      if (!row) fail(404, '题目不存在');
      if (actor.id !== row.owner_id && actor.role !== 'admin') fail(403, '只能删除自己发起的题目');
      const items = works.all(id);
      if (actor.role === 'admin' && votes.get(id).n > 0) fail(409, '这道题目已有投票记录，不能删除');
      if (actor.role !== 'admin' && publicRow(row) && (votes.get(id).n > 0 || items.some((work) => work.owner_id !== actor.id))) fail(409, '已经有人作答的题目不能删除');
      const removed = actor.role === 'admin' ? items : items.filter((work) => work.owner_id === actor.id);
      const now = Date.now();
      transaction(db, () => {
        for (const work of removed) {
          deleteWork.run(now, now, work.id);
          audit.run(now, actor.id, actor.name, 'delete', id, work.id, '随题目删除');
        }
        deleteQuestion.run(now, id);
        audit.run(now, actor.id, actor.name, 'question-delete', id, null, row.title);
      });
      return { ok: true, deletedWorks: removed.map((work) => work.id) };
    },
  };
}
