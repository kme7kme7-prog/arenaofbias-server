import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

test('v24 preserves email codes, permits registration and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'email-registration-migration-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, 23)) {
      if (typeof migration === 'function') migration(db); else db.exec(migration);
    }
    db.exec('PRAGMA user_version = 23');
    const insert = db.prepare('INSERT INTO email_codes VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('bind', 'bind-email', 'bind-code', 100, 2, 10);
    insert.run('reset', 'reset-email', 'reset-code', 200, 3, 20);
    const oldRows = db.prepare('SELECT * FROM email_codes ORDER BY purpose').all();
    assert.throws(() => insert.run('register', 'new-email', 'new-code', 300, 0, 30), /CHECK constraint failed/);
    db.close(); db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.deepEqual(db.prepare('SELECT * FROM email_codes ORDER BY purpose').all(), oldRows);
    db.prepare('INSERT INTO email_codes VALUES (?, ?, ?, ?, ?, ?)').run('register', 'new-email', 'new-code', 300, 0, 30);
    const rows = db.prepare('SELECT * FROM email_codes ORDER BY purpose').all();
    const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'email_codes' ORDER BY name").all();
    assert.ok(schema.some(entry => entry.name === 'email_codes_expiry'));
    assert.throws(() => db.prepare('INSERT INTO email_codes VALUES (?, ?, ?, ?, ?, ?)').run('other', 'new-email', 'new-code', 300, 0, 30), /CHECK constraint failed/);
    MIGRATIONS[23](db);
    assert.deepEqual(db.prepare('SELECT * FROM email_codes ORDER BY purpose').all(), rows);
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'email_codes' ORDER BY name").all(), schema);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
