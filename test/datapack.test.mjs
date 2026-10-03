import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function pack(root, sha, firstModel) {
  mkdirSync(join(root, 'results', 'one', 'a1'), { recursive: true });
  mkdirSync(join(root, 'results', 'one', 'b1'), { recursive: true });
  for (const id of ['a1', 'b1']) {
    writeFileSync(join(root, 'results', 'one', id, 'index.html'), `<title>${sha[0]}-${id}</title><script src="app.js"></script>`);
    writeFileSync(join(root, 'results', 'one', id, 'app.js'), `window.pack = '${sha[0]}'`);
  }
  writeFileSync(join(root, '.datapack-source.json'), JSON.stringify({ source: 'github', repo: 'owner/data', commit: sha }));
  writeFileSync(join(root, 'data.json'), JSON.stringify({
    schemaVersion: 1, sourceCommit: 'c'.repeat(40), title: `Pack ${sha[0]}`,
    models: [{ id: firstModel, name: `Model ${sha[0]}`, vendor: 'Vendor' }, { id: 'm-b', name: 'B', vendor: 'Vendor' }],
    tasks: [{ id: 'one', title: 'One', results: [
      { id: 'a1', model: firstModel, title: `A ${sha[0]}`, scene: 'results/one/a1/', generationMode: 'single-turn', humanIntervention: 'none' },
      { id: 'b1', model: 'm-b', title: `B ${sha[0]}`, scene: 'results/one/b1/', generationMode: 'single-turn', humanIntervention: 'none' },
    ] }],
  }));
}

test('a match keeps its original package and vote identity across a same-mtime switch and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'datapack-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  const current = join(root, 'current');
  const dataDir = join(root, 'state');
  pack(a, SHA_A, 'm-a');
  pack(b, SHA_B, 'm-new');
  const oldDate = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(a, 'data.json'), oldDate, oldDate);
  utimesSync(join(b, 'data.json'), oldDate, oldDate);
  symlinkSync(a, current, 'junction');
  const config = { dist: current, dataDir, contentTemplate: 'http://{token}.localhost', siteOrigins: ['http://localhost'], admins: [], cdn: [], capture: false, secureCookies: false, trustProxy: false };
  let platform;
  let content;
  const contentGet = (url) => new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request({ host: '127.0.0.1', port: content.address().port, path: parsed.pathname, headers: { Host: parsed.host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    platform = createPlatform({ config, limits });
    content = createServer(platform.handleContent).listen(0, '127.0.0.1');
    await new Promise((resolve) => content.once('listening', resolve));
    const user = await verifiedUser(platform.auth, 'voter', 'correct horse');
    assert.equal((await platform.arena.leaderboard()).unranked.some((row) => row.key === 'm-a|'), true);
    const match = await platform.arena.createMatch(user, 'one');
    const original = await contentGet(match.a);
    assert.equal(original.status, 200);
    assert.match(original.body, /a-(a1|b1)/);
    assert.match((await contentGet(new URL('/app.js', match.a))).body, /'a'/);
    const row = platform.db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
    assert.equal(row.datapack_root, a);
    assert.equal(row.datapack_version, `${a}|${SHA_A}`);

    unlinkSync(current);
    symlinkSync(b, current, 'junction');
    assert.equal((await platform.arena.leaderboard()).unranked.some((entry) => entry.key === 'm-new|'), true);
    assert.equal((await platform.arena.leaderboard()).unranked.some((entry) => entry.key === 'm-a|'), false);
    assert.equal((await contentGet(match.a)).body, original.body);
    assert.match((await contentGet(new URL('/app.js', match.a))).body, /'a'/);
    await new Promise((resolve) => content.close(resolve));
    await platform.close();

    platform = createPlatform({ config, limits });
    content = createServer(platform.handleContent).listen(0, '127.0.0.1');
    await new Promise((resolve) => content.once('listening', resolve));
    assert.equal((await contentGet(match.a)).body, original.body);
    assert.match((await contentGet(new URL('/app.js', match.a))).body, /'a'/);
    assert.equal(platform.arena.vote(user, match.id, 'a').counted, true);
    const vote = platform.db.prepare('SELECT * FROM votes WHERE match_id = ?').get(match.id);
    assert.equal(vote.source, 'arena');
    const identities = [JSON.parse(vote.a_identity), JSON.parse(vote.b_identity)];
    assert.equal(identities.find((side) => side.id === 'a1').configKey, 'm-a|');
    assert.ok(identities.every((side) => /^[0-9a-f]{64}$/.test(side.digest)));
    const board = (await platform.arena.leaderboard({ task: 'one' }));
    assert.ok(board.rows.some((entry) => entry.key === 'm-a|' && entry.modelName === 'Model a'));
    assert.ok(!board.rows.some((entry) => entry.key === 'm-new|'));

    const site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => site.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${site.address().port}`;
      const boot = await (await fetch(`${base}/api/bootstrap`)).json();
      assert.equal(boot.datapack, SHA_B);
      assert.equal(boot.catalogDigest, createHash('sha256').update(readFileSync(join(b, 'data.json'))).digest('hex'));
      assert.equal(boot.apiVersion, 1);
      assert.ok(boot.serverVersion);
      const preflight = await fetch(`${base}/api/arena/matches`, { method: 'OPTIONS', headers: {
        Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-datapack-version',
      } });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-headers'), /X-Datapack-Version/);
      const stale = await fetch(`${base}/api/arena/matches`, { method: 'POST', headers: {
        Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Datapack-Version': SHA_A,
      }, body: '{"task":"one"}' });
      assert.equal(stale.status, 200);
      assert.equal(stale.headers.get('x-datapack-stale'), '1');
      assert.equal((await stale.json()).task, 'one');
    } finally { await new Promise((resolve) => site.close(resolve)); }

    const admin = platform.auth.promote('voter', 'admin');
    assert.throws(() => platform.arena.correctVote(admin, vote.id, 'a', { modelId: 'fixed' }, ''), /原因必填/);
    const originalIdentity = platform.db.prepare('SELECT a_identity FROM votes WHERE id = ?').get(vote.id).a_identity;
    const corrected = platform.arena.correctVote(admin, vote.id, 'a', { modelId: 'fixed', modelName: 'Corrected' }, 'source record corrected');
    assert.equal(corrected.modelKey, 'fixed');
    const correctedRow = platform.db.prepare('SELECT source, a_identity, a_correction FROM votes WHERE id = ?').get(vote.id);
    assert.equal(correctedRow.source, 'arena');
    assert.equal(correctedRow.a_identity, originalIdentity);
    assert.equal(JSON.parse(correctedRow.a_correction).modelKey, 'fixed');
    const audit = platform.db.prepare("SELECT detail FROM audit WHERE action = 'vote-identity-correction'").get();
    assert.equal(JSON.parse(audit.detail).reason, 'source record corrected');
    assert.ok((await platform.arena.leaderboard({ task: 'one' })).rows.some((entry) => entry.key === 'fixed|'));
  } finally {
    if (content?.listening) await new Promise((resolve) => content.close(resolve));
    if (platform) await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old database migrates votes as legacy without inventing identity snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-db-'));
  const file = join(root, 'platform.db');
  const old = new DatabaseSync(file);
  try {
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      nickname TEXT NOT NULL DEFAULT '');
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE matches (id TEXT PRIMARY KEY, user_id TEXT, task_id TEXT NOT NULL, a_work TEXT NOT NULL, b_work TEXT NOT NULL,
      a_token TEXT UNIQUE, b_token TEXT UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, choice TEXT, decided_at INTEGER);
      CREATE TABLE votes (id TEXT PRIMARY KEY, match_id TEXT UNIQUE, user_id TEXT, task_id TEXT NOT NULL, a_work TEXT NOT NULL,
      b_work TEXT NOT NULL, pair_key TEXT NOT NULL, choice TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE works (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_id TEXT NOT NULL, deleted_at INTEGER, reviewed_at INTEGER, updated_at INTEGER);
      INSERT INTO matches VALUES ('old', NULL, 'one', 'a1', 'b1', 'ma', 'mb', 1, 9999999999999, 'a', 2);
      INSERT INTO votes VALUES ('old-vote', 'old', NULL, 'one', 'a1', 'b1', 'one:a1+b1', 'a', 2);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER, actor_id TEXT, actor_name TEXT, action TEXT, task_id TEXT, work_id TEXT, detail TEXT);
      PRAGMA user_version = 3;`);
    old.exec(MIGRATIONS[1]);
  } finally { old.close(); }
  const db = openDatabase(file);
  try {
    const match = db.prepare("SELECT * FROM matches WHERE id = 'old'").get();
    const vote = db.prepare("SELECT * FROM votes WHERE id = 'old-vote'").get();
    assert.equal(match.datapack_root, null);
    assert.equal(match.a_identity, null);
    assert.equal(vote.a_identity, null);
    assert.equal(vote.a_correction, null);
    assert.equal(vote.source, 'legacy', 'pre-v8 votes stay out of Bradley–Terry');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unversioned development data never claims a source pin and detects content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-pack-'));
  try {
    const file = join(root, 'data.json');
    writeFileSync(file, JSON.stringify({ title: 'One', sourceCommit: SHA_A, models: [], tasks: [{ id: 'one', results: [],
      promptVariants: [{ id: 'long', label: 'Long', prompt: 'Full prompt', promptUrl: 'https://example.com/private-source', internal: 'private' }],
    }] }));
    const catalog = createCatalog(root);
    assert.deepEqual(catalog.task('one').promptVariants, [{ id: 'long', label: 'Long', prompt: 'Full prompt' }]);
    const first = catalog.version;
    assert.equal(catalog.datapack, null);
    assert.equal(catalog.title, 'One');
    assert.equal(catalog.catalogDigest, createHash('sha256').update(readFileSync(file)).digest('hex'));
    const oldDate = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, oldDate, oldDate);
    writeFileSync(file, JSON.stringify({ title: 'Two', sourceCommit: SHA_A, models: [], tasks: [] }));
    utimesSync(file, oldDate, oldDate);
    assert.notEqual(catalog.version, first);
    assert.equal(catalog.title, 'Two');
    assert.equal(catalog.datapack, null);
    writeFileSync(join(root, '.datapack-source.json'), JSON.stringify({ source: 'local', path: root }));
    assert.equal(catalog.datapack, null);
    assert.match(catalog.version, /dev:/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, sourceCommit: SHA_A, models: [], tasks: [] }));
    assert.throws(() => catalog.refresh(), /schemaVersion/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
