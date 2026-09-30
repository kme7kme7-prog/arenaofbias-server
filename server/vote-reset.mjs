import { transaction } from './db.mjs';

export function voteResetCounts(db) {
  return {
    votes: db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,
    matches: db.prepare('SELECT COUNT(*) AS n FROM matches').get().n,
    sources: db.prepare('SELECT source, COUNT(*) AS votes FROM votes GROUP BY source ORDER BY source').all(),
  };
}

// Reset both sites together. Clearing matches also invalidates pre-reset arena
// tokens; clearing votes removes the per-user pair deduplication records.
export function resetVotes(db, actorName, backup) {
  return transaction(db, () => {
    const before = voteResetCounts(db);
    db.exec('DELETE FROM votes; DELETE FROM matches;');
    db.prepare(`INSERT INTO audit (at, actor_name, action, detail)
      VALUES (?, ?, 'votes-reset', ?)`).run(Date.now(), actorName, JSON.stringify({ ...before, backup }));
    return before;
  });
}
