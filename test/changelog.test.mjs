import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { limits } from '../server/config.mjs';

const entry = { kind: 'improve', title: '更新标题', body: '更新正文', publishedOn: '2026-10-19', status: 'published' };

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'changelog-')), dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [], tasks: [] }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: ['http://127.0.0.1'], admins: [], cdn: [], capture: false, secureCookies: false }, limits });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, cookies = {};
  for (const name of ['root', 'staff']) {
    const user = platform.auth.createAdmin(name, 'correct horse');
    if (name === 'staff') platform.auth.promote(name, 'moderator');
    platform.auth.startSession({ setHeader: (_, value) => { cookies[name] = value.split(';')[0]; } }, user.id);
  }
  async function call(method, path, body, who = 'root') {
    const response = await fetch(base + path, { method, headers: { origin: base,
      ...(cookies[who] ? { cookie: cookies[who] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  try { await run(call); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('changelog v46 migration is idempotent and survives reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'changelog-migration-')), file = join(root, 'platform.db');
  try {
    let db = openDatabase(file);
    MIGRATIONS[45](db);
    db.close();
    db = openDatabase(file);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changelog_entries').get().n, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public changelog excludes drafts and reflects publishing and withdrawal', async () => {
  await fixture(async call => {
    const draft = await call('POST', '/api/admin/changelog', { ...entry, status: 'draft' });
    assert.equal(draft.status, 200);
    assert.deepEqual((await call('GET', '/api/changelog', undefined, 'guest')).data, { entries: [], total: 0 });
    const id = draft.data.entry.id;
    const published = await call('POST', `/api/admin/changelog/${id}`, entry);
    assert.equal(published.data.entry.status, 'published');
    const later = await call('POST', '/api/admin/changelog', entry);
    const visible = (await call('GET', '/api/changelog?limit=1', undefined, 'guest')).data;
    assert.equal(visible.total, 2);
    assert.deepEqual(visible.entries, [{ id: later.data.entry.id, kind: entry.kind, title: entry.title,
      body: entry.body, titleEn: '', bodyEn: '', link: '', publishedOn: entry.publishedOn }]);
    await call('POST', `/api/admin/changelog/${id}`, { ...entry, status: 'draft' });
    assert.equal((await call('GET', '/api/changelog', undefined, 'guest')).data.total, 1);
    assert.equal((await call('GET', '/api/admin/changelog')).data.entries.length, 2);
    assert.deepEqual((await call('DELETE', `/api/admin/changelog/${id}`)).data, { ok: true });
  });
});

test('non-Lv3 staff receive 403 on all changelog admin routes', async () => {
  await fixture(async call => {
    for (const [method, path] of [['GET', '/api/admin/changelog'], ['POST', '/api/admin/changelog'],
      ['POST', '/api/admin/changelog/1'], ['DELETE', '/api/admin/changelog/1']]) {
      assert.equal((await call(method, path, method === 'POST' ? entry : undefined, 'staff')).status, 403);
    }
  });
});

test('changelog validation returns a displayable 400 for typical invalid fields', async () => {
  await fixture(async call => {
    for (const change of [{ kind: 'unknown' }, { title: ' ' }, { body: '' }, { titleEn: 'x'.repeat(121), bodyEn: 'English' },
      { titleEn: 'English', bodyEn: 'x'.repeat(8001) }, { titleEn: 'English' }, { link: 'http://example.com' },
      { publishedOn: '2026-02-30' }, { status: 'unknown' }]) {
      const response = await call('POST', '/api/admin/changelog', { ...entry, ...change });
      assert.equal(response.status, 400, JSON.stringify(change));
      assert.match(response.data.error, /[\u4e00-\u9fff]/);
    }
  });
});
