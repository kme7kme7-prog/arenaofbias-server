import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { limits } from '../server/config.mjs';

test('cover write failure keeps the draft and startup moves orphan work directories', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'submit-recovery-'));
  const dist = join(root, 'dist');
  const dataDir = join(root, 'state');
  fs.mkdirSync(dist);
  fs.writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Test', models: [], tasks: [{ id: 'one', title: 'One', results: [] }] }));
  const config = { dist, dataDir, contentTemplate: 'http://{token}.localhost', siteOrigins: [],
    admins: [], cdn: [], capture: false, secureCookies: false, trustProxy: false };
  let platform = createPlatform({ config, limits });
  try {
    const user = await verifiedUser(platform.auth, 'writer', 'correct horse');
    const draft = platform.library.createDraft(user, 'one', 'page.html', Buffer.from('<!doctype html><html><body>Test</body></html>'));
    const original = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (String(path).endsWith('cover.png.tmp')) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => platform.library.submit(user, { draftId: draft.id, confirmed: true, title: 'Test',
        modelName: 'Local', effort: 'Default', providerId: 'official', tool: 'Test', cover: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=' }),
      (error) => error.code === 'ENOSPC');
    } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 1);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'submit'").get().n, 0);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('cover.png')) throw Object.assign(new Error('Rename failed'), { code: 'EIO' });
      return rename(from, to);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => platform.library.submit(user, { draftId: draft.id, confirmed: true, title: 'Test',
        modelName: 'Local', effort: 'Default', providerId: 'official', tool: 'Test', cover: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=' }),
      (error) => error.code === 'EIO');
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 1);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'submit'").get().n, 0);
    assert.ok(fs.existsSync(join(dataDir, 'drafts', draft.id)));
    assert.equal(fs.readdirSync(join(dataDir, 'media')).length, 0);
    fs.mkdirSync(join(dataDir, 'works', 'up-orphan'));
    await new Promise((resolve) => setImmediate(resolve));
    await platform.close();
    platform = createPlatform({ config, limits });
    assert.equal(fs.existsSync(join(dataDir, 'works', 'up-orphan')), false);
    assert.ok(fs.readdirSync(join(dataDir, 'orphans')).some((name) => name.startsWith('up-orphan-')));
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    await platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
