// SQLite through Node's built-in driver (Node ≥ 22.13). Schema changes are appended to
// MIGRATIONS and applied in order, tracked by PRAGMA user_version.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
     salt TEXT NOT NULL,
     hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE drafts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     task_id TEXT NOT NULL,
     token TEXT NOT NULL UNIQUE,
     source_name TEXT NOT NULL,
     root TEXT NOT NULL,
     entry TEXT NOT NULL,
     file_count INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     digest TEXT NOT NULL,
     checks TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE works (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     model_id TEXT,
     model_name TEXT NOT NULL,
     vendor TEXT NOT NULL DEFAULT '',
     effort TEXT NOT NULL DEFAULT '',
     tool TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'questioned')),
     status_reason TEXT NOT NULL DEFAULT '',
     reviewed_by TEXT,
     reviewed_at INTEGER,
     content_key TEXT NOT NULL UNIQUE,
     source_name TEXT NOT NULL,
     root TEXT NOT NULL,
     entry TEXT NOT NULL,
     file_count INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     digest TEXT NOT NULL,
     checks TEXT NOT NULL,
     trial TEXT NOT NULL DEFAULT '{}',
     captures TEXT NOT NULL DEFAULT '{}',
     cover TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     deleted_by TEXT
   );
   CREATE INDEX works_task ON works (task_id, status);
   CREATE INDEX works_owner ON works (owner_id);
   CREATE TABLE reactions (
     task_id TEXT NOT NULL,
     work_id TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     emoji TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (task_id, work_id, user_id, emoji)
   );
   CREATE TABLE matches (
     id TEXT PRIMARY KEY,
     user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
     task_id TEXT NOT NULL,
     a_work TEXT NOT NULL,
     b_work TEXT NOT NULL,
     a_token TEXT NOT NULL UNIQUE,
     b_token TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     choice TEXT CHECK (choice IN ('a', 'b', 'tie', 'skip')),
     decided_at INTEGER
   );
   CREATE INDEX matches_user ON matches (user_id, created_at);
   CREATE TABLE votes (
     id TEXT PRIMARY KEY,
     match_id TEXT NOT NULL UNIQUE,
     user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
     task_id TEXT NOT NULL,
     a_work TEXT NOT NULL,
     b_work TEXT NOT NULL,
     pair_key TEXT NOT NULL,
     choice TEXT NOT NULL CHECK (choice IN ('a', 'b', 'tie')),
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, pair_key)
   );
   CREATE INDEX votes_task ON votes (task_id, created_at);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor_id TEXT,
     actor_name TEXT NOT NULL,
     action TEXT NOT NULL,
     task_id TEXT,
     work_id TEXT,
     detail TEXT NOT NULL DEFAULT ''
   );`,
  `CREATE TABLE questions (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL REFERENCES users (id),
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     prompt TEXT NOT NULL,
     tags TEXT NOT NULL,
     templates TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX questions_owner ON questions (owner_id);`,
  `ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE matches ADD COLUMN datapack_root TEXT;
   ALTER TABLE matches ADD COLUMN datapack_version TEXT;
   ALTER TABLE matches ADD COLUMN a_identity TEXT;
   ALTER TABLE matches ADD COLUMN b_identity TEXT;
   ALTER TABLE votes ADD COLUMN a_identity TEXT;
   ALTER TABLE votes ADD COLUMN b_identity TEXT;
   ALTER TABLE votes ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'legacy';
   CREATE INDEX matches_datapack_expiry ON matches (datapack_root, expires_at);`,
  `ALTER TABLE votes ADD COLUMN a_correction TEXT;
   ALTER TABLE votes ADD COLUMN b_correction TEXT;`,
  `ALTER TABLE users ADD COLUMN hash_params TEXT;
   CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     work_id TEXT NOT NULL,
     user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     deleted_at INTEGER
   );
   CREATE INDEX comments_visible_work ON comments (task_id, work_id, created_at, id) WHERE deleted_at IS NULL;`,
  `ALTER TABLE works ADD COLUMN audience TEXT NOT NULL DEFAULT 'show2'
     CHECK (audience IN ('hidden', 'show1', 'show2', 'both'));
   CREATE INDEX works_audience ON works (audience, status, task_id) WHERE deleted_at IS NULL;`,
  // Show1 compatibility (fusion/show1-adapter/DESIGN.md): votes carry a write origin
  // ('arena' = platform blind matches, 'legacy' = pre-v8 rows incl. migrated Show1 votes,
  // 'show1' = new compat-layer votes) so Bradley–Terry only scores arena votes; compat
  // votes remember their old mode. Comments gain the Show1 side the commenter backed.
  // Migrated legacy a_identity/b_identity values are bare model ids, not JSON snapshots.
  // page_views and guess_results serve the compat track and guess endpoints.
  `ALTER TABLE votes ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
   UPDATE votes SET source = 'arena' WHERE identity_source = 'snapshot';
   ALTER TABLE votes ADD COLUMN compat_mode TEXT;
   ALTER TABLE comments ADD COLUMN side TEXT;
   CREATE TABLE page_views (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     day TEXT,
     path TEXT,
     ip_hash TEXT,
     created_at INTEGER
   );
   CREATE TABLE guess_results (
     id TEXT PRIMARY KEY,
     day_key TEXT,
     difficulty INTEGER,
     answer_id TEXT,
     won INTEGER,
     attempts INTEGER,
     ip_hash TEXT,
     user_id TEXT,
     created_at INTEGER
   );`,
  `ALTER TABLE works ADD COLUMN show_gallery INTEGER NOT NULL DEFAULT 1 CHECK (show_gallery IN (0, 1));
   ALTER TABLE works ADD COLUMN show_arena INTEGER NOT NULL DEFAULT 1 CHECK (show_arena IN (0, 1));
   ALTER TABLE works ADD COLUMN calibration_arena TEXT;
   UPDATE works SET show_gallery = CASE audience WHEN 'both' THEN 1 WHEN 'show2' THEN 1 ELSE 0 END,
                    show_arena = CASE audience WHEN 'both' THEN 1 WHEN 'show1' THEN 1 ELSE 0 END;
   CREATE TABLE work_overrides (
     task_id TEXT NOT NULL,
     work_id TEXT NOT NULL,
     show_gallery INTEGER NOT NULL DEFAULT 1 CHECK (show_gallery IN (0, 1)),
     show_arena INTEGER NOT NULL DEFAULT 1 CHECK (show_arena IN (0, 1)),
     calibration_gallery TEXT,
     calibration_arena TEXT,
     updated_by TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (task_id, work_id)
   );
   CREATE TABLE task_editorial (
     task_id TEXT NOT NULL,
     face TEXT NOT NULL CHECK (face IN ('arena', 'gallery')),
     commentary TEXT NOT NULL DEFAULT '',
     weights_json TEXT,
     updated_by TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (task_id, face)
   );`,
  // 存量作品（Show1 迁入）在展览馆面全部重置为待审：展览馆显示改为逐件审核通过，
  // 与分面审核的规则一致；竞技场面保持原状（娱乐面走快照，不受影响）。
  `UPDATE works SET show_gallery = 0, audience = CASE WHEN show_arena = 1 THEN 'show1' ELSE 'hidden' END WHERE deleted_at IS NULL;`,
  // 「收录为馆藏」的标记：收录中的投稿退出所有公开列表和配对池，由馆藏双胞胎接管。
  `ALTER TABLE works ADD COLUMN curated_as TEXT;`,
  // A partially prepared database may already have one of these nullable columns.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    for (const [name, type] of Object.entries({ nominated_at: 'INTEGER', nominated_by: 'TEXT',
      export_token_hash: 'TEXT', export_expires_at: 'INTEGER' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE works ADD COLUMN ${name} ${type}`);
    }
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    if (!columns.has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    if (!columns.has('email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
      CREATE TABLE IF NOT EXISTS email_codes (
        purpose TEXT NOT NULL CHECK (purpose IN ('bind', 'reset')),
        email_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_sent_at INTEGER NOT NULL,
        PRIMARY KEY (purpose, email_hash)
      );
      CREATE INDEX IF NOT EXISTS email_codes_expiry ON email_codes(expires_at);`);
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(votes)').all().map((column) => column.name));
    if (!columns.has('compat_weights_json')) db.exec('ALTER TABLE votes ADD COLUMN compat_weights_json TEXT');
    if (!columns.has('compat_weight_source')) db.exec('ALTER TABLE votes ADD COLUMN compat_weight_source TEXT');
    if (!['source', 'task_id', 'created_at'].every((column) => columns.has(column))) return;
    const snapshot = JSON.parse(readFileSync(new URL('./show1/compat-data.json', import.meta.url), 'utf8'));
    const defaults = new Map(snapshot.prompts.map((prompt) => [snapshot.taskByRound[prompt.id], prompt.weights ?? null]));
    const history = new Map();
    const audits = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get()
      ? db.prepare("SELECT task_id, at, id, detail FROM audit WHERE action = 'editorial' ORDER BY at, id").all() : [];
    for (const row of audits) {
      let detail;
      try { detail = JSON.parse(row.detail); } catch { continue; }
      if (detail?.face !== 'arena' || !Array.isArray(detail.weights)) continue;
      if (!history.has(row.task_id)) history.set(row.task_id, []);
      history.get(row.task_id).push({ at: row.at, weights: detail.weights });
    }
    const save = db.prepare('UPDATE votes SET compat_weights_json = ?, compat_weight_source = ? WHERE id = ?');
    for (const vote of db.prepare("SELECT id, task_id, created_at FROM votes WHERE source = 'show1' AND compat_weights_json IS NULL").all()) {
      const audit = history.get(vote.task_id)?.filter((entry) => entry.at <= vote.created_at).at(-1);
      const weights = audit?.weights ?? defaults.get(vote.task_id);
      if (weights) save.run(JSON.stringify(weights), audit ? 'audit' : 'original', vote.id);
    }
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(guess_results)').all().map((column) => column.name));
    if (!columns.has('superseded')) db.exec('ALTER TABLE guess_results ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS guess_day_salts (day_key TEXT PRIMARY KEY, salt TEXT NOT NULL);
      UPDATE guess_results AS result SET superseded = 1
      WHERE superseded = 0 AND EXISTS (
        SELECT 1 FROM guess_results AS earlier
        WHERE earlier.day_key = result.day_key
        AND ((result.ip_hash IS NOT NULL AND earlier.ip_hash = result.ip_hash)
          OR (result.user_id IS NOT NULL AND earlier.user_id = result.user_id))
        AND (COALESCE(earlier.created_at, -9223372036854775808) < COALESCE(result.created_at, -9223372036854775808)
          OR (COALESCE(earlier.created_at, -9223372036854775808) = COALESCE(result.created_at, -9223372036854775808)
            AND earlier.id < result.id))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS guess_result_ip_day ON guess_results(day_key, ip_hash) WHERE superseded = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS guess_result_user_day ON guess_results(day_key, user_id) WHERE superseded = 0 AND user_id IS NOT NULL;`);
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    const idCheck = (column) => `CHECK (${column} IS NULL OR (length(${column}) BETWEEN 1 AND 40 AND ${column} NOT GLOB '*[^a-z0-9.-]*'))`;
    for (const [name, type] of Object.entries({
      harness_id: `TEXT ${idCheck('harness_id')}`,
      harness_other: "TEXT NOT NULL DEFAULT '' CHECK (length(harness_other) <= 40)",
      harness_version: "TEXT NOT NULL DEFAULT '' CHECK (length(harness_version) <= 40)",
      provider_id: `TEXT ${idCheck('provider_id')}`,
      provider_other: "TEXT NOT NULL DEFAULT '' CHECK (length(provider_other) <= 40)",
    })) if (!columns.has(name)) db.exec(`ALTER TABLE works ADD COLUMN ${name} ${type}`);
    db.exec(`CREATE INDEX IF NOT EXISTS works_harness ON works (harness_id) WHERE deleted_at IS NULL AND harness_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS works_provider ON works (provider_id) WHERE deleted_at IS NULL AND provider_id IS NOT NULL;`);
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    for (const [name, check] of Object.entries({
      model_version: 'length(model_version) <= 60',
      generation_mode: "generation_mode IN ('', 'single-turn', 'multi-turn', 'agent')",
      human_intervention: "human_intervention IN ('', 'none', 'prompt-guided', 'code-edited')",
      generated_on: "generated_on = '' OR (length(generated_on) = 10 AND generated_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')",
      evidence_url: 'length(evidence_url) <= 2000',
    })) if (!columns.has(name)) db.exec(`ALTER TABLE works ADD COLUMN ${name} TEXT NOT NULL DEFAULT '' CHECK (${check})`);
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    if (columns.has('tool')) db.exec(`UPDATE works SET harness_other = tool
      WHERE tool <> '' AND harness_id IS NULL AND harness_other = '';`);
    if (columns.has('vendor')) db.exec(`UPDATE works SET note =
      CASE WHEN note = '' THEN '' ELSE note || char(10) END || '手填模型厂商：' || vendor
      WHERE model_id IS NULL AND vendor <> '';`);
    // Preserve actors from old rows that have no corresponding audit entry.
    for (const [actor, at, actions, fallback] of [
      ['reviewed_by', 'reviewed_at', "'verified', 'questioned', 'unverified'", 'status'],
      ['deleted_by', 'deleted_at', "'delete'", "'delete'"],
    ]) if (columns.has(actor)) db.exec(`INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail)
      SELECT COALESCE(works.${at}, works.updated_at), works.${actor}, COALESCE(users.name, works.${actor}),
        ${fallback}, works.task_id, works.id, 'Migrated from works.${actor}'
      FROM works LEFT JOIN users ON users.id = works.${actor}
      WHERE works.${actor} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audit WHERE work_id = works.id AND action IN (${actions})
          AND actor_id = works.${actor} AND at >= COALESCE(works.${at}, works.updated_at)
      );`);
    if (columns.has('model_name')) db.exec('ALTER TABLE works RENAME COLUMN model_name TO model_other');
    if (columns.has('model_name') || columns.has('model_other')) db.exec("UPDATE works SET model_other = '' WHERE model_id IS NOT NULL");
    db.exec('DROP INDEX IF EXISTS works_audience');
    for (const name of ['audience', 'tool', 'vendor', 'reviewed_by', 'deleted_by']) {
      if (columns.has(name)) db.exec(`ALTER TABLE works DROP COLUMN ${name}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS audit_work_review ON audit(work_id, id DESC)
      WHERE action IN ('verified', 'questioned', 'unverified');`);
    const voteColumns = new Set(db.prepare('PRAGMA table_info(votes)').all().map((column) => column.name));
    if (voteColumns.has('identity_source')) db.exec('ALTER TABLE votes DROP COLUMN identity_source');
  },
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    if (!columns.has('moderation')) db.exec(`ALTER TABLE works ADD COLUMN moderation TEXT NOT NULL DEFAULT '{"status":"legacy"}'`);
  },
  // An avatar picked from the library; '' keeps the default derived from the user id.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    if (!columns.has('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  },
  // Which prompt version of a task an upload answers; '' for tasks with a single prompt.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    if (!columns.has('prompt_variant')) db.exec("ALTER TABLE works ADD COLUMN prompt_variant TEXT NOT NULL DEFAULT ''");
  },
  // Existing questions remain public; new submissions require human approval.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(questions)').all().map((column) => column.name));
    if (!columns.has('moderation')) db.exec(`ALTER TABLE questions ADD COLUMN moderation TEXT NOT NULL DEFAULT '{"status":"legacy"}'`);
    if (!columns.has('deleted_at')) db.exec('ALTER TABLE questions ADD COLUMN deleted_at INTEGER');
  },
  // Classify old platform questions from their tags, then their text-only format.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(questions)').all().map((column) => column.name));
    if (!columns.has('category')) db.exec('ALTER TABLE questions ADD COLUMN category TEXT');
    db.exec(`UPDATE questions SET category = COALESCE(
      (SELECT value FROM json_each(questions.tags) WHERE value IN ('文学', '静态网页', '建模') ORDER BY key LIMIT 1),
      CASE WHEN json_array_length(templates) = 1 AND json_extract(templates, '$[0]') = 'text' THEN '文学' END
    ) WHERE category IS NULL`);
  },
  // Registration codes use the same storage and limits as binding and reset codes.
  (db) => {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_codes'").get().sql;
    if (schema.includes("'register'")) return;
    db.exec(`CREATE TABLE email_codes_v24 (
      purpose TEXT NOT NULL CHECK (purpose IN ('bind', 'reset', 'register')),
      email_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER NOT NULL,
      PRIMARY KEY (purpose, email_hash)
    );
    INSERT INTO email_codes_v24 (purpose, email_hash, code_hash, expires_at, attempts, last_sent_at)
      SELECT purpose, email_hash, code_hash, expires_at, attempts, last_sent_at FROM email_codes;
    DROP TABLE email_codes;
    ALTER TABLE email_codes_v24 RENAME TO email_codes;
    CREATE INDEX email_codes_expiry ON email_codes(expires_at);`);
  },
  // Collapse registered and free-text providers into the two supported categories.
  (db) => {
    db.exec(`UPDATE works SET provider_id = CASE
      WHEN provider_id = 'official' THEN 'official'
      WHEN COALESCE(provider_id, '') <> '' OR provider_other <> '' THEN 'unofficial'
      ELSE NULL END, provider_other = ''`);
  },
  // Entertainment pool decoupled from the formal switch (2026-10-01): the Show1
  // entertainment face used to reuse show_arena for live works. Existing eligible
  // works keep their place in the pool; everything else opts in manually.
  (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(works)').all().map((column) => column.name));
    if (!columns.has('show_entertainment')) db.exec('ALTER TABLE works ADD COLUMN show_entertainment INTEGER NOT NULL DEFAULT 0');
    const overrideColumns = new Set(db.prepare('PRAGMA table_info(work_overrides)').all().map((column) => column.name));
    if (!overrideColumns.has('show_entertainment')) db.exec('ALTER TABLE work_overrides ADD COLUMN show_entertainment INTEGER NOT NULL DEFAULT 0');
    db.exec(`UPDATE works SET show_entertainment = 1
      WHERE status = 'verified' AND show_arena = 1
      AND json_extract(moderation, '$.status') IN ('legacy', 'approved')
      AND curated_as IS NULL AND deleted_at IS NULL`);
  },
];

// Exported so tests can build databases at an intermediate schema version.
export { MIGRATIONS };

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let step = version; step < MIGRATIONS.length; step++) {
    transaction(db, () => {
      if (typeof MIGRATIONS[step] === 'function') MIGRATIONS[step](db);
      else db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
  return db;
}

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
