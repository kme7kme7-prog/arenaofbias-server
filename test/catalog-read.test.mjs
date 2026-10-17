import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog } from '../server/catalog.mjs';

test('read batches reuse lookups, separate viewers, release after exceptions and observe edits between batches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-read-'));
  const data = { models: [{ id: 'm', name: 'Model' }], tasks: [] };
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data));
  let calls = 0, title = 'Original', catalog;
  const questions = { bindCatalog(value) { catalog = value; }, get(id, viewer) {
    calls++;
    return id === 'private' && !viewer?.id ? null : { id, title, mine: Boolean(viewer?.id), role: viewer?.role };
  }, all: () => [] };
  try {
    createCatalog(dir, questions);
    catalog.withSnapshot(() => {
      for (let i = 0; i < 100; i++) assert.equal(catalog.task('one').title, 'Original');
      assert.equal(calls, 1);
      assert.equal(catalog.task('private'), null);
      assert.equal(catalog.task('private', { id: 'owner', role: 'user' }).mine, true);
      assert.equal(catalog.task('private', { id: 'owner', role: 'admin' }).role, 'admin');
      assert.equal(catalog.task('private'), null);
      catalog.withSnapshot(() => assert.equal(catalog.task('one').title, 'Original'));
    });
    title = 'Changed'; assert.equal(catalog.task('one').title, 'Changed');
    assert.throws(() => catalog.withSnapshot(() => { throw new Error('stop'); }), /stop/);
    data.models[0].name = 'New model';
    writeFileSync(join(dir, 'data.json'), JSON.stringify(data));
    assert.equal(catalog.model('m').name, 'New model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
