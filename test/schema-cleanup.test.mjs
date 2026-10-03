import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

test('v18 preserves v16/v17 metadata, audit actors and frozen vote identities on upgrade and rerun', () => {
  for (const version of [16, 17]) {
    const root = mkdtempSync(join(tmpdir(), 'schema-cleanup-'));
    const file = join(root, 'platform.db');
    let db = new DatabaseSync(file);
    try {
      for (const step of MIGRATIONS.slice(0, version)) typeof step === 'function' ? step(db) : db.exec(step);
      db.exec(`PRAGMA user_version = ${version};
        INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES ('admin', 'Admin', 'admin', 's', 'h', 1);`);
      const insert = db.prepare(`INSERT INTO works (id, task_id, title, model_id, model_name, vendor, tool,
        harness_id, content_key, source_name, root, entry, file_count, bytes, digest, checks,
        created_at, updated_at, reviewed_by, reviewed_at, deleted_by, deleted_at, show_gallery, show_arena, audience)
        VALUES (?, 'one', ?, ?, ?, 'Old vendor', ?, ?, ?, 'original.html', '', 'index.html', 1, 10, ?, '[]',
          1, 60, 'admin', 50, ?, ?, 1, 1, 'hidden')`);
      insert.run('registered', 'Registered', 'm-a', 'Old model name', 'Old tool', 'codex', 'key-a', 'digest-a', null, null);
      insert.run('manual', 'Manual', null, 'Custom model', 'Original tool', null, 'key-b', 'digest-b', 'admin', 60);
      insert.run('audited', 'Audited', null, 'Custom model', '', null, 'key-c', 'digest-c', null, null);
      db.prepare('UPDATE works SET note = ? WHERE id = ?').run('x'.repeat(1000), 'manual');
      db.exec(`INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id)
        VALUES (50, 'admin', 'Admin', 'unverified', 'one', 'audited');`);
      const identity = '{"modelId":"m-a","modelName":"Frozen name","vendor":"Frozen vendor","modelKey":"m-a"}';
      const vote = db.prepare(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice,
        created_at, a_identity, b_identity, a_correction, identity_source, source)
        VALUES (?, ?, 'one', 'registered', 'manual', ?, 'a', 1, ?, ?, ?, ?, ?)`);
      for (const source of ['arena', 'show1', 'legacy']) vote.run(source, `match-${source}`, source,
        source === 'legacy' ? 'm-a' : identity, source === 'legacy' ? 'custom' : identity,
        source === 'arena' ? identity : null, source === 'legacy' ? 'legacy' : 'snapshot', source);
      db.prepare(`INSERT INTO matches (id, task_id, a_work, b_work, a_token, b_token, created_at, expires_at,
        datapack_root, datapack_version, a_identity, b_identity)
        VALUES ('match-arena', 'one', 'registered', 'manual', 'ma', 'mb', 1, 100, '/old-pack', 'pinned', ?, ?)`).run(identity, identity);
      const originalVotes = db.prepare('SELECT * FROM votes ORDER BY id').all().map(({ identity_source, ...row }) => row);
      const originalMatches = db.prepare('SELECT * FROM matches ORDER BY id').all();
      const originalWorks = db.prepare('SELECT * FROM works ORDER BY id').all();
      db.close();
      db = openDatabase(file);
      const works = db.prepare('SELECT * FROM works ORDER BY id').all();
      // v26 adds the entertainment switch; unverified rows stay out of the pool.
      for (const row of originalWorks) Object.assign(row, { show_entertainment: 0, reviewed_gallery_at: null, reviewed_arena_at: null, entertainment_route: 0 });
      for (const [i, row] of works.entries()) {
        const { audience, tool, vendor, reviewed_by, deleted_by, model_name, ...retained } = originalWorks[i];
        assert.deepEqual({ ...row }, { ...retained,
          ...(version === 16 ? { model_version: '', generation_mode: '', human_intervention: '', generated_on: '', evidence_url: '' } : {}),
          model_other: row.model_id ? '' : model_name,
          model_vendor: '',
          author_role: 'user',
          moderation: '{"status":"legacy"}',
          prompt_variant: '',
          harness_other: row.harness_id ? '' : tool,
          note: row.model_id || !vendor ? retained.note : [retained.note, `手填模型厂商：${vendor}`].filter(Boolean).join('\n'),
        });
      }
      assert.deepEqual(db.prepare('SELECT * FROM votes ORDER BY id').all().map((row) => ({ ...row })), originalVotes);
      assert.deepEqual(db.prepare('SELECT * FROM matches ORDER BY id').all(), originalMatches);
      const audits = db.prepare('SELECT work_id, action, actor_id, at FROM audit ORDER BY work_id, action').all();
      assert.deepEqual(audits.map((row) => [row.work_id, row.action, row.actor_id, row.at]), [
        ['audited', 'unverified', 'admin', 50], ['manual', 'delete', 'admin', 60],
        ['manual', 'unverified', 'admin', 50], ['registered', 'unverified', 'admin', 50],
      ]);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'works_audience'").get(), undefined);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      MIGRATIONS[17](db);
      db.close();
      db = openDatabase(file);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
      assert.deepEqual(db.prepare('SELECT * FROM works ORDER BY id').all(), works);
      assert.deepEqual(db.prepare('SELECT work_id, action, actor_id, at FROM audit ORDER BY work_id, action').all(), audits);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
