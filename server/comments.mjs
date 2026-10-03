// Comments belong to listed works, including packaged works that are not SQLite rows.
import { newId } from './auth.mjs';
import { fail } from './http.mjs';

export function createComments(db, library) {
  const q = {
    byWork: db.prepare(`SELECT comments.id, comments.body, comments.created_at, comments.user_id,
      COALESCE(NULLIF(users.nickname, ''), users.name) AS author
      FROM comments LEFT JOIN users ON users.id = comments.user_id
      WHERE task_id = ? AND work_id = ? AND deleted_at IS NULL
      ORDER BY comments.created_at DESC, comments.id DESC LIMIT 100`),
    byId: db.prepare('SELECT id, user_id, deleted_at FROM comments WHERE id = ?'),
    insert: db.prepare('INSERT INTO comments (id, task_id, work_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    remove: db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
  };

  const listed = (taskId, workId) => {
    const work = library.work(taskId, workId);
    if (!work || work.status !== 'verified' ||
      (!library.visibleTo(work, 'show1') && !library.visibleTo(work, 'show2'))) fail(404, '作品不存在');
  };
  const publicComment = (row, viewer) => ({
    id: row.id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    author: row.author ?? null,
    mine: Boolean(viewer && viewer.id === row.user_id),
    canDelete: Boolean(viewer && (viewer.id === row.user_id || viewer.role === 'admin')),
  });

  return {
    list(viewer, taskId, workId) {
      listed(taskId, workId);
      return q.byWork.all(taskId, workId).map((row) => publicComment(row, viewer));
    },
    create(user, taskId, workId, body) {
      listed(taskId, workId);
      if (typeof body !== 'string' || !body.trim() || body.trim().length > 280) fail(400, '请输入 1–280 字的评论');
      const id = newId();
      const createdAt = Date.now();
      q.insert.run(id, taskId, workId, user.id, body.trim(), createdAt);
      return publicComment({ id, body: body.trim(), created_at: createdAt, user_id: user.id, author: user.nickname || user.name }, user);
    },
    remove(user, id) {
      const row = q.byId.get(id);
      if (!row || row.deleted_at !== null) fail(404, '评论不存在');
      if (row.user_id !== user.id && user.role !== 'admin') fail(403, '只能删除自己的评论');
      q.remove.run(Date.now(), id);
    },
  };
}
