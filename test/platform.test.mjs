// Platform rules: ranking, upload inspection and the upload → review → blind vote lifecycle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { crc32, deflateRawSync } from 'node:zlib';
import { createPlatform } from '../server/app.mjs';
import { createAuth } from '../server/auth.mjs';
import { createArena } from '../server/arena.mjs';
import { limits as defaultLimits } from '../server/config.mjs';
import { inspectUpload } from '../server/inspect.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { createQuestions } from '../server/questions.mjs';
import { fitBradleyTerry, rankEntries } from '../server/ranking.mjs';

test('reserved admin names return the ordinary duplicate error and CLI creates an admin from stdin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reserved-admin-'));
  const db = openDatabase(join(root, 'platform.db'));
  try {
    const auth = createAuth(db, { admins: ['reservedroot'], secureCookies: false, sessionTtl: 60_000 });
    const duplicate = () => auth.register('taken', 'correct horse');
    await duplicate();
    let expected;
    try { await duplicate(); } catch (error) { expected = error; }
    await assert.rejects(() => auth.register('ReservedRoot', 'correct horse'),
      (error) => error.status === 409 && error.message === expected.message);
    const cli = spawnSync(process.execPath, ['server/cli.mjs', '--create', 'ReservedRoot'], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: root }, input: 'correct horse\n', encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.doesNotMatch(cli.stdout, /correct horse/);
    assert.equal((await auth.login('reservedroot', 'correct horse')).role, 'admin');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.symlink ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.symlink ? (0o120777 << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const PAGE = '<!doctype html><html><head><title>t</title></head><body><canvas></canvas><script src="app.js"></script></body></html>';
const inspect = (buffer, name = 'work.zip') => inspectUpload(buffer, name, { limits: defaultLimits, cdn: ['unpkg.com'] });

// Small DOM fixtures exercise the served script without adding a browser dependency.
function foldElement(tag, { position = 'static', width = 100, height = 30, text = '', attrs = {}, selectors = [] } = {}, children = []) {
  const attributes = new Map(Object.entries(attrs));
  const el = {
    tagName: tag.toUpperCase(), position, children: [], parentElement: null,
    get textContent() { return text + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { text = value; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    toggleAttribute(name, force) { if (force) attributes.set(name, ''); else attributes.delete(name); },
    getBoundingClientRect() { return { width, height }; },
    getClientRects() { return [{}]; },
    matches(selector) {
      return selector.split(',').some(part => {
        const key = part.trim(), attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(key);
        return key === tag || selectors.includes(key) || (attr && attributes.has(attr[1]) && (attr[2] === undefined || attributes.get(attr[1]) === attr[2]));
      });
    },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    contains(other) { return this === other || this.children.some(child => child.contains(other)); },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  for (const child of children) el.appendChild(child);
  return el;
}

function foldFrame(children) {
  const body = foldElement('body', {}, children);
  const root = foldElement('html', {}, [body]);
  const events = new Map(), timers = [], reports = [];
  const parent = { postMessage(data) { reports.push({ ...data }); } };
  const document = { body, documentElement: root, createElement: tag => foldElement(tag), querySelectorAll: selector => root.querySelectorAll(selector) };
  runInNewContext(readFileSync(new URL('../server/fold.js', import.meta.url), 'utf8'), {
    document, parent, innerWidth: 1280, innerHeight: 660,
    getComputedStyle: el => ({ position: el.position }),
    addEventListener: (type, callback) => events.set(type, callback),
    setTimeout: callback => timers.push(callback),
  });
  return { body, root, parent, reports, load: () => events.get('load')(), scan: () => timers.shift()(), message: event => events.get('message')(event) };
}

test('fold keeps activation buttons, native form inputs and work content', () => {
  const button = text => foldElement('button', { text });
  const fixed = (tag, children, attrs = {}) => foldElement(tag, { position: 'fixed', attrs }, children);
  const input = foldElement('input', { position: 'absolute' });
  const protectedBoxes = [
    input,
    fixed('div', [button('键盘体验 A—Z'), button('复位视角')]),
    fixed('header', [button('关于作品')]),
    fixed('section', [foldElement('strong', { text: '一轴 · 两院 · 十一筑' }), foldElement('p', { text: '对称有序，向山而生', selectors: ['strong + p'] }), button('晨光')]),
    fixed('section', [foldElement('p', { text: '作品介绍' }), button('车身配色')], { 'aria-labelledby': 'title' }),
    fixed('aside', [foldElement('p', { text: '建筑的故事' }), button('走近主殿')], { 'aria-live': 'polite' }),
    fixed('section', [foldElement('p', { text: '建筑详情' }), fixed('div', [button('下一座')])], { 'aria-live': 'polite' }),
    fixed('aside', [foldElement('ul', {}, [foldElement('li', { text: '营造规制正文' })]), button('时辰')]),
    fixed('section', [foldElement('svg', { selectors: ['svg[role="img"]'] }), button('建筑导览')]),
  ];
  const tuning = fixed('div', [button('晨曦'), button('夜景')]);
  const frame = foldFrame([...protectedBoxes, tuning]);
  frame.load(); frame.scan();
  for (const el of protectedBoxes) assert.equal(el.hasAttribute('data-sp-fold-ui'), false);
  assert.equal(tuning.hasAttribute('data-sp-fold-ui'), true, 'pure tuning panels still fold');
  assert.deepEqual(frame.reports.map(report => report.count), [0, 1]);
});

test('fold finds static tuning cards inside a full-page positioned overlay', () => {
  const card = children => foldElement('section', { width: 260, height: 160 }, children);
  const views = card([foldElement('button', { text: '俯瞰' })]);
  const speed = card([foldElement('input')]);
  const overlay = foldElement('div', { position: 'fixed', width: 1280, height: 660 }, [views, speed]);
  const scene = foldElement('canvas');
  const frame = foldFrame([scene, overlay]);
  frame.load(); frame.scan();
  assert.equal(views.hasAttribute('data-sp-fold-ui'), true);
  assert.equal(speed.hasAttribute('data-sp-fold-ui'), true);
  assert.equal(overlay.hasAttribute('data-sp-fold-ui'), false);
  assert.equal(scene.hasAttribute('data-sp-fold-ui'), false);
  assert.deepEqual(frame.reports.map(report => report.count), [0, 2]);
});

test('fold reports cumulative batches and only accepts its parent toolbar messages', () => {
  const input = foldElement('input');
  input.value = '0.75';
  const gui = foldElement('div', { selectors: ['.lil-gui.root'] }, [input]);
  const frame = foldFrame([gui]);
  assert.equal(frame.root.hasAttribute('data-sp-fold'), true);
  frame.load(); frame.scan(); frame.scan();
  assert.deepEqual(frame.reports, [{ source: 'sp-fold', count: 0 }, { source: 'sp-fold', count: 1 }]);
  frame.message({ source: {}, data: { source: 'sp-arena', fold: false } });
  assert.equal(frame.root.hasAttribute('data-sp-fold'), true);
  frame.message({ source: frame.parent, data: { source: 'other', fold: false } });
  assert.equal(frame.root.hasAttribute('data-sp-fold'), true);
  frame.message({ source: frame.parent, data: { source: 'sp-arena', fold: false } });
  assert.equal(frame.root.hasAttribute('data-sp-fold'), false);
  assert.equal(input.value, '0.75');
  frame.body.appendChild(foldElement('div', { position: 'fixed' }, [foldElement('button', { text: '速度' })]));
  frame.scan();
  frame.message({ source: frame.parent, data: { source: 'sp-arena', fold: true } });
  assert.equal(frame.root.hasAttribute('data-sp-fold'), true);
  assert.deepEqual(frame.reports.map(report => report.count), [0, 1, 2]);
});

test('cross-site sessions use the configured cookie policy and require HTTPS', async () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => createAuth(db, { admins: [], secureCookies: false, cookieSameSite: 'None', sessionTtl: 60000 }), /requires COOKIE_SECURE/);
    const auth = createAuth(db, { admins: [], secureCookies: true, cookieSameSite: 'None', sessionTtl: 60000 });
    const user = await auth.register('cookie-user', 'correct horse');
    const headers = new Map();
    const res = { setHeader: (name, value) => headers.set(name, value) };
    auth.startSession(res, user.id);
    const cookie = headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-sp_session=.*; Path=\/; HttpOnly; SameSite=None; Max-Age=60; Secure$/);
    const req = { headers: { cookie: cookie.split(';')[0] } };
    assert.equal(auth.userFrom(req).id, user.id);
    assert.equal(auth.userFrom({ headers: { cookie: `${req.headers.cookie}; ${req.headers.cookie}` } }), null);
    assert.equal(auth.userFrom({ headers: { cookie: `sp_session=${req.headers.cookie.split('=')[1]}` } }), null);
    auth.endSession(req, res);
    assert.match(headers.get('Set-Cookie'), /SameSite=None; Max-Age=0; Secure$/);
    assert.equal(auth.userFrom(req), null);
  } finally { db.close(); }
});

test('local sessions retain sp_session and reject duplicate cookie values', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { admins: [], secureCookies: false, sessionTtl: 60000 });
    const user = await auth.register('local-user', 'correct horse');
    let cookie;
    auth.startSession({ setHeader: (_name, value) => { cookie = value; } }, user.id);
    assert.match(cookie, /^sp_session=.*; Path=\/; HttpOnly;/);
    const pair = cookie.split(';')[0];
    assert.equal(auth.userFrom({ headers: { cookie: pair } }).id, user.id);
    assert.equal(auth.userFrom({ headers: { cookie: `${pair}; ${pair}` } }), null);
  } finally { db.close(); }
});

test('login and registration let the event loop run during scrypt', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { admins: [], secureCookies: false, sessionTtl: 60000 });
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    await auth.register('async-user', 'correct horse');
    assert.equal(ticked, true);
    ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    await auth.login('async-user', 'correct horse');
    assert.equal(ticked, true);
  } finally { db.close(); }
});

test('match sampling chooses a configuration pair before a work pair', async () => {
  const db = openDatabase(':memory:');
  try {
    const work = (id, modelId) => ({ id, taskId: 'one', curated: false, digest: id,
      title: id, modelId, modelName: modelId, vendor: '', effort: '' });
    const pool = [...Array.from({ length: 50 }, (_, i) => work(`a${i}`, 'a')), work('b', 'b'), work('c', 'c')];
    const snapshot = { version: 'test', root: '', task: () => ({}), entryDigest: () => null };
    const arena = createArena({ db, catalog: { snapshot: () => snapshot, task: () => ({}), tasks: () => [] },
      library: { eligible: () => pool, isEligible: () => true, originOf: (key) => `https://${key}.example` },
      limits: defaultLimits, random: () => 0.9 });
    const firstBoard = arena.leaderboard({ task: 'one', snapshot });
    assert.strictEqual(arena.leaderboard({ task: 'one', snapshot }), firstBoard, 'same cache key shares one pending Promise');
    await firstBoard;
    const match = await arena.createMatch(null, 'one', null, snapshot);
    const selected = db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
    assert.deepEqual([selected.a_work, selected.b_work].sort(), ['b', 'c']);
  } finally { db.close(); }
});

test('v6 migrates legacy password hashes on first successful login', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-auth-'));
  const file = join(root, 'platform.db');
  const legacy = new DatabaseSync(file);
  const salt = '0123456789abcdef0123456789abcdef';
  const oldHash = scryptSync('correct horse', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    nickname TEXT NOT NULL DEFAULT '');
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users (id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE works (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_id TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE votes (id TEXT PRIMARY KEY, identity_source TEXT NOT NULL DEFAULT 'legacy');
    CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER, actor_id TEXT, actor_name TEXT, action TEXT, task_id TEXT, work_id TEXT, detail TEXT);
    PRAGMA user_version = 5;`);
  legacy.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-user', 'olduser', 'olduser', 'member', salt, oldHash, Date.now());
  legacy.close();
  const db = openDatabase(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'comments'").get());
    const auth = createAuth(db, { admins: [], secureCookies: false, sessionTtl: 60000 });
    db.prepare('UPDATE users SET hash_params = ? WHERE id = ?').run(JSON.stringify({ N: 32768, r: 8, p: 1, keylen: 64 }), 'legacy-user');
    await assert.rejects(() => auth.login('olduser', 'wrong password'), /用户名或密码不正确/);
    assert.equal(db.prepare('SELECT hash_params FROM users WHERE id = ?').get('legacy-user').hash_params !== null, true);
    assert.equal((await auth.login('olduser', 'correct horse')).id, 'legacy-user');
    const upgraded = db.prepare('SELECT salt, hash, hash_params FROM users WHERE id = ?').get('legacy-user');
    assert.equal(upgraded.hash_params, null);
    assert.notEqual(upgraded.salt, salt);
    assert.equal(upgraded.hash.length, 64);
    assert.equal((await auth.login('olduser', 'correct horse')).id, 'legacy-user');
    const standard = await auth.register('newuser', 'correct horse');
    const before = db.prepare('SELECT salt, hash FROM users WHERE id = ?').get(standard.id);
    await auth.login('newuser', 'correct horse');
    assert.deepEqual(db.prepare('SELECT salt, hash FROM users WHERE id = ?').get(standard.id), before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('malformed legacy hash_params are treated as a wrong password, never a 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-auth-'));
  const file = join(root, 'platform.db');
  const setup = new DatabaseSync(file);
  setup.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    nickname TEXT NOT NULL DEFAULT '');
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users (id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE works (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_id TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE votes (id TEXT PRIMARY KEY, identity_source TEXT NOT NULL DEFAULT 'legacy');
    CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER, actor_id TEXT, actor_name TEXT, action TEXT, task_id TEXT, work_id TEXT, detail TEXT);
    PRAGMA user_version = 5;`);
  setup.close();
  const db = openDatabase(file);
  try {
    const auth = createAuth(db, { admins: [], secureCookies: false, sessionTtl: 60000 });
    await auth.register('brokenjson', 'correct horse');
    db.prepare("UPDATE users SET hash_params = 'not json' WHERE name_key = 'brokenjson'").run();
    await auth.register('badparams', 'correct horse');
    db.prepare("UPDATE users SET hash_params = '{\"N\":\"x\"}' WHERE name_key = 'badparams'").run();
    for (const name of ['brokenjson', 'badparams']) {
      await assert.rejects(() => auth.login(name, 'correct horse'), (error) => error.status === 401 && /用户名或密码不正确/.test(error.message));
    }
    // The row is left untouched so a fixed hash_params can still be migrated later.
    assert.equal(db.prepare("SELECT hash_params FROM users WHERE name_key = 'brokenjson'").get().hash_params, 'not json');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

describe('ranking', () => {
  const work = (key) => ({ key, taskId: 't' });
  const keyOf = (w) => w.key;
  const votes = (list) => list.map(([a, b, choice], i) => ({ a: work(a), b: work(b), choice, userId: `u${i}` }));

  test('a consistently preferred entry ranks first, with the average at 1000', () => {
    const rows = rankEntries(votes([['x', 'y', 'a'], ['x', 'z', 'a'], ['y', 'z', 'a'], ['x', 'y', 'a']]), keyOf, { provisionalGames: 30 });
    assert.deepEqual(rows.map((row) => row.key), ['x', 'y', 'z']);
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.score, 0) / 3 - 1000) <= 1);
    assert.ok(rows.every((row) => row.provisional));
  });

  test('ties count half for each side and the result ignores vote order', () => {
    const list = [['x', 'y', 'a'], ['x', 'y', 'tie'], ['y', 'x', 'b'], ['y', 'z', 'tie']];
    const forward = rankEntries(votes(list), keyOf, { provisionalGames: 30 });
    const backward = rankEntries(votes([...list].reverse()), keyOf, { provisionalGames: 30 });
    assert.deepEqual(forward.map((row) => [row.key, row.score]), backward.map((row) => [row.key, row.score]));
    const x = forward.find((row) => row.key === 'x');
    assert.equal(x.draws, 1);
    assert.equal(x.winRate, 2.5 / 3);
  });

  test('more comparisons narrow the interval; same-entry votes are ignored', () => {
    const few = fitBradleyTerry(2, [{ a: 0, b: 1, y: 1 }]);
    const many = fitBradleyTerry(2, Array.from({ length: 40 }, (_, i) => ({ a: 0, b: 1, y: i % 4 ? 1 : 0 })));
    assert.ok(many[0].interval < few[0].interval);
    assert.deepEqual(rankEntries(votes([['x', 'x', 'a']]), keyOf, { provisionalGames: 30 }), []);
  });
});

describe('upload inspection', () => {
  test('a single HTML file becomes index.html', () => {
    const result = inspect(Buffer.from('<!doctype html><html><body><h1>hi</h1></body></html>'), 'page.html');
    assert.equal(result.entry, 'index.html');
    assert.equal(result.kind, 'html');
  });

  test('a wrapping folder is stripped and dist/ becomes the served root', () => {
    const result = inspect(zip([
      { name: 'project/package.json', data: '{}' },
      { name: 'project/src/main.js', data: '' },
      { name: 'project/dist/index.html', data: '<html><head><script type="module" src="/assets/app.js"></script></head></html>' },
      { name: 'project/dist/assets/app.js', data: 'console.log(1)' },
    ]));
    assert.equal(result.root, 'dist');
    assert.equal(result.entry, 'index.html');
  });

  test('a built project prefers dist over its source index when the format is inferred', () => {
    const result = inspect(zip([
      { name: 'package.json', data: '{}' },
      { name: 'index.html', data: '<html><script src="/src/main.js"></script></html>' },
      { name: 'dist/index.html', data: '<html><h1>Built page</h1></html>' },
    ]));
    assert.equal(result.root, 'dist');
  });

  test('unsafe or incomplete archives are refused with a reason', () => {
    assert.throws(() => inspect(zip([{ name: '../evil.html', data: PAGE }])), /不安全/);
    assert.throws(() => inspect(zip([{ name: 'index.html', data: PAGE }, { name: 'node_modules/x/index.js', data: '' }])), /node_modules/);
    assert.throws(() => inspect(zip([{ name: 'index.html', data: PAGE }, { name: 'app.js', symlink: true, data: '/etc/passwd' }])), /符号链接/);
    assert.throws(() => inspect(zip([{ name: 'package.json', data: '{}' }, { name: 'src/main.js', data: '' }])), /构建/);
    assert.throws(() => inspect(zip([{ name: 'index.html', data: PAGE }])), /app\.js/);
    assert.throws(() => inspect(Buffer.from('plain text'), 'notes.txt'), /ZIP/);
  });

  test('external references are reported, allowlisted CDNs are noted', () => {
    const blocked = inspect(zip([{ name: 'index.html', data: '<html><script src="https://evil.example/x.js"></script></html>' }]));
    assert.equal(blocked.checks.find((check) => check.id === 'external').state, 'warn');
    const cdn = inspect(zip([{ name: 'index.html', data: '<html><script type="importmap">{"imports":{"three":"https://unpkg.com/three"}}</script></html>' }]));
    assert.equal(cdn.checks.find((check) => check.id === 'external').state, 'info');
  });
});

describe('platform lifecycle', () => {
  let root;
  let platform;
  let site;
  let content;
  let base;
  const jars = new Map();

  async function call(who, method, path, body, { raw = false, origin = true } = {}) {
    const headers = {};
    if (jars.get(who)) headers.cookie = jars.get(who);
    if (origin) headers.origin = base;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jars.set(who, cookie.split(';')[0]);
    return { status: response.status, data: await response.json() };
  }

  function fetchContent(url) {
    const { host, pathname } = new URL(url);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: content.address().port, path: pathname, headers: { host } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'same-prompt-'));
    const dist = join(root, 'dist');
    const results = [['a1', 'm-a', 'High'], ['b1', 'm-b', '']];
    for (const [id] of results) {
      mkdirSync(join(dist, 'results', 'one', id), { recursive: true });
      writeFileSync(join(dist, 'results', 'one', id, 'index.html'), `<!doctype html><title>${id}</title><p>${id}</p>`);
    }
    writeFileSync(join(dist, 'data.json'), JSON.stringify({
      title: 'test',
      models: [{ id: 'm-a', name: 'Model A', vendor: 'VA' }, { id: 'm-b', name: 'Model B', vendor: 'VB' }],
      tasks: [
        { id: 'one', title: 'One', category: '建模', tags: ['Three.js'], promptPending: false, results: results.map(([id, model, effort]) => ({ id, model, effort, title: id.toUpperCase(), summary: '', scene: `results/one/${id}/`, captures: {}, gallery: [] })) },
        { id: 'closed', title: 'Closed', promptPending: true, results: [] },
        { id: 'versions', title: 'Versions', promptPending: false, promptVariants: [{ id: 'long', label: '长版', prompt: 'Long' }, { id: 'short', label: '短版', prompt: 'Short' }], results: [] },
      ],
    }));
    const config = { dist, dataDir: join(root, 'data'), contentTemplate: '', siteOrigins: ['http://127.0.0.1'], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: false };
    platform = createPlatform({ config, limits: { ...defaultLimits, pendingPerUser: 2 } });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    content = createServer(platform.handleContent).listen(0, '127.0.0.1');
    await Promise.all([site, content].map((server) => new Promise((resolve) => server.once('listening', resolve))));
    base = `http://127.0.0.1:${site.address().port}`;
    config.contentTemplate = `http://{token}.localhost:${content.address().port}`;
    for (const name of ['alice', 'bob']) assert.equal((await call(name, 'POST', '/api/auth/register', { name, password: 'correct horse' })).status, 200);
    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
  });

  after(async () => {
    site.close();
    content.close();
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted frontends can preflight, sign in and read sessions while foreign writes are refused', async () => {
    const origin = 'http://127.0.0.1';
    const preflight = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS', headers: { origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: 'correct horse' }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('access-control-allow-origin'), origin);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { origin, cookie } });
    assert.equal((await boot.json()).user.name, 'alice');
    assert.equal(boot.headers.get('vary'), 'Origin');
    const unauthorized = await fetch(`${base}/api/me`, { headers: { origin } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), origin);
    const data = await fetch(`${base}/data.json`, { headers: { origin } });
    assert.equal(data.status, 404);
    assert.equal(data.headers.get('access-control-allow-origin'), origin);
    for (const foreign of ['https://evil.example', base.replace('http:', 'https:')]) {
      const rejected = await fetch(`${base}/api/me`, { method: 'PATCH', headers: { origin: foreign, cookie, 'Content-Type': 'application/json' }, body: '{"nickname":"foreign"}' });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' } })).status, 403);
  });

  test('trusted origins can read the stale datapack response header', async () => {
    const trusted = await fetch(`${base}/api/bootstrap`, { headers: { origin: 'http://127.0.0.1' } });
    assert.equal(trusted.headers.get('access-control-expose-headers'), 'X-Datapack-Stale');
    const foreign = await fetch(`${base}/api/bootstrap`, { headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.headers.get('access-control-expose-headers'), null);
  });

  let upload;
  test('uploads are staged, trial-loaded with the probe, then submitted as unverified', async () => {
    const html = '<!doctype html><html><head><title>mine</title></head><body><h1>mine</h1></body></html>';
    assert.equal((await call('alice', 'POST', '/api/drafts?task=one&name=mine.html', html, { raw: true, origin: false })).status, 403);
    assert.equal((await call('alice', 'POST', '/api/drafts?task=closed&name=mine.html', html, { raw: true })).status, 409);
    const staged = await call('alice', 'POST', '/api/drafts?task=one&name=mine.html', html, { raw: true });
    assert.equal(staged.status, 200);
    const preview = await fetchContent(staged.data.draft.preview);
    assert.equal(preview.status, 200);
    assert.match(preview.text, /<head><script src="\/__sp_probe\.js"><\/script>/);
    assert.match(preview.headers['content-security-policy'], /^sandbox allow-scripts/);

    const form = { draftId: staged.data.draft.id, title: 'Mine', modelName: 'Model X', vendor: 'VX', note: 'Original note', effort: 'high', tool: 'CLI', trial: { loaded: true, loadMs: 120 } };
    assert.equal((await call('alice', 'POST', '/api/works', form)).status, 400);
    const submitted = await call('alice', 'POST', '/api/works', { ...form, confirmed: true });
    assert.equal(submitted.status, 200);
    upload = submitted.data.work;
    assert.equal(upload.modelName, 'Model X');
    assert.equal(upload.vendor, '');
    assert.equal(upload.note, 'Original note\n手填模型厂商：VX');
    assert.equal(platform.db.prepare('SELECT model_other FROM works WHERE id = ?').get(upload.id).model_other, 'Model X');
    assert.equal(upload.status, 'unverified');
    assert.deepEqual([...Object.values(platform.db.prepare('SELECT show_gallery, show_arena FROM works WHERE id = ?').get(upload.id))], [1, 0], '新投稿默认展览馆开、竞技场关');
    assert.equal(upload.effort, 'High');
    const original = await fetchContent(upload.scene);
    assert.equal(original.status, 200);
    assert.doesNotMatch(original.text, /__sp_fold\.js/);
    const boot = await call('bob', 'GET', '/api/bootstrap');
    assert.equal(boot.data.arena.one.works, 0, 'unverified uploads and unapproved curated works all stay out of blind comparisons');
    assert.equal(boot.data.works[0].checks, undefined, 'upload reports are private');
  });

  test('blind matches reveal nothing until the vote, and each pair counts once per voter', async () => {
    // 精选馆藏默认不进正式盲测池：先在竞技场面逐件审批 a1/b1。
    assert.equal((await call('root', 'POST', '/api/admin/works/one/a1/face-settings', { show_arena: true })).status, 200);
    assert.equal((await call('root', 'POST', '/api/admin/works/one/b1/face-settings', { show_arena: true })).status, 200);
    const match = await call('alice', 'POST', '/api/arena/matches', { task: 'one' });
    assert.equal(match.status, 200);
    assert.deepEqual(Object.keys(match.data).sort(), ['a', 'b', 'counted', 'id', 'task']);
    for (const url of [match.data.a, match.data.b]) assert.match(new URL(url).hostname, /^m[0-9a-f]{32}\.localhost$/);
    const frame = await fetchContent(match.data.a);
    assert.equal(frame.status, 200);
    assert.match(frame.text, /<script src="\/__sp_fold\.js"><\/script>/);
    assert.equal((await fetchContent(new URL('/__sp_fold.js', match.data.a).href)).status, 200);
    const vote = await call('alice', 'POST', `/api/arena/matches/${match.data.id}/vote`, { choice: 'a' });
    assert.equal(vote.data.counted, true);
    assert.ok(['A1', 'B1'].includes(vote.data.a.title));
    assert.equal((await call('alice', 'POST', `/api/arena/matches/${match.data.id}/vote`, { choice: 'b' })).status, 409);
    assert.equal((await call('alice', 'POST', '/api/arena/matches', { task: 'one' })).data.code, 'exhausted');
    const board = await call('alice', 'GET', '/api/leaderboard?task=one');
    assert.equal(board.data.totals.votes, 1);
    assert.equal(board.data.rows.length, 2);
  });

  test('the leaderboard scores one task category and the combined board ranks entries per category', async () => {
    const scoped = (await call('alice', 'GET', '/api/leaderboard?category=建模')).data;
    assert.equal(scoped.category, '建模');
    assert.equal(scoped.totals.votes, 1);
    const combined = (await call('alice', 'GET', '/api/leaderboard')).data;
    assert.equal(combined.category, null);
    assert.deepEqual(combined.standings, { 建模: Object.fromEntries(scoped.rows.map((row) => [row.key, row.rank])) });
    for (const query of ['category=文学', 'category=建模&task=one']) {
      assert.equal((await call('alice', 'GET', `/api/leaderboard?${query}`)).status, 400);
    }
  });

  test('review moves uploads into the arena; questioned works stop counting and interacting', async () => {
    assert.equal((await call('alice', 'POST', `/api/works/one/${upload.id}/review`, { status: 'verified' })).status, 403);
    // 裸审核 = 默认门面（展览馆开、竞技场关）；显式开竞技场才进配对池。
    const reviewed = await call('root', 'POST', `/api/works/one/${upload.id}/review`, { status: 'verified', show_gallery: true, show_arena: true, vendor: 'VX' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.work.note, 'Original note\n手填模型厂商：VX');
    assert.equal((await call('bob', 'GET', '/api/bootstrap')).data.arena.one.entries, 3);

    // Alice never meets her own work; Bob may.
    for (let i = 0; i < 3; i++) {
      const match = await call('bob', 'POST', '/api/arena/matches', { task: 'one' });
      if (match.status !== 200) break;
      await call('bob', 'POST', `/api/arena/matches/${match.data.id}/vote`, { choice: 'tie' });
    }
    assert.equal((await call('bob', 'GET', '/api/leaderboard?task=one')).data.totals.votes, 4);
    assert.equal((await call('bob', 'POST', `/api/works/one/${upload.id}/reactions`, { emoji: '🔥' })).data.counts['🔥'], 1);

    assert.equal((await call('root', 'POST', `/api/works/one/${upload.id}/review`, { status: 'questioned' })).status, 400);
    assert.equal((await call('root', 'POST', `/api/works/one/${upload.id}/review`, { status: 'questioned', reason: '无法核实' })).status, 200);
    assert.equal((await call('bob', 'POST', `/api/works/one/${upload.id}/reactions`, { emoji: '👀' })).status, 409);
    assert.equal((await call('bob', 'GET', '/api/leaderboard?task=one')).data.totals.votes, 2, 'votes involving the questioned work drop out');
  });

  test('comments belong only to listed works and can be removed by their author or an admin', async () => {
    const path = `/api/works/one/${upload.id}/comments`;
    const preflight = await fetch(base + path, { method: 'OPTIONS', headers: {
      origin: base, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal((await call('guest', 'GET', path)).status, 404, 'questioned upload is not listed');
    assert.equal((await call('root', 'POST', `/api/works/one/${upload.id}/review`, { status: 'verified' })).status, 200);
    assert.equal((await call('guest', 'POST', path, { body: 'hello' })).status, 401);
    assert.equal((await call('bob', 'POST', path, { body: 'hello' }, { origin: false })).status, 403);
    for (const body of ['', ' ', 'x'.repeat(281), 7]) {
      assert.equal((await call('bob', 'POST', path, { body })).status, 400);
    }
    const created = await call('bob', 'POST', path, { body: '  喜欢这个作品  ' });
    assert.equal(created.status, 200);
    assert.equal(created.data.comment.body, '喜欢这个作品');
    assert.equal(created.data.comment.author, 'bob');
    const id = created.data.comment.id;
    const listed = await call('guest', 'GET', path);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.comments[0].id, id);
    assert.equal(listed.data.comments[0].canDelete, false);
    assert.equal((await call('alice', 'DELETE', `/api/comments/${id}`)).status, 403);
    assert.equal((await call('bob', 'DELETE', `/api/comments/${id}`)).status, 200);
    assert.deepEqual((await call('guest', 'GET', path)).data.comments, []);
    assert.ok(platform.db.prepare('SELECT deleted_at FROM comments WHERE id = ?').get(id).deleted_at);
    assert.equal((await call('bob', 'DELETE', `/api/comments/${id}`)).status, 404);

    const curated = await call('alice', 'POST', '/api/works/one/a1/comments', { body: '馆藏评论' });
    assert.equal(curated.status, 200);
    assert.equal((await call('root', 'DELETE', `/api/comments/${curated.data.comment.id}`)).status, 200);
    const match = await call('guest', 'POST', '/api/arena/matches', { task: 'one' });
    assert.equal(match.status, 200);
    assert.deepEqual(Object.keys(match.data).sort(), ['a', 'b', 'counted', 'id', 'task'], 'blind match carries no comments');
  });

  test('calibration preserves Show1 framing and camera independently without changing trial reports', async () => {
    const path = `/api/works/${upload.id}/calibration`;
    const preflight = await fetch(base + path, { method: 'OPTIONS', headers: {
      origin: base, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type',
    } });
    assert.equal(preflight.status, 204);
    const framing = { width: 1280, height: 720, zoom: 1.25, offsetX: -0.1, offsetY: 0.2 };
    const camera = { position: [1, 2, 3], target: [0, 0, 0] };
    assert.equal((await call('guest', 'GET', path)).data.calibration, null);
    assert.equal((await call('guest', 'PATCH', path, { calibration: { framing } })).status, 401);
    assert.equal((await call('bob', 'PATCH', path, { calibration: { framing } })).status, 403);
    assert.equal((await call('alice', 'PATCH', path, { calibration: { framing } }, { origin: false })).status, 403);
    for (const invalid of [{ zoom: 5 }, { offsetX: 2 }, { offsetY: -2 }, { width: 2.5 }]) {
      assert.equal((await call('alice', 'PATCH', path, { calibration: { framing: { ...framing, ...invalid } } })).status, 400);
    }
    assert.equal((await call('alice', 'PATCH', path, { calibration: { camera: { position: [1, 2], target: [0, 0, 0] } } })).status, 400);
    assert.equal((await call('alice', 'PATCH', path, { calibration: { framing } })).status, 200);
    assert.deepEqual((await call('root', 'PATCH', path, { calibration: { camera } })).data.calibration, { framing, camera });
    assert.deepEqual((await call('guest', 'GET', path)).data.calibration, { framing, camera });
    const publicWork = (await call('guest', 'GET', '/api/bootstrap')).data.works.find((work) => work.id === upload.id);
    assert.deepEqual(publicWork.calibration, { framing, camera });
    assert.equal(publicWork.trial, undefined);
    const stored = JSON.parse(platform.db.prepare('SELECT trial FROM works WHERE id = ?').get(upload.id).trial);
    assert.equal(stored.loaded, true);
    assert.equal(stored.loadMs, 120);
    assert.deepEqual(stored.calibration, { framing, camera });
    assert.deepEqual((await call('alice', 'PATCH', path, { calibration: { framing: null } })).data.calibration, { camera });
    assert.equal((await call('root', 'PATCH', path, { calibration: null })).data.calibration, null);
    assert.equal((await call('guest', 'GET', '/api/works/a1/calibration')).status, 404, 'curated works use their own data package');
  });

  test('only the author or an admin can delete an upload', async () => {
    assert.equal((await call('bob', 'DELETE', `/api/works/one/${upload.id}`)).status, 403);
    assert.equal((await call('alice', 'DELETE', `/api/works/one/${upload.id}`)).status, 409, 'works with votes keep the match history; question them instead');
    assert.equal((await fetchContent(upload.scene)).status, 200, 'the voted work stays online');
    assert.equal((await call('root', 'DELETE', '/api/works/one/a1')).status, 409, 'curated works are managed in the repository');
    const staged = await call('alice', 'POST', '/api/drafts?task=one&name=temp.html', '<!doctype html><html><head><title>Temp</title></head><body><p>Temp</p></body></html>', { raw: true });
    const temp = await call('alice', 'POST', '/api/works', { draftId: staged.data.draft.id, confirmed: true, title: 'Temp', modelId: 'm-a', tool: 'CLI' });
    assert.equal(temp.status, 200);
    assert.equal((await call('bob', 'DELETE', `/api/works/one/${temp.data.work.id}`)).status, 403);
    assert.equal((await call('alice', 'DELETE', `/api/works/one/${temp.data.work.id}`)).status, 200, 'vote-free works delete freely');
  });

  test('user administration is admin-only, guards self-demotion and writes audit', async () => {
    assert.equal((await call('nobody', 'GET', '/api/admin/users')).status, 401);
    assert.equal((await call('alice', 'GET', '/api/admin/users')).status, 403);

    const list = await call('root', 'GET', '/api/admin/users');
    assert.equal(list.status, 200);
    const alice = list.data.users.find((user) => user.name === 'alice');
    const root = list.data.users.find((user) => user.name === 'root');
    assert.ok(alice && root);
    assert.deepEqual(Object.keys(alice).sort(), ['createdAt', 'id', 'name', 'role'], 'the list never carries salt or hash');

    assert.equal((await call('alice', 'POST', `/api/admin/users/${alice.id}/role`, { role: 'admin' })).status, 403, 'members cannot promote anyone');
    const promoted = await call('root', 'POST', `/api/admin/users/${alice.id}/role`, { role: 'admin' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.data.user.role, 'admin');
    assert.equal((await call('alice', 'GET', '/api/admin/users')).status, 200, 'promotion takes effect on the next request');

    const demoted = await call('root', 'POST', `/api/admin/users/${alice.id}/role`, { role: 'member' });
    assert.equal(demoted.status, 200);
    assert.equal((await call('alice', 'GET', '/api/admin/users')).status, 403, 'demotion takes effect on the next request');

    assert.equal((await call('root', 'POST', `/api/admin/users/${root.id}/role`, { role: 'member' })).status, 409, 'an admin cannot demote itself');
    assert.equal((await call('root', 'POST', `/api/admin/users/${alice.id}/role`, { role: 'boss' })).status, 400, 'unknown roles are refused');
    assert.equal((await call('root', 'POST', '/api/admin/users/nope/role', { role: 'admin' })).status, 404);

    const review = await call('root', 'GET', '/api/review');
    const entries = review.data.audit.filter((row) => row.action === 'role');
    assert.ok(entries.length >= 2, 'role changes are written to the audit log');
    assert.match(entries[0].detail, /alice/);
  });

  test('publishing requires a session and complete question details', async () => {
    const body = { title: 'Keyboard', summary: 'Test product interaction', prompt: 'Build a keyboard.', tags: ['Three.js'], templates: ['static'] };
    assert.equal((await call('guest', 'POST', '/api/questions', body)).status, 401);
    assert.equal((await call('bob', 'POST', '/api/questions', body, { origin: false })).status, 403);
    for (const invalid of [{ title: ' ' }, { summary: '' }, { prompt: '' }, { tags: [] }, { tags: ['bad,tag'] }, { tags: Array.from({ length: 7 }, (_, i) => `tag${i}`) }, { templates: [] }, { templates: ['server'] }]) {
      assert.equal((await call('bob', 'POST', '/api/questions', { ...body, ...invalid })).status, 400);
    }
  });

  test('a published question persists, joins the catalogue and binds uploads to itself', async () => {
    const created = await call('bob', 'POST', '/api/questions', {
      title: 'Dense question grid', summary: 'Compare responsive layouts.', prompt: 'Build a page.\nKeep this exact prompt.',
      tags: [' #three.js ', 'Three.js', '界面'], templates: ['static'], owner: 'root',
    });
    assert.equal(created.status, 200);
    const question = created.data.question;
    assert.deepEqual(question.tags, ['Three.js', '界面']);
    assert.equal(question.owner, 'bob');
    assert.equal(question.version, 1);
    const boot = (await call('guest', 'GET', '/api/bootstrap')).data;
    assert.equal(boot.questions.find((q) => q.id === question.id).prompt, question.prompt);
    assert.equal(boot.arena[question.id].uploads, true);
    assert.equal((await call('guest', 'GET', `/api/leaderboard?task=${question.id}`)).status, 200);
    const reopened = openDatabase(join(root, 'data', 'platform.db'));
    try { assert.deepEqual(createQuestions(reopened).get(question.id), question); } finally { reopened.close(); }

    const html = '<!doctype html><title>New question answer</title><h1>Answer</h1>';
    assert.equal((await call('bob', 'POST', `/api/drafts?task=${question.id}&template=vite&name=answer.html`, html, { raw: true })).status, 400);
    const staged = await call('bob', 'POST', `/api/drafts?task=${question.id}&template=static&name=answer.html`, html, { raw: true });
    assert.equal(staged.status, 200);
    assert.equal(staged.data.draft.task, question.id);
    const submitted = await call('bob', 'POST', '/api/works', { draftId: staged.data.draft.id, task: 'one', confirmed: true, title: 'Answer', modelId: 'm-a', effort: 'High', tool: 'CLI' });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.work.task, question.id, 'the draft owns the task; request metadata cannot move it');
    assert.equal((await fetchContent(submitted.data.work.scene)).status, 200);
    assert.equal((await call('guest', 'GET', '/api/me')).status, 401);
    const mine = (await call('bob', 'GET', '/api/me')).data;
    assert.deepEqual(mine.questions.map((q) => q.id), [question.id]);
    assert.ok(mine.works.some((work) => work.id === submitted.data.work.id));
    assert.ok(!(await call('alice', 'GET', '/api/me')).data.questions.some((q) => q.id === question.id), 'another account cannot see the question in its own submissions');
  });

  test('Vite-only questions require a built project and serve its dist entry', async () => {
    const created = await call('alice', 'POST', '/api/questions', { title: 'Vite', summary: 'Built browser page', prompt: 'Build it.', tags: ['Vite'], templates: ['vite'] });
    const id = created.data.question.id;
    assert.deepEqual((await call('alice', 'GET', '/api/me')).data.questions.map((q) => q.id), [id]);
    assert.ok(!(await call('bob', 'GET', '/api/me')).data.questions.some((q) => q.id === id));
    assert.equal((await call('alice', 'POST', `/api/drafts?task=${id}&name=answer.html`, '<html>hi</html>', { raw: true })).status, 400);
    const archive = zip([
      { name: 'package.json', data: '{}' },
      { name: 'index.html', data: '<html><script type="module" src="/src/main.js"></script></html>' },
      { name: 'dist/index.html', data: '<html><h1>Built answer</h1></html>' },
    ]);
    const staged = await call('alice', 'POST', `/api/drafts?task=${id}&template=vite&name=answer.zip`, archive, { raw: true });
    assert.equal(staged.status, 200);
    assert.equal(staged.data.draft.root, 'dist');
    assert.match((await fetchContent(staged.data.draft.preview)).text, /Built answer/);
  });

  test('a nickname is private to its account, persists and leaves the login name unchanged', async () => {
    assert.equal((await call('guest', 'PATCH', '/api/me', { nickname: '访客' })).status, 401);
    assert.equal((await call('alice', 'PATCH', '/api/me', { nickname: '新昵称' }, { origin: false })).status, 403);
    for (const nickname of ['', '   ', 'x'.repeat(25), 'a\nb', null]) {
      assert.equal((await call('alice', 'PATCH', '/api/me', { nickname })).status, 400);
    }
    const changed = await call('alice', 'PATCH', '/api/me', { nickname: '  河畔观测员  ', name: 'root', role: 'admin' });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.name, 'alice');
    assert.equal(changed.data.user.nickname, '河畔观测员');
    assert.equal(changed.data.user.role, 'member');
    const boot = (await call('alice', 'GET', '/api/bootstrap')).data;
    assert.equal(boot.user.nickname, '河畔观测员');
    assert.ok(boot.questions.some((question) => question.owner === '河畔观测员'));
    assert.equal((await call('bob', 'GET', '/api/bootstrap')).data.user.nickname, 'bob');
    const reopened = openDatabase(join(root, 'data', 'platform.db'));
    try { assert.equal(reopened.prepare('SELECT nickname FROM users WHERE name = ?').get('alice').nickname, '河畔观测员'); } finally { reopened.close(); }
    const login = await call('alice-again', 'POST', '/api/auth/login', { name: 'alice', password: 'correct horse' });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.nickname, '河畔观测员');
  });

  test('an avatar defaults from the user id and can be picked from the library alone', async () => {
    const boot = (await call('alice', 'GET', '/api/bootstrap')).data;
    const { avatars } = boot.site;
    assert.ok(avatars.slice(0, 16).includes(boot.user.avatar));
    assert.equal((await call('alice', 'GET', '/api/bootstrap')).data.user.avatar, boot.user.avatar);
    for (const avatar of ['', 'unknown', null, 3]) {
      assert.equal((await call('alice', 'PATCH', '/api/me', { avatar, nickname: '不该保存' })).status, 400);
    }
    const picked = avatars.find((id) => id !== boot.user.avatar);
    const changed = await call('alice', 'PATCH', '/api/me', { avatar: picked });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.avatar, picked);
    assert.notEqual(changed.data.user.nickname, '不该保存');
    assert.ok((await call('bob', 'GET', '/api/bootstrap')).data.questions
      .filter((question) => question.community && question.owner === changed.data.user.nickname)
      .every((question) => question.ownerAvatar === picked));
  });

  test('personal activity counts participation while received reactions exclude self and deleted works', async () => {
    assert.equal((await call('charlie', 'POST', '/api/auth/register', { name: 'charlie', password: 'correct horse' })).status, 200);
    const empty = (await call('charlie', 'GET', '/api/me')).data;
    assert.equal(empty.activity.total, 0);
    assert.equal(empty.activity.activeDays, 0);
    assert.equal(empty.receivedReactions.total, 0);

    const created = await call('charlie', 'POST', '/api/questions', { title: 'Profile test', summary: 'A profile fixture', prompt: 'Make a page.', tags: ['UI'], templates: ['static'] });
    const task = created.data.question.id;
    const staged = await call('charlie', 'POST', `/api/drafts?task=${task}&name=answer.html`, '<!doctype html><title>Answer</title><h1>Answer</h1>', { raw: true });
    const submitted = await call('charlie', 'POST', '/api/works', { draftId: staged.data.draft.id, confirmed: true, title: 'Answer', modelId: 'm-a', tool: 'CLI' });
    assert.equal(submitted.status, 200);
    const workPath = `/api/works/${task}/${submitted.data.work.id}`;
    const match = await call('charlie', 'POST', '/api/arena/matches', { task: 'one' });
    assert.equal((await call('charlie', 'POST', `/api/arena/matches/${match.data.id}/vote`, { choice: 'tie' })).status, 200);
    assert.equal((await call('charlie', 'POST', '/api/works/one/a1/reactions', { emoji: '👍' })).status, 200);
    assert.equal((await call('charlie', 'POST', `${workPath}/reactions`, { emoji: '🔥' })).status, 200);
    assert.equal((await call('bob', 'POST', `${workPath}/reactions`, { emoji: '🔥' })).status, 200);
    assert.equal((await call('alice', 'POST', `${workPath}/reactions`, { emoji: '❤️' })).status, 200);
    const mine = (await call('charlie', 'GET', '/api/me')).data;
    assert.equal(mine.activity.total, 5);
    assert.equal(mine.activity.activeDays, 1);
    assert.equal(mine.activity.days[0].date, mine.activity.to);
    assert.equal((Date.parse(mine.activity.to) - Date.parse(mine.activity.from)) / 86400000, 364);
    assert.deepEqual(mine.receivedReactions, { counts: { '❤️': 1, '🔥': 1 }, total: 2 });
    assert.equal((await call('bob', 'GET', '/api/me')).data.receivedReactions.total, 0);
    await call('bob', 'POST', `${workPath}/reactions`, { emoji: '🔥' });
    assert.equal((await call('charlie', 'GET', '/api/me')).data.receivedReactions.total, 1);

    platform.db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(Date.now() - 366 * 86400000, task);
    assert.equal((await call('charlie', 'GET', '/api/me')).data.activity.total, 4, 'older participation is outside the rolling year');
    assert.equal((await call('charlie', 'DELETE', workPath)).status, 200);
    const deleted = (await call('charlie', 'GET', '/api/me')).data;
    assert.equal(deleted.receivedReactions.total, 0);
    assert.equal(deleted.activity.total, 4, 'past submissions remain part of personal activity');

  });

  test('imported works stay out of both public lists until admin chooses a site', async () => {
    const staged = await call('alice', 'POST', '/api/drafts?task=one&name=legacy.html', '<!doctype html><html><head><title>Legacy</title></head><body><h1>Legacy</h1></body></html>', { raw: true });
    assert.equal(staged.status, 200);
    const submitted = await call('alice', 'POST', '/api/works', { draftId: staged.data.draft.id, confirmed: true, title: 'Legacy', modelId: 'm-a', tool: 'CLI' });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    const id = submitted.data.work.id;
    platform.db.prepare("UPDATE works SET show_gallery = 0, show_arena = 0 WHERE id = ?").run(id);
    const path = `/api/works/one/${id}`;
    assert.ok(!(await call('guest', 'GET', '/api/bootstrap')).data.works.some((work) => work.id === id));
    assert.ok(!(await call('guest', 'GET', '/api/show1/works')).data.works.some((work) => work.id === id));
    assert.equal((await call('bob', 'POST', `${path}/reactions`, { emoji: '👍' })).status, 409);
    assert.equal((await call('guest', 'GET', `${path}/comments`)).status, 404);
    assert.equal((await call('root', 'POST', `${path}/review`, { status: 'verified' })).status, 400);
    assert.equal((await call('bob', 'POST', `${path}/review`, { status: 'verified', audience: 'show1' })).status, 403);
    assert.equal((await call('root', 'POST', `${path}/review`, { status: 'verified', audience: 'show1' })).status, 200);
    assert.ok(!(await call('guest', 'GET', '/api/bootstrap')).data.works.some((work) => work.id === id));
    assert.ok((await call('guest', 'GET', '/api/show1/works')).data.works.some((work) => work.id === id));
    assert.equal((await call('guest', 'GET', `${path}/comments`)).status, 200);
    assert.equal((await call('guest', 'GET', '/api/bootstrap')).data.arena.one.works, 4, 'the voted upload stays in the pool: match history anchors it');
  });

  test('uploads name their prompt version, resume their draft and stay editable by the author until reviewed', async () => {
    const html = '<!doctype html><html><head><title>Versioned</title></head><body><h1>Versioned</h1></body></html>';
    const staged = await call('bob', 'POST', '/api/drafts?task=versions&name=v.html', html, { raw: true });
    assert.equal(staged.status, 200);
    assert.equal((await call('bob', 'GET', '/api/drafts?task=versions')).data.draft.id, staged.data.draft.id);
    assert.equal((await call('alice', 'GET', '/api/drafts?task=versions')).data.draft, null);
    const form = { draftId: staged.data.draft.id, confirmed: true, title: 'Versioned', modelId: 'm-a', harnessOther: 'CLI' };
    assert.equal((await call('bob', 'POST', '/api/works', form)).status, 400, 'a versioned task needs the prompt version');
    assert.equal((await call('bob', 'POST', '/api/works', { ...form, promptVariant: 'medium' })).status, 400);
    const submitted = await call('bob', 'POST', '/api/works', { ...form, promptVariant: 'short', generationMode: 'agent', humanIntervention: 'none' });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    const { id } = submitted.data.work;
    assert.equal(submitted.data.work.promptVariant, 'short');
    assert.equal(submitted.data.work.generationMode, 'agent');

    const path = `/api/works/versions/${id}`;
    assert.equal((await call('alice', 'PATCH', path, { title: 'Stolen' })).status, 403);
    assert.equal((await call('bob', 'PATCH', path, { promptVariant: '' })).status, 400);
    assert.equal((await call('bob', 'PATCH', path, { harnessOther: '' })).status, 400);
    const edited = await call('bob', 'PATCH', path, { promptVariant: 'long', note: 'Two rounds', humanIntervention: 'prompt-guided' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.deepEqual([edited.data.work.promptVariant, edited.data.work.note, edited.data.work.humanIntervention, edited.data.work.title], ['long', 'Two rounds', 'prompt-guided', 'Versioned']);
    assert.equal((await call('root', 'POST', `${path}/review`, { status: 'verified' })).status, 200);
    assert.equal((await call('bob', 'PATCH', path, { title: 'Late' })).status, 409, 'reviewed works are frozen for the author');
    assert.equal((await call('root', 'POST', `/api/admin/works/versions/${id}/meta`, { title: 'Fixed' })).status, 200);
    assert.equal((await call('bob', 'DELETE', path)).status, 200);
  });
});
