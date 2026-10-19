import { fail } from './http.mjs';

const publicEntry = row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body,
  titleEn: row.title_en, bodyEn: row.body_en, link: row.link, publishedOn: row.published_on });
const adminEntry = row => ({ ...publicEntry(row), status: row.status,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });

function validate(input) {
  const { kind, status } = input;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = input.body;
  const titleEn = input.titleEn ?? '', bodyEn = input.bodyEn ?? '', link = input.link ?? '';
  const publishedOn = input.publishedOn ?? new Date().toISOString().slice(0, 10);
  if (!['feature', 'improve', 'fix', 'rule'].includes(kind)) fail(400, '请选择有效的更新类型');
  if (!title || title.length > 60) fail(400, '中文标题须为 1 至 60 字');
  if (typeof body !== 'string' || body.length < 1 || body.length > 4000) fail(400, '中文正文须为 1 至 4000 字');
  if (typeof titleEn !== 'string' || titleEn.length > 120) fail(400, '英文标题最多 120 字符');
  if (typeof bodyEn !== 'string' || bodyEn.length > 8000) fail(400, '英文正文最多 8000 字符');
  if (Boolean(titleEn) !== Boolean(bodyEn)) fail(400, '英文标题和正文请同时填写或同时留空');
  if (typeof link !== 'string' || link.length > 300 || (link && !link.startsWith('#/') && !link.startsWith('https://'))) {
    fail(400, '链接须以 #/ 或 https:// 开头，且最多 300 字符');
  }
  const date = typeof publishedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(publishedOn) ? new Date(`${publishedOn}T00:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== publishedOn) fail(400, '发布日期须为有效的 YYYY-MM-DD 日期');
  if (!['draft', 'published'].includes(status)) fail(400, '请选择草稿或已发布状态');
  return [kind, title, body, titleEn, bodyEn, link, publishedOn, status];
}

export function createChangelog(db) {
  const get = id => db.prepare('SELECT * FROM changelog_entries WHERE id=?').get(id) ?? fail(404, '这条更新不存在');
  return {
    published(value) {
      const limit = /^\d+$/.test(value ?? '') ? Number(value) : 0;
      const entries = db.prepare(`SELECT * FROM changelog_entries WHERE status='published' ORDER BY published_on DESC,id DESC${limit >= 1 && limit <= 100 ? ' LIMIT ?' : ''}`)
        .all(...(limit >= 1 && limit <= 100 ? [limit] : [])).map(publicEntry);
      return { entries, total: db.prepare("SELECT COUNT(*) AS total FROM changelog_entries WHERE status='published'").get().total };
    },
    all() {
      return { entries: db.prepare('SELECT * FROM changelog_entries ORDER BY published_on DESC,id DESC').all().map(adminEntry) };
    },
    create(actor, input) {
      const values = validate(input), now = Date.now();
      const result = db.prepare(`INSERT INTO changelog_entries(kind,title,body,title_en,body_en,link,published_on,status,created_by,updated_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, actor.id, actor.id, now, now);
      return { entry: adminEntry(get(Number(result.lastInsertRowid))) };
    },
    update(actor, id, input) {
      get(id);
      db.prepare(`UPDATE changelog_entries SET kind=?,title=?,body=?,title_en=?,body_en=?,link=?,published_on=?,status=?,updated_by=?,updated_at=? WHERE id=?`)
        .run(...validate(input), actor.id, Date.now(), id);
      return { entry: adminEntry(get(id)) };
    },
    remove(id) {
      if (!db.prepare('DELETE FROM changelog_entries WHERE id=?').run(id).changes) fail(404, '这条更新不存在');
      return { ok: true };
    },
  };
}
