import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { verifiedUser } from './helpers/email.mjs';

const DAY = 86400e3;
const html = '<!doctype html><title>Test</title><h1>Test</h1>';
const workBody = { confirmed: true, title: 'Test work', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'Test harness', trial: { loaded: true } };

async function withPlatform(run, quota = { pendingPerUser: 2, trustedPendingPerUser: 4, trustedMinVerified: 3 }) {
  const root = mkdtempSync(join(tmpdir(), 'author-progress-'));
  const dist = join(root, 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Test', models: [{ id: 'ma', name: 'Model A' }], tasks: [{ id: 'one', title: 'One', results: [] }] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: false },
    limits: { ...limits, ...quota } });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map(), users = {};
  async function call(who, method, path, body, raw = false) {
    const headers = { origin: base, ...(cookies.has(who) ? { cookie: cookies.get(who) } : {}) };
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookies.set(who, response.headers.get('set-cookie').split(';')[0]);
    return { status: response.status, data: await response.json() };
  }
  const now = Date.now();
  function work(id, owner = 'author', options = {}) {
    const { task = 'one', status = 'unverified', moderation = { status: 'legacy' }, createdAt = now - DAY,
      reviewedAt = null, galleryAt = null, deletedAt = null, curatedAs = null } = options;
    platform.db.prepare(`INSERT INTO works
      (id, task_id, owner_id, title, model_other, content_key, source_name, root, entry, file_count, bytes, digest, checks, trial,
      created_at, updated_at, status, moderation, reviewed_at, reviewed_gallery_at, deleted_at, curated_as)
      VALUES (?, ?, ?, ?, 'Model', ?, 'test.html', '', 'index.html', 1, 100, ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, task, users[owner].id, id, `key-${id}`, `digest-${id}`, createdAt, createdAt, status, JSON.stringify(moderation), reviewedAt, galleryAt, deletedAt, curatedAs);
  }
  function question(id, status) {
    platform.db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation, category)
      VALUES (?, ?, ?, 'Summary', 'Prompt', '[]', '["static"]', ?, ?, '静态网页')`)
      .run(id, users.author.id, id, now, JSON.stringify({ status, at: now - 1000 }));
  }
  async function submit(task = 'one', who = 'author') {
    const draft = await call(who, 'POST', `/api/drafts?task=${task}&name=work.html`, html, true);
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    return task === '__new__'
      ? call(who, 'POST', '/api/questions', { title: 'New question', summary: 'Summary', prompt: 'Prompt', category: '静态网页', templates: ['static'],
        draftId: draft.data.draft.id, confirmed: true, work: workBody })
      : call(who, 'POST', '/api/works', { ...workBody, draftId: draft.data.draft.id });
  }
  try {
    for (const name of ['author', 'other']) users[name] = await verifiedUser(platform.auth, name);
    users.root = platform.auth.createAdmin('root', 'correct horse');
    for (const name of ['author', 'other', 'root']) assert.equal((await call(name, 'POST', '/api/auth/login', { name, password: 'correct horse' })).status, 200);
    await run({ ...platform, users, call, work, question, submit, now });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('default members can hold eight pending works and both staff roles are unlimited', async () => withPlatform(async ({ auth, db, users, work, call, submit }) => {
  for (let i = 0; i < 7; i++) work(`member-${i}`);
  const boot = (await call('author', 'GET', '/api/bootstrap')).data;
  assert.equal(boot.site.limits.pendingPerUser, 8);
  assert.equal(boot.me.pendingLimit, 8);
  assert.equal((await submit()).status, 200);
  for (const task of ['one', '__new__']) {
    const response = await submit(task);
    assert.equal(response.status, 429);
    assert.match(response.data.error, /上限 8 件/);
  }
  db.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(users.other.id);
  auth.bindEmail(users.root.id, 'root@example.test');
  for (const who of ['other', 'root']) {
    for (let i = 0; i < 8; i++) work(`${who}-${i}`, who);
    assert.equal((await call(who, 'GET', '/api/bootstrap')).data.me.pendingLimit, null);
    for (const task of ['one', '__new__']) assert.equal((await submit(task, who)).status, 200);
  }
}, {}));

test('rejected content and rejected question samples release quota for both submission routes', async () => withPlatform(async ({ work, question, call, submit }) => {
  question('rejected-question', 'rejected');
  question('pending-question', 'pending');
  work('rejected-content', 'author', { moderation: { status: 'rejected' } });
  work('rejected-sample', 'author', { task: 'rejected-question' });
  work('pending-sample', 'author', { task: 'pending-question', moderation: { status: 'review' } });
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.pending, 1);
  assert.equal((await submit()).status, 200);
  const full = await call('author', 'GET', '/api/bootstrap');
  assert.equal(full.data.me.pending, 2);
  for (const task of ['one', '__new__']) {
    const response = await submit(task);
    assert.equal(response.status, 429);
    assert.equal(response.data.error, '你已有 2 件作品在等待核验（上限 2 件），核验完成或删除作品后名额会释放');
  }
}));

test('trusted quota uses verified count and the 90 day questioned history', async () => withPlatform(async ({ db, users, work, call, submit, now }) => {
  for (let i = 0; i < 3; i++) work(`verified-${i}`, 'author', { status: 'verified', reviewedAt: now - DAY, galleryAt: now - DAY });
  work('pending-a'); work('pending-b');
  const bootstrap = await call('author', 'GET', '/api/bootstrap');
  assert.equal(bootstrap.data.site.limits.pendingPerUser, 2);
  assert.equal(bootstrap.data.me.pendingLimit, 4);
  assert.equal((await submit()).status, 200);
  assert.equal((await call('root', 'GET', '/api/bootstrap')).data.me.pendingLimit, null);
  work('old-questioned', 'author', { status: 'questioned', reviewedAt: now - 91 * DAY });
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.pendingLimit, 4);
  // A later recovery must not erase a recent questioned decision from the credit rule.
  db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now - DAY, users.root.id, 'root', 'questioned', 'one', 'verified-0', '{}');
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.pendingLimit, 2);
  assert.equal((await submit()).status, 429);
  db.prepare('DELETE FROM audit').run();
  db.prepare('UPDATE works SET deleted_at = ? WHERE id = ?').run(now, 'verified-0');
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.pendingLimit, 2);
}));

test('queueAhead follows the gallery review queue in created time and ID order', async () => withPlatform(async ({ work, question, call, now }) => {
  question('held', 'pending');
  work('arena-first', 'other', { status: 'verified', createdAt: now - 3 * DAY, reviewedAt: now - DAY });
  work('a-peer', 'other', { createdAt: now - 2 * DAY });
  work('z-mine', 'author', { createdAt: now - 2 * DAY });
  work('last', 'author', { createdAt: now - DAY });
  work('content-held', 'author', { moderation: { status: 'review' } });
  work('question-held', 'author', { task: 'held' });
  work('done', 'other', { status: 'verified', galleryAt: now - DAY, createdAt: now - 4 * DAY });
  work('questioned', 'other', { status: 'questioned', createdAt: now - 4 * DAY });
  work('curated', 'other', { curatedAs: 'one/curated', createdAt: now - 4 * DAY });
  const mine = (await call('author', 'GET', '/api/me')).data.works;
  assert.equal(mine.find(item => item.id === 'z-mine').queueAhead, 2);
  assert.equal(mine.find(item => item.id === 'last').queueAhead, 3);
  for (const id of ['content-held', 'question-held']) assert.equal(Object.hasOwn(mine.find(item => item.id === id), 'queueAhead'), false);
  assert.equal((await call('root', 'GET', '/api/bootstrap')).data.review.unverified, 4);
  assert.equal((await call('other', 'GET', '/api/me')).data.works.find(item => item.id === 'arena-first').queueAhead, undefined);
}));

test('updates and changed track decisions, seen clears them, and review stats require five samples', async () => withPlatform(async ({ db, users, work, call, now }) => {
  work('reviewed', 'author', { status: 'verified', createdAt: now - 2 * DAY, reviewedAt: now - DAY });
  work('content-rejected', 'author', { moderation: { status: 'rejected', at: now - 1000 } });
  work('old', 'author', { status: 'questioned', reviewedAt: now - 8 * DAY });
  work('pending', 'author', { moderation: { status: 'pending', at: now - 1000 } });
  work('review', 'author', { moderation: { status: 'review', at: now - 1000 } });
  work('deleted', 'author', { status: 'questioned', reviewedAt: now - 1000, deletedAt: now - 500 });
  let profile = (await call('author', 'GET', '/api/me')).data;
  assert.deepEqual(profile.works.filter(item => item.changed).map(item => item.id).sort(), ['content-rejected', 'reviewed']);
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.updates, 2);
  assert.equal(profile.reviewStats.medianHours, null);
  for (const [i, hours] of [2, 4, 6, 8].entries()) work(`sample-${i}`, 'other', { status: 'verified', createdAt: now - DAY - hours * 3600e3, reviewedAt: now - DAY });
  profile = (await call('author', 'GET', '/api/me')).data;
  assert.equal(profile.reviewStats.medianHours, 6);
  work('sample-even', 'other', { status: 'verified', createdAt: now - DAY - 10 * 3600e3, reviewedAt: now - DAY });
  assert.equal((await call('author', 'GET', '/api/me')).data.reviewStats.medianHours, 7);
  assert.equal((await call('anonymous', 'POST', '/api/me/works/seen')).status, 401);
  const seen = await call('author', 'POST', '/api/me/works/seen');
  assert.deepEqual(seen, { status: 200, data: { ok: true } });
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.updates, 0);
  assert.equal((await call('author', 'GET', '/api/me')).data.works.some(item => item.changed), false);
  const seenAt = db.prepare('SELECT works_seen_at FROM users WHERE id = ?').get(users.author.id).works_seen_at;
  db.prepare('UPDATE works SET moderation = ? WHERE id = ?').run(JSON.stringify({ status: 'approved', at: seenAt + 1 }), 'pending');
  assert.equal((await call('author', 'GET', '/api/bootstrap')).data.me.updates, 1);
}));
