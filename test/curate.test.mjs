import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { createCurator } from '../server/curate.mjs';
import { limits } from '../server/config.mjs';

const PAGE = '<!doctype html><html><body><p>Candidate</p></body></html>';

describe('nomination and export', () => {
  let root, platform, site, base, dist, data, id;
  const jars = new Map();
  const task = { id: 'one', title: 'One', results: [{
    id: 'a1', model: 'm-a', effort: '', title: 'A1', summary: '', scene: 'results/one/a1/', captures: {}, gallery: [],
  }] };
  async function call(who, method, path, body, raw = false) {
    const headers = { origin: base };
    if (jars.get(who)) headers.cookie = jars.get(who);
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jars.set(who, cookie.split(';')[0]);
    return { status: response.status, data: await response.json().catch(() => ({})) };
  }
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'curate-test-'));
    dist = join(root, 'dist');
    mkdirSync(join(dist, 'results/one/a1'), { recursive: true });
    writeFileSync(join(dist, 'results/one/a1/index.html'), PAGE);
    data = { title: 'test', models: [{ id: 'm-a', name: 'Model A', vendor: 'VA' }], tasks: [task] };
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    platform = createPlatform({ config: { dist, dataDir: join(root, 'data'), contentTemplate: '',
      siteOrigins: ['http://127.0.0.1'], admins: ['root'], cdn: [], capture: false,
      secureCookies: false, trustProxy: false }, limits });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${site.address().port}`;
    platform.auth.createAdmin('root', 'correct horse');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
    await verifiedUser(platform.auth, 'alice');
    assert.equal((await call('alice', 'POST', '/api/auth/login', { name: 'alice', password: 'correct horse' })).status, 200);
    const draft = await call('alice', 'POST', '/api/drafts?task=one&name=candidate.html', PAGE, true);
    assert.equal(draft.status, 200);
    const submission = await call('alice', 'POST', '/api/works', { draftId: draft.data.draft.id, confirmed: true,
      title: 'Candidate', modelId: 'm-a', tool: 'CLI' });
    assert.equal(submission.status, 200);
    id = submission.data.work.id;
  });
  after(async () => {
    site.close();
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('only a verified work can be nominated by an admin', async () => {
    const path = `/api/admin/works/one/${id}/nominate`;
    assert.equal((await call('alice', 'POST', path)).status, 403);
    assert.equal((await call('root', 'POST', path)).status, 409);
    assert.equal((await call('root', 'POST', `/api/works/one/${id}/review`, { status: 'verified', show_gallery: true })).status, 200);
    const nomination = await call('root', 'POST', path);
    assert.equal(nomination.status, 200);
    assert.match(nomination.data.command, /^npm run intake:from-server -- http:/);
    assert.equal(nomination.data.exportUrl.startsWith(base), true);
    assert.equal(platform.db.prepare('SELECT curated_as, nominated_at FROM works WHERE id = ?').get(id).curated_as, null);
    assert.ok(platform.db.prepare('SELECT nominated_at FROM works WHERE id = ?').get(id).nominated_at);
    assert.equal((await call('alice', 'GET', '/api/bootstrap')).data.works.some((work) => work.id === id), true);
    const exportPath = new URL(nomination.data.exportUrl).pathname;
    const meta = await call('alice', 'GET', exportPath);
    assert.equal(meta.status, 200);
    assert.equal(meta.data.id, id);
    assert.deepEqual([meta.data.harnessId, meta.data.harnessOther,
      meta.data.providerId, meta.data.providerOther], [null, 'CLI', null, '']);
    assert.equal('harnessVersion' in meta.data, false);
    assert.equal(meta.data.files.length, 1);
    const response = await fetch(base + exportPath + '/file?path=index.html');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), PAGE);
    assert.equal((await call('alice', 'GET', exportPath + '/file?path=../platform.db')).status, 404);
    const repeated = await call('root', 'POST', path);
    assert.equal(repeated.status, 200);
    assert.notEqual(repeated.data.exportUrl, nomination.data.exportUrl);
    assert.equal((await call('alice', 'GET', exportPath)).status, 404);
    const newPath = new URL(repeated.data.exportUrl).pathname;
    platform.db.prepare('UPDATE works SET export_expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
    assert.equal((await call('alice', 'GET', newPath)).status, 404);
    const again = await call('root', 'POST', path);
    assert.equal(again.status, 200);
    assert.equal((await call('alice', 'DELETE', path)).status, 403);
    assert.equal((await call('root', 'DELETE', path)).status, 200);
    assert.equal((await call('alice', 'GET', new URL(again.data.exportUrl).pathname)).status, 404);
  });

  test('a single export token serves more than 120 file requests in one minute', async () => {
    const nomination = await call('root', 'POST', `/api/admin/works/one/${id}/nominate`);
    assert.equal(nomination.status, 200);
    const path = new URL(nomination.data.exportUrl).pathname;
    for (let i = 0; i < 121; i++) {
      const response = await fetch(`${base}${path}/file?path=index.html`);
      assert.equal(response.status, 200, `file request ${i + 1}`);
      await response.arrayBuffer();
    }
  });

  test('takeover audits and rejects missing nomination, wrong task, or wrong source digest', async () => {
    await call('root', 'DELETE', `/api/admin/works/one/${id}/nominate`);
    const curator = createCurator({ db: platform.db, catalog: {}, library: platform.library });
    const sourceDigest = platform.db.prepare('SELECT digest FROM works WHERE id = ?').get(id).digest;
    const candidate = (taskId, digest) => ({ id: 'candidate', sourceUpload: id, sourceDigest: digest });
    const snapshot = (taskId, digest) => ({ tasks: () => [{ id: taskId, works: new Map([['candidate', candidate(taskId, digest)]]) }] });
    const rejected = () => platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'curate-reject' AND work_id = ?").get(id).n;
    let count = rejected();
    curator.takeover(snapshot('one', sourceDigest));
    assert.equal(rejected(), ++count);
    await call('root', 'POST', `/api/admin/works/one/${id}/nominate`);
    curator.takeover(snapshot('other', sourceDigest));
    assert.equal(rejected(), ++count);
    curator.takeover(snapshot('one', 'f'.repeat(64)));
    assert.equal(rejected(), ++count);
    assert.equal(platform.db.prepare('SELECT curated_as FROM works WHERE id = ?').get(id).curated_as, null);
  });

  test('new catalog sourceUpload retires the upload once', async () => {
    const nomination = await call('root', 'POST', `/api/admin/works/one/${id}/nominate`);
    assert.equal(nomination.status, 200);
    task.results.push({ id: 'new', model: 'm-a', effort: '', title: 'New', summary: '',
      scene: 'results/one/new/', captures: {}, gallery: [], sourceUpload: id,
      sourceDigest: platform.db.prepare('SELECT digest FROM works WHERE id = ?').get(id).digest });
    mkdirSync(join(dist, 'results/one/new'), { recursive: true });
    writeFileSync(join(dist, 'results/one/new/index.html'), PAGE);
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    assert.equal((await call('alice', 'GET', '/api/bootstrap')).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    const row = platform.db.prepare('SELECT curated_as, nominated_at, export_token_hash FROM works WHERE id = ?').get(id);
    assert.equal(row.curated_as, 'one/new');
    assert.equal(row.nominated_at, null);
    assert.equal(row.export_token_hash, null);
    assert.equal((await call('root', 'DELETE', `/api/admin/works/one/${id}/nominate`)).status, 409);
    const count = () => platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'curate' AND work_id = ?").get(id).n;
    const initial = count();
    await call('alice', 'GET', '/api/bootstrap');
    assert.equal(count(), initial);
    assert.equal((await call('alice', 'GET', '/api/bootstrap')).data.works.some((work) => work.id === id), false);
    assert.equal((await call('alice', 'GET', new URL(nomination.data.exportUrl).pathname)).status, 404);
  });

  test('switching the catalog inside a transaction completes takeover and preserves face settings', async () => {
    async function submit(title, gallery, arena) {
      const draft = await call('alice', 'POST', `/api/drafts?task=one&name=${title}.html`, PAGE, true);
      assert.equal(draft.status, 200);
      const submitted = await call('alice', 'POST', '/api/works', { draftId: draft.data.draft.id,
        confirmed: true, title, modelId: 'm-a', tool: 'CLI' });
      assert.equal(submitted.status, 200);
      const uploadId = submitted.data.work.id;
      assert.equal((await call('root', 'POST', `/api/works/one/${uploadId}/review`,
        { status: 'verified', show_gallery: gallery, show_arena: arena })).status, 200);
      assert.equal((await call('root', 'POST', `/api/admin/works/one/${uploadId}/nominate`)).status, 200);
      return uploadId;
    }
    const inheritedId = await submit('inherited', true, true);
    const preservedId = await submit('preserved', true, false);
    let invalidations = 0;
    const invalidate = platform.arena.invalidate;
    platform.arena.invalidate = () => { invalidations++; invalidate(); };
    platform.db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, updated_by, updated_at)
      VALUES ('one', 'preserved-curated', 0, 0, 'editor', ?)`).run(Date.now());
    for (const [curatedId, sourceUpload] of [['inherited-curated', inheritedId], ['preserved-curated', preservedId]]) {
      task.results.push({ id: curatedId, model: 'm-a', effort: '', title: curatedId, summary: '',
        scene: `results/one/${curatedId}/`, captures: {}, gallery: [], sourceUpload,
        sourceDigest: platform.db.prepare('SELECT digest FROM works WHERE id = ?').get(sourceUpload).digest });
      mkdirSync(join(dist, 'results/one', curatedId), { recursive: true });
      writeFileSync(join(dist, 'results/one', curatedId, 'index.html'), PAGE);
    }
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    const response = await call('root', 'POST', '/api/admin/works/batch-face-settings',
      { works: [{ task: 'one', id: 'a1' }], show_gallery: true });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    for (let n = 0; n < 20 && !platform.db.prepare('SELECT curated_as FROM works WHERE id = ?').get(inheritedId).curated_as; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(platform.db.prepare('SELECT curated_as FROM works WHERE id = ?').get(inheritedId).curated_as, 'one/inherited-curated');
    assert.equal(platform.db.prepare('SELECT curated_as FROM works WHERE id = ?').get(preservedId).curated_as, 'one/preserved-curated');
    assert.ok(invalidations >= 1, 'takeover clears the leaderboard cache');
    const flags = platform.db.prepare('SELECT show_gallery, show_arena FROM work_overrides WHERE task_id = ? AND work_id = ?');
    assert.deepEqual({ ...flags.get('one', 'inherited-curated') }, { show_gallery: 1, show_arena: 1 });
    assert.deepEqual({ ...flags.get('one', 'preserved-curated') }, { show_gallery: 0, show_arena: 0 });
  });
});
