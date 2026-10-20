import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { MIGRATIONS, openDatabase } from '../server/db.mjs';
import { limits } from '../server/config.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'announcements-')), dist = join(root, 'dist');
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
  try { await run({ call, base }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('announcement v47 migration is idempotent and survives reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'announcement-migration-')), file = join(root, 'platform.db');
  try {
    let db = openDatabase(file);
    MIGRATIONS[46](db);
    db.close();
    db = openDatabase(file);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 47);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only Lv3 can publish; public history keeps Markdown and orders newest first', async () => {
  await fixture(async ({ call }) => {
    const body = { title: '第一则', body: '# 标题\n\n**正文**' };
    assert.deepEqual((await call('GET', '/api/announcements', undefined, 'guest')).data, { entries: [] });
    assert.equal((await call('POST', '/api/admin/announcements', body, 'guest')).status, 401);
    assert.equal((await call('POST', '/api/admin/announcements', body, 'staff')).status, 403);
    const first = await call('POST', '/api/admin/announcements', body);
    assert.equal(first.status, 200);
    assert.equal(first.data.entry.body, body.body);
    const second = await call('POST', '/api/admin/announcements', { title: '第二则', body: '- 新内容' });
    const history = await call('GET', '/api/announcements', undefined, 'guest');
    assert.deepEqual(history.data.entries.map(e => e.id), [second.data.entry.id, first.data.entry.id]);
    assert.equal(history.data.entries[1].body, body.body);
    assert.match(history.data.entries[0].publishedAt, /^\d{4}-\d\d-\d\dT/);
  });
});

test('new publications reach already connected visitors', async () => {
  await fixture(async ({ call, base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/announcements/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      assert.match(decoder.decode((await reader.read()).value), /"id":0/);
      const published = await call('POST', '/api/admin/announcements', { title: '实时', body: '公告正文' });
      assert.match(decoder.decode((await reader.read()).value), new RegExp(`"id":${published.data.entry.id}`));
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  });
});

test('announcement validation rejects empty, oversized and control text', async () => {
  await fixture(async ({ call }) => {
    for (const body of [{ title: '', body: '内容' }, { title: '标题', body: ' ' },
      { title: '长'.repeat(101), body: '内容' }, { title: '标题', body: 'x'.repeat(20001) },
      { title: '标题', body: 'bad\u0000data' }]) {
      assert.equal((await call('POST', '/api/admin/announcements', body)).status, 400);
    }
  });
});
