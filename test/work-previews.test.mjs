import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkPreview } from '../server/work-previews.mjs';
import { createAuth } from '../server/auth.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { createLibrary } from '../server/library.mjs';
import { limits } from '../server/config.mjs';
import { openDatabase } from '../server/db.mjs';
import { verifiedUser } from './helpers/email.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'work-previews-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, 'works', 'up-abcdefgh');
  const mediaDir = join(root, 'media');
  const previewDir = join(mediaDir, 'up-abcdefgh');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  const entry = Buffer.from('<html>Original upload</html>');
  writeFileSync(join(workDir, 'index.html'), entry);
  const work = { id: 'up-abcdefgh', dir: workDir, entry: 'index.html', curated: false };
  return { work, mediaDir, previewDir, entry };
}

test('returns a model preview only when source and both preview files match the manifest', (t) => {
  const { work, mediaDir, previewDir, entry } = fixture(t);
  const model = Buffer.from('packed mesh');
  const poster = Buffer.from('webp poster');
  writeFileSync(join(previewDir, 'preview.sbox'), model);
  writeFileSync(join(previewDir, 'preview.webp'), poster);
  writeFileSync(join(previewDir, 'preview.json'), JSON.stringify({
    schemaVersion: 1, sourceDigest: hash(entry), mode: 'model',
    model: 'preview.sbox', modelSha: hash(model), poster: 'preview.webp', posterSha: hash(poster),
  }));

  const preview = readWorkPreview(mediaDir, work);
  assert.equal(preview.previewMode, 'model');
  assert.match(preview.previewModel, /^media\/up-abcdefgh\/preview\.sbox\?v=[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{12}$/);
  assert.match(preview.previewPoster, /^media\/up-abcdefgh\/preview\.webp\?v=/);

  writeFileSync(join(work.dir, 'index.html'), '<html>Updated upload</html>');
  assert.equal(readWorkPreview(mediaDir, work), null, 'an older adaptation is hidden after the source changes');
  writeFileSync(join(work.dir, 'index.html'), entry);
  writeFileSync(join(previewDir, 'preview.webp'), 'changed poster');
  assert.equal(readWorkPreview(mediaDir, work), null, 'altered preview bytes do not match their recorded hash');
  rmSync(join(previewDir, 'preview.sbox'));
  assert.equal(readWorkPreview(mediaDir, work), null, 'missing model files are not exposed');
});

test('rechecks same-size media rewrites when mtime is restored', (t) => {
  const { work, mediaDir, previewDir, entry } = fixture(t);
  const model = Buffer.from('packed mesh');
  const poster = Buffer.from('webp poster');
  const changedPoster = Buffer.from('faux poster');
  assert.equal(changedPoster.length, poster.length);
  const posterPath = join(previewDir, 'preview.webp');
  const manifestPath = join(previewDir, 'preview.json');
  const manifest = {
    schemaVersion: 1, sourceDigest: hash(entry), mode: 'model',
    model: 'preview.sbox', modelSha: hash(model), poster: 'preview.webp', posterSha: hash(poster),
  };
  writeFileSync(join(previewDir, 'preview.sbox'), model);
  writeFileSync(posterPath, poster);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  assert.equal(readWorkPreview(mediaDir, work)?.previewMode, 'model');
  const fixedTime = new Date('2026-01-02T03:04:05.000Z');
  utimesSync(posterPath, fixedTime, fixedTime);
  const originalStat = statSync(posterPath, { bigint: true });
  writeFileSync(posterPath, changedPoster);
  utimesSync(posterPath, fixedTime, fixedTime);
  const changedStat = statSync(posterPath, { bigint: true });
  assert.equal(changedStat.size, originalStat.size);
  assert.equal(changedStat.mtimeNs, originalStat.mtimeNs);
  assert.equal(readWorkPreview(mediaDir, work), null, 'same-size changed bytes must invalidate the cached digest');

  writeFileSync(posterPath, poster);
  utimesSync(posterPath, fixedTime, fixedTime);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(readWorkPreview(mediaDir, work)?.previewMode, 'model', 'restored bytes and manifest validate again');
});

test('returns an independent screenshot capture without replacing the upload cover', (t) => {
  const { work, mediaDir, previewDir, entry } = fixture(t);
  const capture = Buffer.from('adapted screenshot');
  writeFileSync(join(previewDir, 'preview.jpg'), capture);
  writeFileSync(join(previewDir, 'preview.json'), JSON.stringify({
    schemaVersion: 1, sourceDigest: hash(entry), mode: 'screenshot',
    capture: 'preview.jpg', captureSha: hash(capture),
  }));

  assert.deepEqual(readWorkPreview(mediaDir, work), {
    previewMode: 'screenshot',
    previewCapture: `media/${work.id}/preview.jpg?v=${hash(entry).slice(0, 12)}-${hash(capture).slice(0, 12)}`,
  });
  assert.equal(readWorkPreview(mediaDir, { ...work, curated: true }), null);
});

test('a model can supply a separately verified screenshot for switching modes', (t) => {
  const { work, mediaDir, previewDir, entry } = fixture(t);
  const model = Buffer.from('packed mesh'), poster = Buffer.from('webp poster'), capture = Buffer.from('default screenshot');
  const manifest = { schemaVersion: 1, sourceDigest: hash(entry), mode: 'model',
    model: 'preview.sbox', modelSha: hash(model), poster: 'preview.webp', posterSha: hash(poster),
    capture: 'preview.jpg', captureSha: hash(capture) };
  for (const [name, bytes] of [['preview.sbox', model], ['preview.webp', poster], ['preview.jpg', capture]]) writeFileSync(join(previewDir, name), bytes);
  writeFileSync(join(previewDir, 'preview.json'), JSON.stringify(manifest));
  const preview = readWorkPreview(mediaDir, work);
  assert.equal(preview.previewMode, 'model');
  assert.match(preview.previewCapture, /^media\/up-abcdefgh\/preview\.jpg\?v=/);
  writeFileSync(join(previewDir, 'preview.jpg'), 'changed screenshot');
  const changed = readWorkPreview(mediaDir, work);
  assert.equal(changed.previewModel, preview.previewModel);
  assert.equal(changed.previewCapture, undefined, 'a stale optional screenshot falls back without replacing a valid model');
  writeFileSync(join(work.dir, 'index.html'), 'changed source');
  assert.equal(readWorkPreview(mediaDir, work), null, 'both modes remain bound to the original source');
});

test('toPublic adds adapted previews to readable uploads only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'work-preview-dto-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'results', 'one', 'curated'), { recursive: true });
  writeFileSync(join(dist, 'results', 'one', 'curated', 'index.html'), '<html>Packaged work</html>');
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Preview DTO', models: [{ id: 'model-a', name: 'Model A', vendor: 'Test' }],
    tasks: [{ id: 'one', title: 'One', prompt: 'Compare models.', templates: ['static'], results: [
      { id: 'curated', model: 'model-a', title: 'Packaged work', scene: 'results/one/curated/', previewModel: 'assets/curated.sbox' },
    ] }] }));

  const dataDir = join(root, 'data');
  const db = openDatabase(join(root, 'platform.db'));
  const auth = createAuth(db, { admins: ['root'], secureCookies: false, sessionTtl: 60_000 });
  const library = createLibrary({ db, catalog: createCatalog(dist), config: { dataDir,
    contentTemplate: 'https://{token}.content.example.test', cdn: [], moderation: { enabled: false } }, limits });
  const model = Buffer.from('packed model'), poster = Buffer.from('webp poster');
  function installPreview(work) {
    const directory = join(dataDir, 'media', work.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'preview.sbox'), model);
    writeFileSync(join(directory, 'preview.webp'), poster);
    writeFileSync(join(directory, 'preview.json'), JSON.stringify({ schemaVersion: 1,
      sourceDigest: hash(readFileSync(join(work.dir, work.entry))), mode: 'model', model: 'preview.sbox', modelSha: hash(model),
      poster: 'preview.webp', posterSha: hash(poster) }));
  }
  try {
    const admin = auth.createAdmin('root', 'correct horse');
    const publicDraft = library.createDraft(admin, 'one', 'public.html', Buffer.from('<html>Public upload</html>'));
    const publicUpload = library.submit(admin, { draftId: publicDraft.id, confirmed: true, title: 'Public upload', modelId: 'model-a',
      effort: 'High', providerId: 'official' });
    library.review(admin, 'one', publicUpload.id, { status: 'verified' });
    installPreview(library.work('one', publicUpload.id));
    const publicView = library.toPublic(library.work('one', publicUpload.id));
    assert.equal(publicView.previewMode, 'model');
    assert.match(publicView.previewModel, /^media\/up-[a-z0-9]{8}\/preview\.sbox\?v=/);
    assert.match(publicView.previewPoster, /^media\/up-[a-z0-9]{8}\/preview\.webp\?v=/);

    const author = await verifiedUser(auth, 'previewauthor');
    const privateDraft = library.createDraft(author, 'one', 'private.html', Buffer.from('<html>Private upload</html>'));
    const privateUpload = library.submit(author, { draftId: privateDraft.id, confirmed: true, title: 'Private upload', modelId: 'model-a',
      effort: 'High', providerId: 'official', harnessOther: 'CLI' });
    installPreview(library.work('one', privateUpload.id));
    const privateWork = library.work('one', privateUpload.id);
    assert.equal(library.toPublic(privateWork).previewModel, undefined, 'a private upload does not expose model media publicly');
    assert.match(library.toPublic(privateWork, author).previewModel, /^media\/up-[a-z0-9]{8}\/preview\.sbox\?v=/,
      'the author can see their own adaptation');
    assert.equal(library.toPublic(library.work('one', 'curated')).previewModel, undefined,
      'curated results continue to use their datapack resources');
  } finally { db.close(); }
});
