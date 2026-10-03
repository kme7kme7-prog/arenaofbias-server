import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, openDatabase, transaction } from '../server/db.mjs';
import { createQuestions } from '../server/questions.mjs';

const owner = { id: 'owner', name: 'Owner', role: 'user' };
const admin = { id: 'admin', name: 'Admin', role: 'admin' };
const body = { title: 'Question', summary: 'Summary', prompt: 'Exact\nprompt', category: '静态网页', domains: ['数学'], templates: ['static'] };
function users(db) {
  const insert = db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const user of [owner, admin]) insert.run(user.id, user.name, user.id, user.role, 'salt', 'hash', 1);
}
function work(db, taskId) {
  db.prepare(`INSERT INTO works (id, task_id, owner_id, title, model_other, content_key, source_name, root,
    entry, file_count, bytes, digest, checks, created_at, updated_at)
    VALUES ('work', ?, 'owner', 'Sample', 'Model', 'work-key', 'sample.html', '', 'index.html', 1, 1, 'digest', '[]', 1, 1)`).run(taskId);
}
// SQL-backed injection isolates the question transaction/lifecycle from image parsing.
function referencesFixture(db) {
  const dto = row => ({ id: row.id, name: row.name, src: `/api/references/${row.id}`, caption: row.caption, width: row.width, height: row.height });
  const service = {
    calls: [], removed: [],
    prepare(user, input, options) {
      this.calls.push({ user, input, options });
      return input.map(item => {
        const row = db.prepare('SELECT * FROM reference_uploads WHERE id = ?').get(item.id);
        return dto({ ...row, name: item.name ?? row.name, caption: item.caption ?? row.caption });
      });
    },
    save(taskId, refs) {
      db.prepare('UPDATE reference_uploads SET task_id = NULL WHERE task_id = ?').run(taskId);
      refs.forEach((ref, position) => db.prepare('UPDATE reference_uploads SET task_id = ?, name = ?, caption = ?, position = ? WHERE id = ?')
        .run(taskId, ref.name, ref.caption, position, ref.id));
    },
    forQuestion(taskId) { return db.prepare('SELECT * FROM reference_uploads WHERE task_id = ? ORDER BY position, id').all(taskId).map(dto); },
    removeQuestion(taskId) {
      this.removed.push(taskId);
      db.prepare('DELETE FROM reference_uploads WHERE task_id = ?').run(taskId);
    },
  };
  for (const id of ['r-a', 'r-b', 'r-admin']) db.prepare(`INSERT INTO reference_uploads
    (id, owner_id, original_name, name, ext, width, height, bytes, sha256, created_at)
    VALUES (?, ?, ?, ?, 'png', 1, 1, 20, 'digest', 1)`).run(id, id === 'r-admin' ? admin.id : owner.id, `${id}.png`, `${id}.png`);
  return service;
}

test('v38 to v39 preserves earlier columns and records, and reference migration is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'question-reference-migration-'));
  const file = join(root, 'platform.db');
  let db = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, 38)) typeof migration === 'function' ? migration(db) : db.exec(migration);
    db.exec('PRAGMA user_version = 38'); users(db);
    db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, author_role)
      VALUES ('old', 'owner', 'Title', 'Summary', 'Exact\nprompt', '[]', '["static"]', 1, 'user')`).run();
    db.exec(`INSERT INTO votes (id, match_id, task_id, a_work, b_work, pair_key, choice, created_at, user_id, a_identity)
      VALUES ('v', 'v', 'old', 'a', 'b', 'pair', 'a', 1, 'owner', '{"modelId":"historical"}');
      INSERT INTO audit (at, actor_id, actor_name, action, task_id, detail) VALUES (1, 'owner', 'Owner', 'old-action', 'old', 'Exact history');
      INSERT INTO curated_content_keys VALUES ('old', 'a', 'caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');`);
    const tables = ['questions', 'users', 'votes', 'audit', 'curated_content_keys'];
    const before = tables.map(table => ({ table, columns: db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name), rows: db.prepare(`SELECT * FROM ${table}`).all() }));
    db.close(); db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 39);
    for (const { table, columns, rows } of before) assert.deepEqual(db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all(), rows);
    assert.equal(db.prepare('SELECT reference_credit FROM questions').get().reference_credit, '');
    const service = referencesFixture(db), refsBefore = db.prepare('SELECT * FROM reference_uploads').all();
    const questionsBefore = db.prepare('SELECT * FROM questions').all();
    MIGRATIONS[38](db);
    assert.deepEqual(db.prepare('SELECT * FROM reference_uploads').all(), refsBefore);
    assert.deepEqual(db.prepare('SELECT * FROM questions').all(), questionsBefore);
    assert.equal(service.forQuestion('old').length, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA index_list(reference_uploads)').all().filter(row => row.origin === 'c').map(row => row.name).sort(),
      ['reference_uploads_owner_created', 'reference_uploads_task_position']);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('optional reference fields have consistent DTO defaults and validate credit before creating rows', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); const questions = createQuestions(db);
    for (const fields of [{ references: null }, { references: {} }, { referenceCredit: null }, { referenceCredit: 2 }, { referenceCredit: 'x'.repeat(81) }, { referenceCredit: '🎨'.repeat(81) }])
      assert.throws(() => questions.create(owner, { ...body, ...fields }), error => error.status === 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 0);
    const created = questions.create(owner, body);
    for (const dto of [created, questions.get(created.id, owner), questions.byOwner(owner.id, owner)[0], questions.adminAll(admin)[0]]) {
      assert.deepEqual(dto.references, []); assert.equal(dto.referenceCredit, '');
    }
    questions.review(admin, created.id, { status: 'approved' });
    assert.deepEqual(questions.all()[0].references, []);
    assert.equal(questions.edit(admin, created.id, { referenceCredit: '  Artist  ' }).referenceCredit, 'Artist');
    assert.throws(() => questions.edit(admin, created.id, { referenceCredit: 'x'.repeat(81) }), error => error.status === 400);
    assert.equal(questions.edit(admin, created.id, { referenceCredit: '🎨'.repeat(80) }).referenceCredit, '🎨'.repeat(80));
    assert.throws(() => questions.edit(admin, created.id, { referenceCredit: '🎨'.repeat(81) }), error => error.status === 400);
  } finally { db.close(); }
});

test('question reference edits persist order, audit changes, retain rejected refs and lock public answers', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); const references = referencesFixture(db), questions = createQuestions(db, { references });
    const created = transaction(db, () => questions.create(owner, { ...body, references: [{ id: 'r-a' }, { id: 'r-b', caption: 'Second' }], referenceCredit: ' Artist ' }));
    assert.deepEqual(created.references.map(ref => ref.id), ['r-a', 'r-b']); assert.equal(created.referenceCredit, 'Artist');
    assert.equal(references.calls[0].user, owner); assert.deepEqual(references.calls[0].options, { taskId: null });
    let edited = questions.edit(admin, created.id, { references: [{ id: 'r-b', name: 'Second.png' }, { id: 'r-a' }, { id: 'r-admin' }] });
    assert.deepEqual(edited.references.map(ref => ref.id), ['r-b', 'r-a', 'r-admin']);
    assert.deepEqual(references.calls.at(-1).options, { taskId: created.id }); assert.equal(references.calls.at(-1).user, admin);
    const detail = JSON.parse(db.prepare("SELECT detail FROM audit WHERE action = 'question-edit' ORDER BY id DESC").get().detail);
    assert.deepEqual(detail.references.from, created.references); assert.deepEqual(detail.references.to, edited.references);
    questions.review(admin, created.id, { status: 'rejected', reason: 'Needs revision' });
    assert.deepEqual(questions.get(created.id, owner).references, edited.references); assert.deepEqual(references.removed, []);
    work(db, created.id);
    questions.edit(admin, created.id, { referenceCredit: 'New artist' });
    questions.review(admin, created.id, { status: 'approved' });
    edited = questions.get(created.id, owner);
    questions.edit(admin, created.id, { references: edited.references, referenceCredit: edited.referenceCredit });
    for (const fields of [{ references: [] }, { references: [...edited.references].reverse() },
      { references: edited.references.map(ref => ({ ...ref, name: 'Changed.png' })) },
      { references: edited.references.map(ref => ({ ...ref, caption: 'Changed' })) }, { referenceCredit: 'Changed' }])
      assert.throws(() => questions.edit(admin, created.id, fields), error => error.status === 409 && /参考图/.test(error.message));
    assert.deepEqual(questions.get(created.id, owner).references, edited.references);
    questions.remove(admin, created.id);
    assert.deepEqual(references.removed, [created.id]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reference_uploads WHERE task_id = ?').get(created.id).n, 0);
  } finally { db.close(); }
});

test('failed question writes roll back references and failed deletion leaves their cleanup untouched', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); const references = referencesFixture(db), questions = createQuestions(db, { references });
    db.exec("CREATE TRIGGER fail_create BEFORE INSERT ON audit WHEN NEW.action = 'question-create' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => transaction(db, () => questions.create(owner, { ...body, references: [{ id: 'r-a' }] })), /audit failed/);
    assert.equal(db.prepare('SELECT task_id FROM reference_uploads WHERE id = ?').get('r-a').task_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 0);
    db.exec('DROP TRIGGER fail_create');
    const created = transaction(db, () => questions.create(owner, { ...body, references: [{ id: 'r-a' }] }));
    db.exec("CREATE TRIGGER fail_edit BEFORE INSERT ON audit WHEN NEW.action = 'question-edit' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => questions.edit(admin, created.id, { references: [{ id: 'r-b' }], referenceCredit: 'Changed' }), /audit failed/);
    assert.deepEqual(questions.get(created.id, owner).references, created.references);
    assert.equal(questions.get(created.id, owner).referenceCredit, '');
    assert.equal(db.prepare('SELECT task_id FROM reference_uploads WHERE id = ?').get('r-b').task_id, null);
    db.exec("CREATE TRIGGER fail_delete BEFORE INSERT ON audit WHEN NEW.action = 'question-delete' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => questions.remove(admin, created.id), /audit failed/);
    assert.deepEqual(references.removed, []); assert.deepEqual(questions.get(created.id, owner).references, created.references);
  } finally { db.close(); }
});

test('packaged questions expose empty reference metadata and keep fresh prompts unless explicitly overridden', () => {
  const db = openDatabase(':memory:');
  try {
    users(db); const questions = createQuestions(db);
    let task = { ...body, id: 'pack', tags: [], acceptsUploads: true, references: [{ src: '/private-copy.png' }], referenceCredit: 'Pack author' };
    questions.bindCatalog({ snapshot: () => ({ task: id => id === 'pack' ? task : null, tasks: () => [task], works: () => [] }) });
    let dto = questions.get('pack');
    assert.deepEqual(dto.references, []); assert.equal(dto.referenceCredit, '');
    assert.throws(() => questions.edit(admin, 'pack', { references: [{ id: 'r-a' }] }), error => error.status === 400 && /数据包/.test(error.message));
    assert.throws(() => questions.edit(admin, 'pack', { referenceCredit: 'Artist' }), error => error.status === 400 && /数据包/.test(error.message));
    questions.edit(admin, 'pack', { title: 'Edited title', references: [], referenceCredit: '' });
    assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT display_json FROM question_overrides').get().display_json), 'prompt'), false);
    task = { ...task, prompt: 'Fresh catalog prompt' };
    assert.equal(questions.get('pack').prompt, 'Fresh catalog prompt');
    questions.edit(admin, 'pack', { prompt: 'Explicit admin prompt' });
    task = { ...task, prompt: 'Another catalog prompt' };
    questions.edit(admin, 'pack', { summary: 'Updated summary' });
    dto = questions.get('pack'); assert.equal(dto.prompt, 'Explicit admin prompt');
    assert.deepEqual(dto.references, []); assert.equal(dto.referenceCredit, '');
  } finally { db.close(); }
});
