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
  const clients = new Set();
  const latestId = () => db.prepare('SELECT MAX(id) AS id FROM announcements').get().id ?? 0;
  const broadcast = id => {
    const message = `event: announcement\ndata: ${JSON.stringify({ id })}\n\n`;
    for (const client of clients) {
      try { client.res.write(message); }
      catch { client.close(); }
    }
  };
  return {
    published() {
      return { entries: db.prepare('SELECT id,title,body,published_at FROM announcements ORDER BY id DESC').all().map(publicEntry) };
    },
    create(actor, input) {
      const { title, body } = validate(input);
      const result = db.prepare('INSERT INTO announcements(title,body,published_at,created_by) VALUES (?,?,?,?)')
        .run(title, body, Date.now(), actor.id);
      const entry = publicEntry(db.prepare('SELECT * FROM announcements WHERE id=?').get(Number(result.lastInsertRowid)));
      broadcast(entry.id);
      return { entry };
    },
    subscribe(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      res.write(`event: announcement\ndata: ${JSON.stringify({ id: latestId() })}\n\n`);
      const client = { res, close: () => {} };
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 25000);
      heartbeat.unref();
      client.close = () => { clearInterval(heartbeat); clients.delete(client); if (!res.destroyed) res.end(); };
      clients.add(client);
      res.once('close', client.close);
    },
    close() { for (const client of clients) client.close(); },
  };
}
