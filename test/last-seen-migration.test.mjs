import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

test('the last-seen migration backfills account activity from live sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'last-seen-migration-'));
  const file = join(root, 'platform.db');
  const version = MIGRATIONS.findLastIndex((migration) => String(migration).includes('users ADD COLUMN last_seen_at'));
  let db = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, version)) typeof migration === 'function' ? migration(db) : db.exec(migration);
    db.exec(`PRAGMA user_version = ${version}`);
    const user = db.prepare("INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, 'user', 'salt', 'hash', 1)");
    for (const id of ['active', 'idle']) user.run(id, id, id);
    db.exec(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES
      ('a1', 'active', 1, 9999, 50), ('a2', 'active', 1, 9999, 80)`);
    db.close(); db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.deepEqual(db.prepare('SELECT id, last_seen_at FROM users ORDER BY id').all().map((row) => ({ ...row })),
      [{ id: 'active', last_seen_at: 80 }, { id: 'idle', last_seen_at: null }]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
