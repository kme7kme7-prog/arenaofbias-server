import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { createReferences } from '../server/references.mjs';
import { referencePng, referenceJpeg, referenceWebp, referenceWithMetadata } from './helpers/reference-images.mjs';

const owner = { id: 'owner', role: 'user' }, other = { id: 'other', role: 'user' }, staff = { id: 'staff', role: 'admin' };
function fixture(run, limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reference-images-')), db = openDatabase(':memory:');
  try {
    for (const user of [owner, other, staff]) db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.id, user.id, 'unused', 'unused', 1);
    const references = createReferences({ db, config: { dataDir: root }, limits });
    run({ root, db, references, path: (ref) => join(root, 'references', ref.src.split('/').at(-1)) });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
const fails = (run, status = 400) => assert.throws(run, (error) => error.status === status && /[\p{Script=Han}]/u.test(error.message));

test('JPEG, PNG and WebP uploads strip metadata without changing compressed pixels or dimensions', () => fixture(({ db, references, path }) => {
  for (const [ext, base] of [['png', referencePng], ['jpg', referenceJpeg], ['webp', referenceWebp]]) {
    const ref = references.upload(owner, `camera.${ext === 'jpg' ? 'jpeg' : ext}`, referenceWithMetadata(ext));
    assert.deepEqual([ref.width, ref.height], [3, 2]);
    assert.match(ref.id, /^r-[0-9a-f]{32}$/); assert.ok(ref.src.endsWith(`.${ext}`));
    const clean = readFileSync(path(ref));
    assert.ok(!clean.includes(Buffer.from('private'))); assert.ok(!clean.includes(Buffer.from('Exif')));
    if (ext === 'png') assert.deepEqual(clean, base);
    if (ext === 'jpg') assert.deepEqual(clean, Buffer.concat([base.subarray(0, 2), base.subarray(20)])); // JFIF stripped too.
    if (ext === 'webp') {
      assert.equal(clean.readUInt32LE(4) + 8, clean.length); assert.equal(clean[20], 0);
      assert.deepEqual(clean.subarray(30), base.subarray(12));
    }
    const row = db.prepare('SELECT * FROM reference_uploads WHERE id = ?').get(ref.id);
    assert.equal(ref.bytes, clean.length); assert.equal(row.bytes, clean.length);
    assert.equal(row.sha256, createHash('sha256').update(clean).digest('hex'));
  }
}));

test('uploads reject mismatched names, unsupported and truncated files and over 5 MiB without leaving files', () => fixture(({ root, db, references }) => {
  fails(() => references.upload(null, 'image.png', referencePng), 401);
  fails(() => references.upload(owner, 'image.png', referenceJpeg));
  fails(() => references.upload(owner, 'image.jpg', referencePng));
  fails(() => references.upload(owner, 'image.svg', Buffer.from('<svg/>')));
  fails(() => references.upload(owner, 'image.png', referencePng.subarray(0, 40)));
  fails(() => references.upload(owner, 'image.jpg', referenceJpeg.subarray(0, -2)));
  fails(() => references.upload(owner, 'image.webp', referenceWebp.subarray(0, -1)));
  fails(() => references.upload(owner, 'image.png', Buffer.alloc(5 * 1024 * 1024 + 1)), 413);
  assert.throws(() => references.upload({ id: 'missing' }, 'image.png', referencePng));
  assert.deepEqual(readdirSync(join(root, 'references')), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reference_uploads').get().n, 0);
}));

test('prepare checks ownership, expiry, attachment, real extensions, canonical names, duplicates and captions', () => fixture(({ db, references }) => {
  const a = references.upload(owner, 'a.png', referencePng), b = references.upload(owner, 'b.jpeg', referenceJpeg);
  const valid = { id: a.id, name: '01-构图.png', caption: '构图参考' };
  assert.deepEqual(references.prepare(owner, [valid]), [{ ...valid, src: a.src, width: 3, height: 2 }]);
  for (const input of [null, {}, Array(9).fill(valid), [{ ...valid, name: '1-构图.png' }], [{ ...valid, name: '../01-构图.png' }],
    [{ ...valid, name: '01-构图.jpg' }], [{ ...valid, name: '01-构图.PNG' }], [{ ...valid, caption: '字'.repeat(41) }],
    [valid, valid], [valid, { id: b.id, name: valid.name }], [{ ...valid, id: 'missing' }]]) fails(() => references.prepare(owner, input));
  fails(() => references.prepare(other, [valid]));
  const refs = references.prepare(owner, [valid]); references.save('task', refs);
  fails(() => references.prepare(owner, [valid])); fails(() => references.prepare(staff, [valid], { taskId: 'another-task' }));
  assert.deepEqual(references.prepare(staff, [valid], { taskId: 'task' }), refs);
  db.prepare('UPDATE reference_uploads SET created_at = ? WHERE id = ?').run(Date.now() - 24 * 3600e3, b.id);
  fails(() => references.prepare(owner, [{ id: b.id, name: '02-细节.jpg' }]));
}));

test('save reorders and renames references, detaches removed files for 24 hours, and deletion removes attached files', () => fixture(({ db, references, path }) => {
  const a = references.upload(owner, 'a.png', referencePng), b = references.upload(owner, 'b.png', referencePng);
  const refs = references.prepare(owner, [{ id: a.id, name: '01-布局.png' }, { id: b.id, name: '02-细节.png' }]);
  references.save('task', refs);
  references.save('task', [{ ...refs[1], name: '01-细节.png', caption: '新说明' }, { ...refs[0], name: '02-布局.png' }]);
  assert.deepEqual(references.forQuestion('task').map((ref) => [ref.id, ref.name, ref.caption]), [[b.id, '01-细节.png', '新说明'], [a.id, '02-布局.png', '']]);
  db.prepare('UPDATE reference_uploads SET created_at = 1 WHERE id = ?').run(a.id);
  references.save('task', [references.forQuestion('task')[0]]);
  const detached = db.prepare('SELECT * FROM reference_uploads WHERE id = ?').get(a.id);
  assert.equal(detached.task_id, null); assert.ok(detached.created_at > 1);
  assert.equal(references.cleanup(detached.created_at + 24 * 3600e3 - 1), 0); assert.ok(existsSync(path(a)));
  assert.equal(references.cleanup(detached.created_at + 24 * 3600e3), 1); assert.ok(!existsSync(path(a)));
  references.removeQuestion('task'); assert.deepEqual(references.forQuestion('task'), []); assert.ok(!existsSync(path(b)));
}));

test('image reads follow task visibility once attached and use upload ownership only before attachment', () => fixture(({ references }) => {
  let publicTask = false;
  references.bindQuestions({ get: (id, viewer) => id === 'task' && (publicTask || viewer?.id === other.id || viewer?.role === 'admin') ? { id } : null });
  const ref = references.upload(owner, 'a.png', referencePng);
  fails(() => references.file(ref.id), 404); fails(() => references.file(ref.id, other), 404);
  assert.equal(references.file(ref.id, owner).public, false); assert.equal(references.file(ref.id, staff).type, 'image/png');
  references.save('task', references.prepare(owner, [{ id: ref.id, name: '01-参考.png' }]));
  fails(() => references.file(ref.id), 404); fails(() => references.file(ref.id, owner), 404);
  assert.equal(references.file(ref.id, other).public, false); assert.equal(references.file(ref.id, staff).public, false);
  publicTask = true;
  assert.equal(references.file(ref.id).public, true); assert.equal(references.file(ref.id).name, '01-参考.png');
}));
