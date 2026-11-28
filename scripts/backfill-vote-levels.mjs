// Import reviewed historical role evidence into a database copy or prepared release.
import { readFileSync, realpathSync } from 'node:fs';
import { openDatabase, transaction } from '../server/db.mjs';

const [database, evidenceFile, apply] = process.argv.slice(2);
if (!database || !evidenceFile || apply !== '--apply') {
  throw new Error('Usage: backfill-vote-levels.mjs <database> <evidence.json> --apply');
}
const { overrides } = JSON.parse(readFileSync(evidenceFile, 'utf8'));
if (!Array.isArray(overrides) || !overrides.length ||
    overrides.some(row => !row?.id || typeof row.id !== 'string' || ![2, 3].includes(row.level)) ||
    new Set(overrides.map(row => row.id)).size !== overrides.length) {
  throw new Error('Evidence must list unique vote IDs with historical level 2 or 3');
}
const db = openDatabase(realpathSync(database));
try {
  const match = db.prepare(`SELECT vote_id, level FROM votes LEFT JOIN legacy_vote_levels ON vote_id = id
    WHERE id = ? AND source = 'arena' AND user_id IS NOT NULL AND voter_level IS NULL`);
  const insert = db.prepare('INSERT INTO legacy_vote_levels (vote_id, level) VALUES (?, ?)');
  const added = transaction(db, () => {
    let count = 0;
    for (const { id, level } of overrides) {
      const prior = match.get(id);
      if (!prior || (prior.level != null && prior.level !== level)) throw new Error(`Conflicting or ineligible vote: ${id}`);
      if (prior.level == null) count += Number(insert.run(id, level).changes);
    }
    return count;
  });
  console.log(JSON.stringify({ reviewed: overrides.length, added }));
} finally {
  db.close();
}
