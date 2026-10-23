import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compress } from '../server/compress.mjs';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { verifiedUser } from './helpers/email.mjs';

async function fixture(run, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'management-http-')), dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Fixture', models: [{ id: 'model', name: 'Model', vendor: 'Vendor' }], tasks: [
    { id: 'one', title: 'One', summary: 'Summary', prompt: 'Three.js public prompt', category: '建模', domains: ['物理'], templates: ['static'], results: [{ id: 'pack', title: 'Pack', model: 'model', scene: './' }] },
  ] }));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><h1>Fixture</h1>');
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: [], cdn: [], capture: false,
    secureCookies: false, moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 } }, limits, ...options });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const member = await verifiedUser(platform.auth, 'member'), moderator = await verifiedUser(platform.auth, 'moderator');
  const admin = platform.auth.createAdmin('root', 'correct horse');
  platform.auth.bindEmail(admin.id, 'root@example.test');
  platform.auth.setRole(admin, moderator.id, 'moderator');
  const cookies = {};
  for (const [key, user] of Object.entries({ member, moderator, admin })) platform.auth.startSession({ setHeader: (_name, value) => { cookies[key] = value.split(';')[0]; } }, user.id);
  const call = async (path, who = 'admin', body, headers = {}) => { const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(who ? { cookie: cookies[who] } : {}), ...(body ? { origin: base, 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, data: await res.json() }; };
  const insert = platform.db.prepare(`INSERT INTO works (id, task_id, owner_id, title, model_id, model_other, content_key, source_name, root, entry,
    file_count, bytes, digest, checks, trial, created_at, updated_at, status, moderation, reviewed_gallery_at, show_gallery, show_arena)
    VALUES (?, ?, ?, ?, 'model', '', ?, 'test.html', '', 'index.html', 1, 20, ?, '[]', '{"calibration":{"yaw":10}}', ?, ?, ?, ?, ?, ?, ?)`);
  function add(id, { task = 'one', owner = member, status = 'unverified', moderation = 'approved', reviewed = null, gallery = 0, arena = 0, at = Date.now() } = {}) {
    insert.run(id, task, owner.id, `Work ${id}`, `key-${id}`, `digest-${id}`, at, at, status, JSON.stringify({ status: moderation, source: 'human' }), reviewed, gallery, arena);
  }
  try { await run({ platform, call, member, moderator, admin, add }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await platform.close(); rmSync(root, { recursive: true, force: true }); }
}

test('management panels paginate fresh queues, leave heavy details on demand and preserve legacy reads', async () => fixture(async ({ platform, call, member, admin, add }) => {
  const now = Date.now();
  for (let n = 0; n < 57; n++) add(`pending-${n}`, { at: now + n });
  add('content', { moderation: 'review' }); add('auto', { moderation: 'pending' });
  add('verified', { status: 'verified', reviewed: now, gallery: 1 });
  add('off', { status: 'verified', reviewed: now });
  add('questioned', { status: 'questioned', reviewed: now });
  const created = await call('/api/admin/questions', 'admin', { title: 'Private', summary: 'Private summary', prompt: 'Secret unique', category: '建模', domains: ['化学'], templates: ['static'] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const privateQuestion = created.data.question;
  platform.db.prepare('UPDATE questions SET moderation = ? WHERE id = ?').run(JSON.stringify({ status: 'review' }), privateQuestion.id);
  add('sample', { task: privateQuestion.id, owner: admin });
  const legacy = (await call('/api/review')).data;
  assert.equal(legacy.works.length, 64);
  assert.ok(legacy.works.find(w => w.id === 'verified').trial);
  const first = (await call('/api/review?panel=unverified')).data;
  assert.equal(first.total, 57); assert.equal(first.works.length, 50); assert.equal(first.pageSize, 50);
  assert.equal(first.works[0].id, 'pending-0'); assert.equal(first.works[49].id, 'pending-49');
  assert.ok(first.works.every(w => w.bucket === 'unverified' && !Object.hasOwn(w, 'trial') && !Object.hasOwn(w, 'checks') && !Object.hasOwn(w, 'calibration_gallery')));
  const second = (await call('/api/review?panel=unverified&page=2')).data;
  assert.equal(second.works.length, 7); assert.equal(new Set([...first.works, ...second.works].map(w => w.id)).size, 57);
  const content = (await call('/api/review?panel=content')).data;
  assert.equal(content.total, 1); assert.equal(content.autoTotal, 1); assert.equal(content.autoWorks[0].id, 'auto');
  const defaults = (await call('/api/review?panel=default')).data;
  assert.equal(defaults.panel, 'questions'); assert.equal(defaults.questions[0].prompt, 'Secret unique');
  assert.equal(defaults.questions[0].samples[0].id, 'sample'); assert.equal(defaults.works[0].id, 'sample');
  add('content-older', { moderation: 'review', at: now - 1000 });
  add('auto-older', { moderation: 'pending', at: now - 1000 });
  const orderedContent = (await call('/api/review?panel=content')).data;
  assert.deepEqual(orderedContent.works.map(w => w.id), ['content-older', 'content']);
  assert.deepEqual(orderedContent.autoWorks.map(w => w.id), ['auto-older', 'auto']);
  const older = (await call('/api/admin/questions', 'admin', { title: 'Older', summary: 'Older summary', prompt: 'Older prompt', category: '建模', domains: ['化学'], templates: ['static'] })).data.question;
  platform.db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(now - 2000, older.id);
  assert.deepEqual((await call('/api/review?panel=questions')).data.questions.map(q => q.id), [older.id, privateQuestion.id]);
  platform.db.prepare("INSERT INTO votes (id,match_id,user_id,task_id,a_work,b_work,pair_key,choice,created_at) VALUES ('vote','vote',?,'one','pack','verified','pair','a',?)").run(member.id, now);
  const catalog = (await call('/api/review?panel=catalog&filter=all')).data;
  assert.deepEqual(new Set(catalog.domainChoices), new Set(['物理', '化学']));
  assert.ok(catalog.questions.every(q => !Object.hasOwn(q, 'prompt')));
  const publicQuestion = catalog.questions.find(q => q.id === 'one');
  assert.equal(publicQuestion.workCounts.unverified, 57); assert.equal(publicQuestion.workCounts.off, 1);
  assert.equal(publicQuestion.votes, 1, 'catalog retains deletion guards based on ballots');
  assert.equal((await call('/api/review?panel=catalog&q=threejs')).data.total, 1, 'prompt search still matches punctuation-folded words');
  const detail = (await call('/api/admin/works/one/verified')).data;
  assert.ok(detail.work.trial); assert.ok(detail.question.prompt);
  assert.ok(!(await call('/api/admin/works/one/verified', 'moderator')).data.question, 'ordinary moderators do not receive private question details');
  assert.equal((await call(`/api/admin/questions/${privateQuestion.id}`)).data.question.prompt, 'Secret unique');
  const ordinary = (await call('/api/review?panel=works', 'moderator')).data;
  assert.equal(ordinary.questionChoices.some(q => q.id === privateQuestion.id), false);
  assert.equal(ordinary.works.some(w => w.id === 'sample' && w.bucket === 'sample'), true);
  assert.equal((await call('/api/review?panel=questions', 'moderator')).status, 403);
  for (const who of [null, 'member']) assert.equal((await call('/api/review?panel=works', who)).status, who ? 403 : 401);
  platform.library.reviewContent(admin, 'one', 'pending-0', { status: 'rejected', reason: 'Withdrawn immediately' });
  assert.equal((await call('/api/review?panel=unverified')).data.total, 56);
  const logs = (await call('/api/review?panel=log')).data;
  assert.ok(logs.audit.some(row => row.work === 'pending-0'));
  assert.ok(logs.works.some(row => row.id === 'pending-0'), 'an existing audit target is not mislabelled as deleted');
  platform.auth.setRole(admin, (platform.auth.list().find(u => u.name === 'moderator')).id, 1);
  assert.equal((await call('/api/review?panel=works', 'moderator')).status, 403, 'revoked role is checked for the next request');
  for (const query of ['panel=works&page=0', 'panel=works&page=1&page=2', 'panel=works&pageSize=101', 'panel=unknown', 'panel=done&filter=unknown', 'panel=works&q=x&extra=y', 'panel=works&sort=oops']) assert.equal((await call(`/api/review?${query}`)).status, 400, query);
}));

test('member pagination and batch trust match the old individual trust rules including deleted/questioned history', async () => fixture(async ({ platform, call, member, admin, add }) => {
  for (let n = 0; n < limits.trustedMinVerified; n++) add(`verified-${n}`, { status: 'verified', reviewed: Date.now(), gallery: 1 });
  const compare = async () => {
    const legacy = (await call('/api/admin/users')).data.users;
    for (const user of legacy) { assert.equal(user.trusted, platform.library.trusted(user)); assert.equal(user.pendingLimit, platform.library.pendingLimit(user)); }
    const paged = (await call('/api/admin/users?page=1&pageSize=2&sort=oldest')).data;
    assert.equal(paged.total, 3); assert.equal(paged.users.length, 2);
    assert.deepEqual(paged.users, legacy.slice(0, 2));
    const next = (await call('/api/admin/users?page=2&pageSize=2&sort=oldest')).data;
    assert.deepEqual([...paged.users, ...next.users], legacy, 'all pages preserve every legacy member DTO');
    assert.equal(paged.filterCounts.all, 3); assert.equal(paged.counts.works, platform.library.allWorks().length);
    assert.ok(paged.audit.every(row => row.action === 'role'));
    assert.ok(paged.users.every(user => !Object.hasOwn(user, 'hash') && !Object.hasOwn(user, 'salt')));
    return legacy.find(user => user.id === member.id);
  };
  assert.equal((await compare()).trusted, true);
  platform.db.prepare('INSERT INTO audit (at,actor_name,action,task_id,work_id,detail) VALUES (?,?,?,?,?,?)').run(Date.now(), admin.name, 'questioned', 'one', 'verified-0', 'reason');
  platform.db.prepare('INSERT INTO audit (at,actor_name,action,task_id,work_id,detail) VALUES (?,?,?,?,?,?)').run(Date.now(), admin.name, 'questioned', 'one', 'verified-0', 'repeated history');
  assert.equal((await compare()).trusted, false);
  platform.db.prepare('UPDATE works SET deleted_at = ? WHERE id = ?').run(Date.now(), 'verified-0');
  await compare();
  assert.equal((await call('/api/admin/users?page=1&filter=trusted')).data.total, 0);
  assert.equal((await call('/api/admin/users?page=1&filter=2')).data.users[0].name, 'moderator');
  assert.equal((await call('/api/admin/users?page=1&q=MEM BER')).data.total, 1);
  for (const query of ['page=0', 'page=1&page=2', 'page=1&filter=5', 'page=1&email=no', 'page=1&sort=no', 'page=1&extra=secret']) assert.equal((await call(`/api/admin/users?${query}`)).status, 400, query);
  assert.equal((await call('/api/admin/users?page=1', 'moderator')).status, 403);
}));

test('me scopes return only the requested account data and reject ambiguous or unknown views', async () => fixture(async ({ platform, call, add }) => {
  add('mine');
  const legacy = (await call('/api/me', 'member')).data;
  const overview = (await call('/api/me?view=overview', 'member')).data;
  assert.deepEqual(overview.votes, legacy.votes); assert.ok(!Object.hasOwn(overview, 'works')); assert.ok(!Object.hasOwn(overview, 'questions'));
  const works = (await call('/api/me?view=works', 'member')).data;
  assert.deepEqual(works, { works: legacy.works, questions: legacy.questions, reviewStats: legacy.reviewStats });
  assert.deepEqual((await call('/api/me?view=questions', 'member')).data, { questions: legacy.questions });
  const authorWorks = platform.library.authorWorks;
  platform.library.authorWorks = () => { throw new Error('overview/questions must not build the work queue'); };
  try { assert.equal((await call('/api/me?view=overview', 'member')).status, 200); assert.equal((await call('/api/me?view=questions', 'member')).status, 200); }
  finally { platform.library.authorWorks = authorWorks; }
  for (const query of ['view=', 'view=nope', 'view=overview&view=works', 'view=overview&owner=other', 'owner=other']) assert.equal((await call(`/api/me?${query}`, 'member')).status, 400, query);
  assert.equal((await call('/api/me?view=works', null)).status, 401);
}));

test('private responses recheck identity and effective permissions after compression success or failure', async () => {
  for (const failed of [false, true]) for (const scenario of ['senior-to-moderator', 'staff-revoked', 'member-admin-revoked', 'signed-out', 'session-switched']) {
    let begin, finish, reject, source, encoding;
    const began = new Promise(resolve => { begin = resolve; });
    let held = false;
    await fixture(async ({ platform, call, add, admin, moderator, member }) => {
      for (let n = 0; n < 8; n++) add(`private-${n}`);
      const path = scenario === 'member-admin-revoked' ? '/api/admin/users?page=1' : scenario === 'senior-to-moderator' ? '/api/review?panel=works' : scenario === 'staff-revoked' ? '/api/review' : '/api/me?view=works';
      const who = scenario === 'staff-revoked' ? 'moderator' : ['signed-out', 'session-switched'].includes(scenario) ? 'member' : 'admin';
      const reading = call(path, who, undefined, { 'accept-encoding': 'gzip' });
      await began;
      if (scenario === 'senior-to-moderator' || scenario === 'member-admin-revoked') platform.db.prepare("UPDATE users SET role='moderator' WHERE id=?").run(admin.id);
      if (scenario === 'staff-revoked') platform.auth.setRole(admin, moderator.id, 1);
      if (scenario === 'signed-out') platform.db.prepare('DELETE FROM sessions WHERE user_id=?').run(member.id);
      if (scenario === 'session-switched') platform.db.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(moderator.id, member.id);
      if (failed) reject(new Error('controlled compression failure'));
      else finish(await compress(source, encoding));
      const response = await reading;
      assert.equal(response.status, ['signed-out', 'session-switched'].includes(scenario) ? 401 : 403, `${scenario}/${failed}`);
      assert.deepEqual(Object.keys(response.data), ['error']);
      assert.ok(!JSON.stringify(response.data).includes('private-'));
    }, { compressBody(body, used) { if (held) return compress(body, used); held = true; source = body; encoding = used; begin(); return new Promise((resolve, no) => { finish = resolve; reject = no; }); } });
  }
});

test('the uncompressed private path checks again and unmarked public reads do not recheck sessions', async () => fixture(async ({ platform, call }) => {
  const userFrom = platform.auth.userFrom;
  let reads = 0;
  platform.auth.userFrom = (...args) => { reads++; return reads === 1 ? userFrom.apply(platform.auth, args) : null; };
  try {
    assert.equal((await call('/api/me?view=questions', 'member', undefined, { 'accept-encoding': 'identity' })).status, 401);
    assert.equal(reads, 2);
    reads = 0;
    assert.equal((await call('/api/prompts?promptId=one', null, undefined, { 'accept-encoding': 'identity' })).status, 200);
    assert.equal(reads, 1, 'a public catalog does not perform a private before-send lookup');
  } finally { platform.auth.userFrom = userFrom; }
}));

test('selected public works and prompts rebuild after withdrawals during compression, including fallback', async () => {
  for (const failed of [false, true]) for (const endpoint of ['works', 'playground/works', 'prompts']) {
    let begin, finish, reject, source, encoding;
    const began = new Promise(resolve => { begin = resolve; });
    let held = false, armed = false;
    await fixture(async ({ platform, call, admin, add }) => {
      let task = 'one', id = 'pack';
      if (endpoint === 'prompts') {
        const created = await call('/api/admin/questions', 'admin', { title: 'Public pending withdrawal', summary: 'Summary', prompt: 'secret '.repeat(400), category: '建模', domains: ['物理'], templates: ['static'] });
        task = created.data.question.id;
        await call(`/api/questions/${task}/moderation`, 'admin', { status: 'approved' });
      } else {
        // Enough selected rows to require compression without unrelated catalog rows.
        for (let n = 0; n < 8; n++) add(`public-${n}`, { status: 'verified', reviewed: Date.now(), gallery: 1, arena: 1 });
        platform.db.exec('UPDATE works SET show_entertainment=1');
      }
      held = false;
      armed = true;
      const reading = call(`/api/${endpoint}?promptId=${task}`, null, undefined, { 'accept-encoding': 'gzip' });
      await began;
      if (endpoint === 'prompts') await call(`/api/questions/${task}/moderation`, 'admin', { status: 'rejected', reason: 'Withdraw current prompt' });
      else {
        platform.library.setFaceSettings(admin, task, id, { show_arena: false, show_entertainment: false });
        for (let n = 0; n < 8; n++) platform.library.reviewContent(admin, task, `public-${n}`, { status: 'rejected', reason: 'Withdraw current work' });
      }
      if (failed) reject(new Error('controlled public compression failure'));
      else finish(await compress(source, encoding));
      const response = await reading;
      assert.equal(response.status, 200);
      assert.deepEqual(response.data[endpoint === 'prompts' ? 'prompts' : 'works'], [], `${endpoint}/${failed}`);
    }, { compressBody(body, used) { if (!armed || held) return compress(body, used); held = true; source = body; encoding = used; begin(); return new Promise((resolve, no) => { finish = resolve; reject = no; }); } });
  }
});
