import { fail } from './http.mjs';

const publicEntry = row => ({ id: row.id, title: row.title, body: row.body,
  publishedAt: new Date(row.published_at).toISOString() });

function validate(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim().replace(/\r\n?/g, '\n') : '';
  if (!title || title.length > 100) fail(400, '公告标题须为 1 至 100 字');
  if (!body || body.length > 20000) fail(400, '公告 Markdown 正文须为 1 至 20000 字');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + body)) fail(400, '公告不能包含控制字符');
  return { title, body };
}

export function createAnnouncements(db) {
  return {
    published() {
      return { entries: db.prepare('SELECT id,title,body,published_at FROM announcements ORDER BY id DESC').all().map(publicEntry) };
    },
    create(actor, input) {
      const { title, body } = validate(input);
      const result = db.prepare('INSERT INTO announcements(title,body,published_at,created_by) VALUES (?,?,?,?)')
        .run(title, body, Date.now(), actor.id);
      return { entry: publicEntry(db.prepare('SELECT * FROM announcements WHERE id=?').get(Number(result.lastInsertRowid))) };
    },
  };
}

// The live stream is retired; clients poll GET /api/announcements. Pages that still
// open an EventSource get 204, which per the HTML spec stops it from reconnecting.
export function retiredAnnouncementStream(req, res) {
  res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end();
}
