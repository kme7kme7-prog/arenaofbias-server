import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { runMigration } from '../scripts/migrate-show1.mjs';

test('Show1 import dry-run is read-only; apply publishes verified works and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'show1-import-'));
  try {
    const sourceDb = join(root, 'source.db');
    const targetDb = join(root, 'target', 'platform.db');
    const sourceWorks = join(root, 'source-works');
    const datapack = join(root, 'pack');
    const models = join(root, 'models.json');
    const prompts = join(root, 'prompts.json');
    const outDir = join(root, 'artifacts');
    mkdirSync(sourceWorks);
    mkdirSync(datapack);
    writeFileSync(join(datapack, 'data.json'), JSON.stringify({ tasks: [{ id: 'chinese-architecture', prompt: 'Build a hall.' }] }));
    writeFileSync(models, JSON.stringify({ models: [{ id: 'model-a', name: 'Model A', vendor: 'Vendor A' }] }));
    writeFileSync(prompts, JSON.stringify([{ id: '004', prompt_head: 'Build a hall.', weights: '[0.3,0.7,0,0,0,0]' }]));
    const source = new DatabaseSync(sourceDb);
    source.exec(`CREATE TABLE users (id TEXT, username TEXT, password_hash TEXT, created_at INTEGER, role TEXT);
      CREATE TABLE prompts (id TEXT, name TEXT, prompt TEXT, weights TEXT);
      CREATE TABLE works (id TEXT, prompt_id TEXT, model_id TEXT, model_name TEXT, title TEXT, is_demo INTEGER, content TEXT, published INTEGER, created_at INTEGER);
      CREATE TABLE reactions (id TEXT, prompt_id TEXT, mid TEXT, kind TEXT, user_id TEXT, created_at INTEGER);
      CREATE TABLE votes (id TEXT, prompt_id TEXT, winner_rid TEXT, winner_mid TEXT, loser_rid TEXT, loser_mid TEXT,
        pair_key TEXT, mode TEXT, user_id TEXT, created_at INTEGER, outcome TEXT);
      CREATE TABLE comments (id TEXT, round_id TEXT, side TEXT, body TEXT, created_at INTEGER, user_id TEXT);
      CREATE TABLE sessions (id TEXT);
      CREATE TABLE page_views (id TEXT); CREATE TABLE auth_limits (id TEXT); CREATE TABLE email_codes (id TEXT);
      CREATE TABLE guess_results (id TEXT);`);
    source.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('old-user', ' Ａlice ', `scrypt:abcd:${'a'.repeat(128)}`, 10, null);
    source.prepare('INSERT INTO prompts VALUES (?, ?, ?, ?)').run('004', 'Hall', 'Build a hall.', '[0.3,0.7,0,0,0,0]');
    const addWork = source.prepare('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    addWork.run('old-work', '004', 'model-a', 'Model A', 'A story', 0,
      JSON.stringify({ kind: 'text', story: { heading: 'Hello', paragraphs: ['World'], ending: 'End' }, framing: { zoom: 1 } }), 1, 20);
    addWork.run('old-mimo', '004', 'mimo-x-flash', 'MiMo X Flash', 'Mimo piece', 0,
      JSON.stringify({ kind: 'text', story: { heading: 'M', paragraphs: ['Piece'], ending: '' } }), 1, 21);
    source.prepare('INSERT INTO reactions VALUES (?, ?, ?, ?, ?, ?)').run('old-reaction', '004', 'model-a', 'up', 'old-user', 30);
    const addVote = source.prepare('INSERT INTO votes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // win: the lexicographically smaller rid sits on side a, so choice follows the winner's side.
    addVote.run('vote-win', '004', '004-model-a', 'model-a', '004-model-b', 'model-b', '004-model-a+004-model-b', 'blind', 'old-user', 25, 'win');
    // draw: outcome decides the tie, the winner/loser columns carry no win semantics.
    addVote.run('vote-draw', '004', '004-model-c', 'model-c', '004-model-a', 'model-a', '004-model-a+004-model-c', 'blind', 'old-user', 30, 'draw');
    // duplicate (user_id, pair_key): the later occurrence loses to the earlier one.
    addVote.run('vote-dup', '004', '004-model-a', 'model-a', '004-model-b', 'model-b', '004-model-a+004-model-b', 'blind', 'old-user', 32, 'win');
    // NULL user votes are outside UNIQUE (user_id, pair_key) and must not deduplicate.
    addVote.run('vote-anon', '004', '004-model-a', 'model-a', '004-model-b', 'model-b', '004-model-a+004-model-b', 'blind', null, 33, 'win');
    // mimo-x-flash keeps its votes; identity stays legacy:<mid>.
    addVote.run('vote-mimo', '004', '004-mimo', 'mimo-x-flash', '004-model-a', 'model-a', '004-mimo+004-model-a', 'blind', 'old-user', 34, 'win');
    const addComment = source.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?)');
    // follows vote-win (25): side a is the winner's side → resolves to old-work via model-a.
    addComment.run('comment-ok', '004', 'a', '好看', 26, 'old-user');
    // follows vote-draw (30): a draw has no backed side → skipped.
    addComment.run('comment-draw', '004', 'a', '平局吐槽', 31, 'old-user');
    // predates any vote by this user on this prompt → skipped.
    addComment.run('comment-early', '004', 'a', '太早了', 10, 'old-user');
    // no user → skipped per migration rule.
    addComment.run('comment-anon', '004', 'a', '匿名', 26, null);
    // user that never migrates → skipped.
    addComment.run('comment-ghost', '004', 'a', '幽灵', 26, 'ghost');
    source.close();
    openDatabase(targetDb).close();
    const options = { sourceDb, targetDb, sourceWorks, datapack, models, prompts, outDir, dryRun: true };
    const dry = runMigration(options);
    assert.equal(dry.status, 'ready');
    assert.equal(dry.tables.works.planned, 2);
    assert.equal(dry.tables.votes.planned, 4);
    assert.equal(dry.tables.votes.conflict, 1);
    assert.equal(dry.tables.matches.planned, 4);
    assert.equal(dry.tables.matches.conflict, 1);
    assert.equal(dry.tables.comments.planned, 1);
    assert.equal(dry.tables.comments.skipped, 4);
    assert.ok(dry.issues.some((issue) => issue.table === 'works' && issue.sourceId === 'old-mimo' && issue.reason.includes('待确认')));
    let target = new DatabaseSync(targetDb, { readOnly: true });
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0);
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
    target.close();
    const applied = runMigration({ ...options, dryRun: false });
    assert.equal(applied.status, 'applied');
    target = new DatabaseSync(targetDb, { readOnly: true });
    const works = target.prepare('SELECT * FROM works ORDER BY id').all();
    assert.equal(works.length, 2);
    for (const row of works) {
      assert.equal(row.status, 'verified');
      assert.deepEqual([row.show_gallery, row.show_arena], [1, 1]);
    }
    const work = works.find((row) => row.model_id === 'model-a');
    assert.deepEqual(JSON.parse(work.trial).calibration.framing, { zoom: 1 });
    const mimo = works.find((row) => row.model_other === 'MiMo X Flash');
    assert.equal(mimo.model_id, null);
    assert.ok(mimo.model_other, 'model_other keeps the source text');
    assert.equal(work.model_other, '');
    assert.equal(target.prepare('SELECT name_key FROM users').get().name_key, 'alice');
    assert.equal(target.prepare('SELECT hash_params FROM users').get().hash_params, '{"N":32768,"r":8,"p":1,"keylen":64}');
    assert.equal(target.prepare('SELECT emoji FROM reactions').get().emoji, '👍');
    assert.ok(existsSync(join(root, 'target', 'works', work.id, 'index.html')));
    assert.match(readFileSync(join(outDir, 'report.md'), 'utf8'), /人工决策清单/);

    const matchRows = target.prepare('SELECT * FROM matches ORDER BY created_at').all();
    const voteRows = target.prepare('SELECT * FROM votes ORDER BY created_at').all();
    assert.equal(matchRows.length, 4);
    assert.equal(voteRows.length, 4);
    const userId = target.prepare('SELECT id FROM users').get().id;
    const winVote = voteRows.find((row) => row.pair_key === '004-model-a+004-model-b' && row.user_id === userId);
    assert.equal(winVote.choice, 'a');
    assert.equal(winVote.a_work, 'legacy:model-a');
    assert.equal(winVote.b_work, 'legacy:model-b');
    assert.equal(winVote.a_identity, 'model-a');
    assert.equal(winVote.b_identity, 'model-b');
    assert.equal(winVote.source, 'legacy');
    const winMatch = matchRows.find((row) => row.id === winVote.match_id);
    assert.equal(winMatch.choice, 'a');
    assert.equal(winMatch.created_at, 25);
    assert.equal(winMatch.decided_at, 25);
    assert.equal(winMatch.expires_at, 25);
    assert.equal(winMatch.user_id, userId);
    assert.match(winMatch.a_token, /^w[0-9a-f]{32}$/);
    assert.match(winMatch.b_token, /^m[0-9a-f]{32}$/);
    const drawVote = voteRows.find((row) => row.pair_key === '004-model-a+004-model-c');
    assert.equal(drawVote.choice, 'tie');
    assert.equal(drawVote.a_work, 'legacy:model-a');
    assert.equal(drawVote.b_work, 'legacy:model-c');
    const anonVote = voteRows.find((row) => row.user_id === null);
    assert.equal(anonVote.pair_key, '004-model-a+004-model-b');
    const mimoVote = voteRows.find((row) => row.a_identity === 'mimo-x-flash');
    assert.equal(mimoVote.a_work, 'legacy:mimo-x-flash');
    assert.equal(mimoVote.choice, 'a');
    const comment = target.prepare('SELECT * FROM comments').get();
    assert.equal(comment.task_id, 'chinese-architecture');
    assert.equal(comment.work_id, work.id);
    assert.equal(comment.user_id, userId);
    assert.equal(comment.body, '好看');
    assert.equal(comment.created_at, 26);
    target.close();

    const again = runMigration({ ...options, dryRun: false });
    assert.equal(again.tables.works.existing, 2);
    assert.equal(again.tables.users.existing, 1);
    assert.equal(again.tables.reactions.existing, 1);
    assert.equal(again.tables.votes.existing, 4);
    assert.equal(again.tables.matches.existing, 4);
    assert.equal(again.tables.comments.existing, 1);
    assert.equal(again.tables.votes.planned, 0);
    assert.equal(again.tables.votes.conflict, 1);
    assert.equal(again.tables.comments.planned, 0);
    target = new DatabaseSync(targetDb, { readOnly: true });
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 4);
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 4);
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
    target.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
