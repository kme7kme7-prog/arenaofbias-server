// Personal activity comes from participation records, including past submissions.
// Received reactions count other people on the member's currently published works.
import { EMOJIS } from './config.mjs';

const DAY = 86400000;

export function createProfile(db) {
  const activity = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS date, COUNT(*) AS count
    FROM (
      SELECT created_at FROM questions WHERE owner_id = $owner AND deleted_at IS NULL
      UNION ALL SELECT created_at FROM works WHERE owner_id = $owner
      UNION ALL SELECT created_at FROM votes WHERE user_id = $owner
      UNION ALL SELECT created_at FROM reactions WHERE user_id = $owner
    ) WHERE created_at >= $since AND created_at < $until
    GROUP BY date ORDER BY date`);
  const reactions = db.prepare(`
    SELECT reactions.emoji, COUNT(*) AS count FROM reactions
    JOIN works ON works.id = reactions.work_id AND works.task_id = reactions.task_id
    WHERE works.owner_id = ? AND works.deleted_at IS NULL AND reactions.user_id != ?
    GROUP BY reactions.emoji`);

  return {
    summary(user) {
      const to = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const until = Date.parse(`${to}T00:00:00+08:00`) + DAY;
      const since = until - 365 * DAY;
      const from = new Date(since + 8 * 3600000).toISOString().slice(0, 10);
      const days = activity.all({ owner: user.id, since, until });
      const counts = Object.fromEntries(reactions.all(user.id, user.id).filter((row) => EMOJIS.includes(row.emoji)).map((row) => [row.emoji, row.count]));
      return {
        joinedAt: new Date(user.created_at).toISOString(),
        activity: { from, to, days, total: days.reduce((sum, day) => sum + day.count, 0), activeDays: days.length },
        receivedReactions: { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) },
      };
    },
  };
}
