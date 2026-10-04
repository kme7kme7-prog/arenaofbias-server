// Questions share one lifecycle while package resources stay immutable.
import { randomBytes } from 'node:crypto';
import { avatarOf } from './auth.mjs';
import { transaction } from './db.mjs';
import { fail } from './http.mjs';
import { authorOf, isSenior, isStaff, roleOf } from './roles.mjs';
import { compatibleTemplates, defaultTemplates, requireCategory, requireDomains } from './categories.mjs';

const tagName = (value) => String(value).normalize('NFKC').trim().replace(/^#+/, '').trim();
const tagKey = (value) => tagName(value).toLowerCase();
// Authors see the decision on the current round, and while a resubmission waits, the reason it answers.
const authorModeration = ({ status, reason, at, round, previous }) => ({ status, ...(status === 'rejected' ? { reason } : {}), ...(at ? { at } : {}),
  ...(round > 1 ? { round } : {}), ...(previous ? { previous: { reason: previous.reason, at: previous.at } } : {}) });
const publicQuestion = (question) => ['legacy', 'approved'].includes(question.moderation.status);
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
export function createQuestions(db, { references = null } = {}) {
  let catalog = null;
  const select = `SELECT questions.*, COALESCE(NULLIF(users.nickname, ''), users.name) AS owner_name, users.avatar AS owner_avatar
    FROM questions LEFT JOIN users ON users.id = questions.owner_id`;
  const all = db.prepare(`${select} WHERE questions.deleted_at IS NULL ORDER BY questions.created_at DESC, questions.id`);
  const one = db.prepare(`${select} WHERE questions.id = ? AND questions.deleted_at IS NULL`);
  const owned = db.prepare(`${select} WHERE questions.owner_id = ? AND questions.deleted_at IS NULL ORDER BY questions.created_at DESC, questions.id`);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE owner_id = ? AND deleted_at IS NULL AND json_extract(moderation, '$.status') = 'pending'`);
  const insert = db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation, category, domains, author_role, reference_credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const audit = db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const works = db.prepare('SELECT id, owner_id, task_id FROM works WHERE task_id = ? AND deleted_at IS NULL AND curated_as IS NULL ORDER BY created_at, id');
  const votes = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE task_id = ?');
  const override = db.prepare('SELECT * FROM question_overrides WHERE task_id = ?');
  const saveOverride = db.prepare(`INSERT INTO question_overrides (task_id, display_json, moderation, accepts_uploads, cover_work, deleted_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET display_json = excluded.display_json,
    moderation = excluded.moderation, accepts_uploads = excluded.accepts_uploads, cover_work = excluded.cover_work,
    deleted_at = excluded.deleted_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const approvedBefore = db.prepare(`SELECT 1 FROM audit WHERE task_id = ? AND action = 'question-review' AND json_extract(detail, '$.status') = 'approved' LIMIT 1`);
  const deletedPackWork = db.prepare('SELECT deleted_at FROM work_overrides WHERE task_id = ? AND work_id = ?');
  function fromRow(row) {
    if (!row) return null;
    return { ...row, packaged: false, domains: JSON.parse(row.domains), tags: JSON.parse(row.tags), templates: JSON.parse(row.templates),
      moderation: JSON.parse(row.moderation), acceptsUploads: Boolean(row.accepts_uploads), cover: row.cover_work,
      references: references?.forQuestion(row.id) ?? [], referenceCredit: row.reference_credit,
      createdAt: new Date(row.created_at).toISOString(), date: new Date(row.created_at).toISOString().slice(0, 10) };
  }
  function fromPack(task) {
    if (!task) return null;
    const overlay = override.get(task.id);
    if (overlay?.deleted_at != null) return null;
    return { ...task, tags: task.tags ?? [], ...JSON.parse(overlay?.display_json ?? '{}'), packaged: true,
      author_role: 'admin', owner_id: null, owner_name: null, owner_avatar: null,
      references: (task.references ?? []).map((ref) => ({ ...ref,
        src: `media/pack-references/${encodeURIComponent(task.id)}/${encodeURIComponent(ref.name)}` })),
      referenceCredit: task.referenceCredit ?? '',
      moderation: JSON.parse(overlay?.moderation ?? '{"status":"approved"}'),
      acceptsUploads: overlay?.accepts_uploads == null ? task.acceptsUploads : Boolean(overlay.accepts_uploads),
      cover: overlay?.cover_work ?? null, version: task.version ?? 1, createdAt: task.createdAt ?? null, date: task.date ?? null };
  }
  const lookup = (id) => fromPack(catalog?.snapshot().task(id)) ?? fromRow(one.get(id));
  const allQuestions = () => [...(catalog?.snapshot().tasks() ?? []).map(fromPack).filter(Boolean), ...all.all().map(fromRow)];
  function dto(question, viewer = null, moderationView = false, adminView = false) {
    return { id: question.id, title: question.title, summary: question.summary, prompt: question.prompt,
      category: question.category, domains: question.domains, tags: question.tags, templates: question.templates,
      references: question.references, referenceCredit: question.referenceCredit,
      version: question.version, date: question.date, createdAt: question.createdAt,
      author: authorOf({ role: question.author_role, name: question.owner_name,
        avatar: question.owner_id && question.owner_name ? avatarOf({ id: question.owner_id, avatar: question.owner_avatar }) : null }, adminView),
      mine: Boolean(viewer?.id && viewer.id === question.owner_id), acceptsUploads: question.acceptsUploads, cover: question.cover,
      ...(moderationView ? { moderation: moderationView === 'admin' ? question.moderation : authorModeration(question.moderation) } : {}) };
  }
  function packWorks(id) {
    return (catalog?.snapshot().works(id) ?? []).filter((work) => deletedPackWork.get(id, work.id)?.deleted_at == null);
  }
  const itemsFor = (id) => [...packWorks(id), ...works.all(id)];
  function writePack(actor, question, changes) {
    const next = { ...(override.get(question.id) ?? {}), ...changes };
    saveOverride.run(question.id, next.display_json ?? null, next.moderation ?? null, next.accepts_uploads ?? null,
      next.cover_work ?? null, next.deleted_at ?? null, actor.id, Date.now());
  }
  function adminQuestion(question, viewer) {
    return { ...dto(question, viewer, 'admin', true), ownerId: question.owner_id,
      works: itemsFor(question.id).length, votes: votes.get(question.id).n,
      samples: question.packaged ? [] : works.all(question.id).filter((work) => work.owner_id === question.owner_id)
        .map((work) => ({ id: work.id, taskId: work.task_id })) };
  }
  function referenceCredit(value = '') {
    if (typeof value !== 'string') fail(400, '参考图署名格式不正确');
    const credit = value.trim();
    if ([...credit].length > 80) fail(400, '参考图署名最多 80 字');
    return credit;
  }
  function prepareReferences(actor, input = [], taskId = null) {
    if (!Array.isArray(input)) fail(400, '参考图格式不正确');
    if (references) return references.prepare(actor, input, { taskId });
    if (input.length) fail(400, '参考图上传不可用');
    return [];
  }
  function meta(question, body, actor = null) {
    const fields = ['title', 'summary', 'prompt', 'category', 'domains', 'templates', 'acceptsUploads', 'cover', 'references', 'referenceCredit'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || !fields.some((field) => Object.hasOwn(body, field))) fail(400, '请提供要修改的题目信息');
    const title = Object.hasOwn(body, 'title') ? required(body.title, '题目标题', 70) : question.title;
    const summary = Object.hasOwn(body, 'summary') ? required(body.summary, '测试简述', 400) : question.summary;
    const prompt = Object.hasOwn(body, 'prompt') ? required(body.prompt, '完整提示词', 20000) : question.prompt;
    const credit = Object.hasOwn(body, 'referenceCredit') ? referenceCredit(body.referenceCredit) : question.referenceCredit;
    let refs = question.references;
    if (Object.hasOwn(body, 'references')) {
      if (!Array.isArray(body.references)) fail(400, '参考图格式不正确');
      if (question.packaged) {
        const metadata = (items) => items.map((ref) => ({ name: ref?.name, caption: ref?.caption ?? '' }));
        if (JSON.stringify(metadata(body.references)) !== JSON.stringify(metadata(question.references)))
          fail(400, '数据包题目不能修改参考图，请在数据仓库维护');
      } else refs = prepareReferences(actor, body.references, question.id);
    }
    if (question.packaged && credit !== question.referenceCredit) fail(400, '数据包题目不能修改参考图署名，请在数据仓库维护');
    const category = Object.hasOwn(body, 'category') ? requireCategory(body.category) : question.category;
    const domains = Object.hasOwn(body, 'domains') ? requireDomains(body.domains) : question.domains;
    let templates = question.templates;
    if (Object.hasOwn(body, 'templates')) {
      if (!compatibleTemplates(category, body.templates)) fail(400, '提交格式与题目分类不匹配');
      templates = [...new Set(body.templates)];
    } else if (category !== question.category && !compatibleTemplates(category, templates)) templates = defaultTemplates(category);
    const items = itemsFor(question.id);
    if (prompt !== question.prompt && publicQuestion(question) && items.length) fail(409, '已有作品的题目不能修改提示词');
    if ((JSON.stringify(refs) !== JSON.stringify(question.references) || credit !== question.referenceCredit) && publicQuestion(question) && items.length)
      fail(409, '已有作品的题目不能修改参考图或署名');
    if (JSON.stringify(templates) !== JSON.stringify(question.templates) && items.length) fail(409, '已有作品的题目不能修改提交格式');
    if (Object.hasOwn(body, 'acceptsUploads') && typeof body.acceptsUploads !== 'boolean') fail(400, '投稿开关无效');
    const acceptsUploads = body.acceptsUploads ?? question.acceptsUploads;
    const cover = Object.hasOwn(body, 'cover') ? body.cover : question.cover;
    if (Object.hasOwn(body, 'cover') && cover !== null && (typeof cover !== 'string' || !items.some((work) => work.id === cover))) fail(400, '封面必须是本题现有作品');
    const tags = category !== question.category ? question.tags.filter((tag) => tagKey(tag) !== tagKey(category)) : question.tags;
    return { title, summary, prompt, category, domains, templates, tags, acceptsUploads, cover, references: refs, referenceCredit: credit };
  }
  function saveMeta(actor, question, next, savePrompt = false) {
    if (question.packaged) writePack(actor, question, {
      display_json: JSON.stringify({ ...JSON.parse(override.get(question.id)?.display_json ?? '{}'),
        ...Object.fromEntries(['title', 'summary', 'category', 'domains', 'templates', 'tags', ...(savePrompt ? ['prompt'] : [])].map((key) => [key, next[key]])) }),
      accepts_uploads: Number(next.acceptsUploads), cover_work: next.cover,
    });
    else {
      db.prepare('UPDATE questions SET title = ?, summary = ?, prompt = ?, category = ?, domains = ?, templates = ?, tags = ?, accepts_uploads = ?, cover_work = ?, reference_credit = ? WHERE id = ?')
        .run(next.title, next.summary, next.prompt, next.category, JSON.stringify(next.domains), JSON.stringify(next.templates), JSON.stringify(next.tags), Number(next.acceptsUploads), next.cover, next.referenceCredit, question.id);
      references?.save(question.id, next.references);
    }
  }
  return {
    bindCatalog(value) { catalog = value; },
    all: (viewer = null) => allQuestions().filter(publicQuestion).map((question) => dto(question, viewer)),
    get(id, viewer = null) {
      const question = lookup(id);
      const privileged = question && (viewer?.id === question.owner_id || isStaff(viewer));
      return question && (publicQuestion(question) || privileged) ? dto(question, viewer, privileged ? isSenior(viewer) ? 'admin' : true : false) : null;
    },
    // A rejected question its author can still resubmit: one that was never approved.
    byOwner: (id, viewer = null) => owned.all(id).map(fromRow).map((question) => ({ ...dto(question, viewer, isSenior(viewer) ? 'admin' : true),
      ...(question.moderation.status === 'rejected' ? { resubmittable: !approvedBefore.get(question.id) } : {}) })),
    pendingCount: () => allQuestions().filter((question) => question.moderation.status === 'pending').length,
    adminAll: (viewer = null) => allQuestions().map((question) => adminQuestion(question, viewer)),
    create(user, body, existingTags = []) {
      const category = requireCategory(body.category);
      const domains = body.domains === undefined ? [] : requireDomains(body.domains);
      const title = required(body.title, '题目标题', 70), summary = required(body.summary, '测试简述', 400), prompt = required(body.prompt, '完整提示词', 20000);
      const tags = normalizeTags(body.tags, existingTags, category);
      const credit = referenceCredit(body.referenceCredit), refs = prepareReferences(user, body.references);
      if (!compatibleTemplates(category, body.templates)) fail(400, '提交格式与题目分类不匹配');
      if (!isStaff(user) && pending.get(user.id).n >= 3) fail(429, '你已有 3 道题目在等待审核');
      const id = `q-${randomBytes(8).toString('hex')}`, now = Date.now();
      insert.run(id, user.id, title, summary, prompt, JSON.stringify(tags), JSON.stringify([...new Set(body.templates)]), now,
        JSON.stringify({ status: 'pending', at: now }), category, JSON.stringify(domains), roleOf(user.role), credit);
      references?.save(id, refs);
      audit.run(now, user.id, user.name, 'question-create', id, null, title);
      return dto(fromRow(one.get(id)), user, true);
    },
    createByAdmin(admin, body, existingTags = []) {
      if (!isSenior(admin)) fail(403, '仅高级管理员可以操作');
      return transaction(db, () => this.create(admin, body, existingTags));
    },
    edit(actor, id, body) {
      if (!isSenior(actor)) fail(403, '仅高级管理员可以操作');
      const question = lookup(id);
      if (!question) fail(404, '题目不存在');
      const next = meta(question, body, actor), detail = {};
      for (const field of ['title', 'summary', 'category', 'domains', 'templates', 'tags', 'acceptsUploads', 'cover', 'references', 'referenceCredit']) {
        if (JSON.stringify(question[field]) !== JSON.stringify(next[field])) detail[field] = { from: question[field], to: next[field] };
      }
      if (next.prompt !== question.prompt) detail.prompt = { changed: '已修改', fromLength: question.prompt.length, toLength: next.prompt.length };
      transaction(db, () => { saveMeta(actor, question, next, Object.hasOwn(body, 'prompt') && next.prompt !== question.prompt); audit.run(Date.now(), actor.id, actor.name, 'question-edit', id, null, JSON.stringify(detail)); });
      return dto(lookup(id), actor, 'admin', true);
    },
    review(actor, id, body) {
      if (!isSenior(actor)) fail(403, '仅高级管理员可以操作');
      const question = lookup(id);
      if (!question) fail(404, '题目不存在');
      if (!['approved', 'rejected'].includes(body.status)) fail(400, '题目审核结果无效');
      if (body.reason != null && typeof body.reason !== 'string') fail(400, '审核理由格式不正确');
      const reason = (body.reason ?? '').trim();
      if (reason.length > 500) fail(400, '审核理由最多 500 字');
      if (body.status === 'rejected' && !reason) fail(400, '请填写拒绝理由');
      const next = body.status === 'approved' ? meta(question, { category: body.category ?? question.category,
        ...(body.domains !== undefined ? { domains: body.domains } : {}) }) : question;
      const moderation = { status: body.status, source: 'human', reason, reviewer: actor.name, at: Date.now(),
        ...(question.moderation.round ? { round: question.moderation.round } : {}) }, detail = { ...moderation };
      for (const field of ['category', 'domains', 'templates']) if (JSON.stringify(question[field]) !== JSON.stringify(next[field])) detail[field] = { from: question[field], to: next[field] };
      transaction(db, () => {
        saveMeta(actor, question, next);
        if (question.packaged) writePack(actor, question, { moderation: JSON.stringify(moderation) });
        else db.prepare('UPDATE questions SET moderation = ? WHERE id = ?').run(JSON.stringify(moderation), id);
        audit.run(moderation.at, actor.id, actor.name, 'question-review', id, null, JSON.stringify(detail));
      });
      return dto(lookup(id), actor, 'admin', true);
    },
    // An author answers a rejection on a question that was never public: the edited question waits
    // for review again, keeping the last decision and content so reviewers can compare.
    resubmit(user, id, body) {
      const question = lookup(id);
      if (!question || question.packaged || question.owner_id !== user.id) fail(404, '题目不存在');
      if (question.moderation.status !== 'rejected') fail(409, '只有未通过审核的题目可以修改后重新提交');
      if (approvedBefore.get(id)) fail(409, '公开过的题目不能修改后重新提交');
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请提供要修改的题目信息');
      const { removeSamples = false, ...fields } = body;
      if (typeof removeSamples !== 'boolean') fail(400, '示例结果选项无效');
      if (Object.keys(fields).some((field) => !['title', 'summary', 'prompt', 'category', 'domains', 'templates', 'references', 'referenceCredit'].includes(field))) fail(400, '题目信息格式不正确');
      if (!isStaff(user) && pending.get(user.id).n >= 3) fail(429, '你已有 3 道题目在等待审核');
      const now = Date.now();
      transaction(db, () => {
        const removed = removeSamples ? works.all(id).filter((work) => work.owner_id === user.id) : [];
        for (const work of removed) {
          db.prepare('UPDATE works SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, work.id);
          audit.run(now, user.id, user.name, 'delete', id, work.id, '重新提交题目时移除');
        }
        const next = meta(question, fields, user), detail = {};
        for (const field of ['title', 'summary', 'category', 'domains', 'templates', 'references', 'referenceCredit']) {
          if (JSON.stringify(question[field]) !== JSON.stringify(next[field])) detail[field] = { from: question[field], to: next[field] };
        }
        if (next.prompt !== question.prompt) detail.prompt = { changed: '已修改', fromLength: question.prompt.length, toLength: next.prompt.length };
        if (removed.length) detail.samples = removed.length;
        if (!Object.keys(detail).length) fail(400, '内容和上次相同，请按审核意见修改后再提交');
        const { reason, reviewer, at, round = 1 } = question.moderation;
        const moderation = { status: 'pending', at: now, round: round + 1, previous: { reason, reviewer, at,
          ...Object.fromEntries(['title', 'summary', 'prompt', 'category', 'domains'].map((key) => [key, question[key]])) } };
        saveMeta(user, question, next, true);
        db.prepare('UPDATE questions SET moderation = ? WHERE id = ?').run(JSON.stringify(moderation), id);
        audit.run(now, user.id, user.name, 'question-resubmit', id, null, JSON.stringify(detail));
      });
      return dto(lookup(id), user, true);
    },
    remove(actor, id) {
      const question = lookup(id);
      if (!question) fail(404, '题目不存在');
      if (actor.id !== question.owner_id && !isSenior(actor)) fail(403, '只能删除自己发起的题目');
      const items = itemsFor(id), count = votes.get(id).n;
      if (isSenior(actor) && count > 0) fail(409, '这道题目已有投票记录，不能删除');
      if (!isSenior(actor) && publicQuestion(question) && (count > 0 || items.some((work) => (work.owner_id ?? work.ownerId) !== actor.id))) fail(409, '已经有人作答的题目不能删除');
      const removed = works.all(id).filter((work) => isSenior(actor) || work.owner_id === actor.id), now = Date.now();
      transaction(db, () => {
        for (const work of removed) {
          db.prepare('UPDATE works SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, work.id);
          audit.run(now, actor.id, actor.name, 'delete', id, work.id, '随题目删除');
        }
        if (question.packaged) writePack(actor, question, { deleted_at: now });
        else db.prepare('UPDATE questions SET deleted_at = ? WHERE id = ?').run(now, id);
        audit.run(now, actor.id, actor.name, 'question-delete', id, null, question.title);
      });
      references?.removeQuestion(id);
      return { ok: true, deletedWorks: [...removed.map((work) => work.id), ...(question.packaged ? packWorks(id).map((work) => work.id) : [])] };
    },
  };
}
