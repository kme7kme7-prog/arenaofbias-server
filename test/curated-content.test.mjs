import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS } from '../server/db.mjs';

test('public curated indexes survive restart, respect current gates, and never extend private previews', async () => {
  const root = mkdtempSync(join(tmpdir(), 'curated-content-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const data = { title: '测试', models: [{ id: 'm', name: '模型', vendor: '测试' }], tasks: ['one', 'two'].map((id, i) => ({
    id, arenaId: `09${i}`, title: id, prompt: '测试', results: [{ id: 'same-id', title: id, model: 'm', scene: `results/${id}` }],
  })) };
  for (const task of data.tasks) {
    mkdirSync(join(dist, 'results', task.id), { recursive: true });
    writeFileSync(join(dist, 'results', task.id, 'index.html'), `<html><head></head><body>${task.id}</body></html>`);
  }
  const save = () => writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  save();
  const secret = 'test-only-private-configuration';
  const config = { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: [],
    cdn: [], capture: false, secureCookies: false, moderation: { enabled: false, apiKey: secret, recheckHours: 0 } };
  let platform;
  const content = createServer((req, res) => platform.handleContent(req, res));
  const site = createServer((req, res) => platform.handleSite(req, res));
  await Promise.all([new Promise(resolve => content.listen(0, '127.0.0.1', resolve)), new Promise(resolve => site.listen(0, '127.0.0.1', resolve))]);
  const read = (key, path = '/') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: content.address().port, path, headers: { Host: `${key}.localhost` } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  const roster = async () => (await fetch(`http://127.0.0.1:${site.address().port}/api/works`)).json();
  try {
    platform = createPlatform({ config, limits });
    const work = platform.library.work('one', 'same-id');
    const key = platform.library.curatedContentKey(work);
    const other = platform.library.curatedContentKey(platform.library.work('two', 'same-id'));
    assert.match(key, /^c[0-9a-f]{32}$/);
    assert.notEqual(key, other);
    assert.equal(platform.library.curatedContentKey(work), key);
    const page = await read(key);
    assert.equal(page.status, 200);
    assert.match(page.body, /data-aob-probe/);
    assert.match(page.body, /<body>one<\/body>/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match((await read(other)).body, /<body>two<\/body>/);
    let list = await roster();
    assert.match(list.works.find(row => row.id === 'dp-090-same-id').content, new RegExp(key));
    assert.equal(JSON.stringify(list).includes(secret), false);
    work.status = 'unverified';
    assert.equal(platform.library.curatedContentKey(work), null);
    assert.equal((await read(key)).status, 410);
    work.status = 'verified';
    work.moderation = { status: 'review' };
    assert.equal(platform.library.curatedContentKey(work), null);
    assert.equal((await read(key)).status, 410);
    delete work.moderation;
    const preview = new URL(platform.library.previewOrigin(work)).hostname.split('.')[0];
    assert.equal((await read(preview)).status, 200);
    assert.match((await read(preview, '/?aob=prev')).body, /data-aob-probe/);
    const now = Date.now;
    try { Date.now = () => now() + 3600e3 + 1; assert.equal((await read(preview)).status, 410); assert.equal((await read(key)).status, 200); }
    finally { Date.now = now; }
    const pendingPreview = new URL(platform.library.previewOrigin(work)).hostname.split('.')[0];
    await platform.close();
    platform = createPlatform({ config, limits });
    assert.equal(platform.db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.equal(platform.library.curatedContentKey(platform.library.work('one', 'same-id')), key);
    assert.equal((await read(key)).status, 200);
    assert.equal((await read(pendingPreview)).status, 410);
    platform.db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, show_entertainment, updated_by, updated_at)
      VALUES ('one', 'same-id', 0, 0, 0, 'admin', 1)`).run();
    assert.equal(platform.library.curatedContentKey(work), null);
    assert.equal((await read(key)).status, 410);
    assert.equal((await roster()).works.some(row => row.id === 'dp-090-same-id'), false);
    platform.db.prepare("UPDATE work_overrides SET show_entertainment = 1 WHERE task_id = 'one'").run();
    assert.equal((await read(key)).status, 200);
    data.tasks[0].results = [];
    save();
    assert.equal((await read(key)).status, 410);
    assert.equal(platform.library.curatedContentKey(work), null);
    list = await roster();
    assert.equal(JSON.stringify(list).includes(secret), false);
  } finally {
    await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => content.close(resolve))]);
    await platform?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
