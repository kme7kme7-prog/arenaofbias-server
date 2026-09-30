// Community questions follow the original publish flow and live alongside the curated
// archive. Prompt text is stored verbatim (apart from outer whitespace), at version 1.
import { randomBytes } from 'node:crypto';
import { avatarOf } from './auth.mjs';
import { fail } from './http.mjs';

const tagName = (value) => String(value).normalize('NFKC').trim().replace(/^#+/, '').trim();
const tagKey = (value) => tagName(value).toLowerCase();

function required(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `请填写${label}`);
  if (value.trim().length > max) fail(400, `${label}最多 ${max} 字`);
  return value.trim();
}

export function normalizeTags(input, existing = []) {
  if (!Array.isArray(input) || !input.length) fail(400, '请至少添加一个标签');
  const names = new Map(existing.map((name) => [tagKey(name), name]));
  const unique = new Map();
  for (const raw of input) {
    if (typeof raw !== 'string') fail(400, '标签格式不正确');
    const name = tagName(raw), key = tagKey(name);
    if (!key || name.length > 24 || /[<>{}\n\r,，]/.test(name)) fail(400, '标签为 1–24 字，不能包含特殊符号');
    unique.set(key, names.get(key) ?? name);
  }
  if (unique.size > 6) fail(400, '每道题最多添加 6 个标签');
  return [...unique.values()];
}

export function createQuestions(db) {
  const select = `SELECT questions.*, COALESCE(NULLIF(users.nickname, ''), users.name) AS owner_name, users.avatar AS owner_avatar FROM questions JOIN users ON users.id = questions.owner_id`;
  const all = db.prepare(`${select} ORDER BY questions.created_at DESC, questions.id`);
  const one = db.prepare(`${select} WHERE questions.id = ?`);
  const owned = db.prepare(`${select} WHERE questions.owner_id = ? ORDER BY questions.created_at DESC, questions.id`);
  const insert = db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const fromRow = (row) => row ? {
    id: row.id, title: row.title, summary: row.summary, prompt: row.prompt,
    tags: JSON.parse(row.tags), templates: JSON.parse(row.templates),
    owner: row.owner_name, ownerAvatar: avatarOf({ id: row.owner_id, avatar: row.owner_avatar }), version: row.version, community: true,
    createdAt: new Date(row.created_at).toISOString(),
    date: new Date(row.created_at).toISOString().slice(0, 10),
  } : null;

  return {
    all: () => all.all().map(fromRow),
    get: (id) => fromRow(one.get(id)),
    byOwner: (id) => owned.all(id).map(fromRow),
    create(user, body, existingTags = []) {
      const title = required(body.title, '题目标题', 70);
      const summary = required(body.summary, '测试简述', 400);
      const prompt = required(body.prompt, '完整提示词', 20000);
      const tags = normalizeTags(body.tags, existingTags);
      const templates = Array.isArray(body.templates) ? [...new Set(body.templates)] : ['static', 'vite'];
      if (!templates.length || templates.some((type) => !['static', 'vite'].includes(type))) fail(400, '请至少选择一种有效的提交格式');
      const id = `q-${randomBytes(8).toString('hex')}`;
      insert.run(id, user.id, title, summary, prompt, JSON.stringify(tags), JSON.stringify(templates), Date.now());
      return fromRow(one.get(id));
    },
  };
}
