// Successful historical votes for tests of question flows unrelated to the entry threshold.
export function seedQuestionVotes(db, userId, count = 100, start = 0) {
  const insert = db.prepare(`INSERT INTO votes (id, match_id, user_id, task_id, a_work, b_work, pair_key, choice, created_at)
    VALUES (?, ?, ?, 'eligibility-fixture', 'a', ?, ?, 'a', 1)`);
  for (let i = start; i < start + count; i++) {
    const id = `eligibility-${userId}-${i}`;
    insert.run(id, id, userId, id, id);
  }
}
