import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('release cleanup preserves current and recently expired matches, and requires apply', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-cleanup-')));
  try {
    const versions = join(root, 'versions'), data = join(root, 'data');
    mkdirSync(versions); mkdirSync(data);
    const dirs = ['a', 'b', 'c'].map(letter => {
      const sha = letter.repeat(40), dir = join(versions, sha);
      mkdirSync(dir); writeFileSync(join(dir, '.datapack-source.json'), JSON.stringify({ source: 'github', commit: sha }));
      utimesSync(dir, new Date(0), new Date(0)); return dir;
    });
    const db = new DatabaseSync(join(data, 'platform.db'));
    db.exec('CREATE TABLE matches (datapack_root TEXT, expires_at INTEGER)');
    db.prepare('INSERT INTO matches VALUES (?, ?)').run(dirs[1], Date.now() - 1000);
    db.prepare('INSERT INTO matches VALUES (?, ?)').run(dirs[2], Date.now() - 7200000);
    db.close();
    const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/datapack.mjs');
    const run = args => execFileSync(process.execPath, [script, 'prune', ...args], {
      env: { ...process.env, DATAPACK_VERSIONS_DIR: versions, DIST_DIR: dirs[0], DATA_DIR: data, DATAPACK_CLEANUP_GRACE_MS: '3600000' }, encoding: 'utf8',
    });
    assert.match(run([]), /Would remove/);
    assert.ok(dirs.every(existsSync));
    assert.match(run(['--apply']), /Remove/);
    assert.ok(existsSync(dirs[0])); assert.ok(existsSync(dirs[1])); assert.equal(existsSync(dirs[2]), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
