// Existing domain tests do not wait on wall-clock viewing. New timing tests exercise
// the real ready/vote endpoints and exact boundaries separately.
export function finishViewing(db, id, elapsed = 11000) {
  const at = Date.now() - elapsed;
  db.prepare('UPDATE matches SET ready_at=?,created_at=MIN(created_at,?) WHERE id=?').run(at, at, id);
}
export function voteAfterViewing(platform, user, id, choice) {
  finishViewing(platform.db, id);
  return platform.arena.vote(user, id, choice);
}
