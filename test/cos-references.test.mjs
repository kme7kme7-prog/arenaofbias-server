import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCosMirror, installCosMirror, isReferenceKey, packReferenceKey, packReferencePrefix, resetCosMirror, uploadedReferenceKey,
} from '../server/cos-dual-write.mjs';
import { openDatabase } from '../server/db.mjs';
import { createQuestions } from '../server/questions.mjs';
import { createReferences } from '../server/references.mjs';
import { referencePng } from './helpers/reference-images.mjs';

const CREDS = { COS_BUCKET: 'agi-1419403229', COS_REGION: 'ap-shanghai', COS_SECRET_ID: 'AKIDexample', COS_SECRET_KEY: 'secret-key-example' };
const GATED = { ...CREDS, COS_MEDIA_ACCESS_CONTROLLED: '1' };
const REF = `media/references/r-${'a'.repeat(32)}.jpg`;
const owner = { id: 'owner', name: 'Owner', role: 'user' }, admin = { id: 'admin', name: 'Admin', role: 'admin' };
const body = { title: 'Question', summary: 'Summary', prompt: 'Prompt', category: '静态网页', domains: ['数学'], templates: ['static'] };

function logger() {
  const lines = { log: [], warn: [] };
  return { lines, log: { log: (message) => lines.log.push(message), warn: (message) => lines.warn.push(message) } };
}
// Records https.request PUTs.
function fakeRequest() {
  const puts = [];
  const request = (options, onResponse) => {
    const chunks = [];
    return { on() {}, setTimeout() {}, write: (chunk) => chunks.push(chunk),
      end() { puts.push({ path: options.path, headers: options.headers, body: Buffer.concat(chunks) }); onResponse({ statusCode: 200, on: (event, fn) => event === 'end' && setImmediate(fn) }); } };
  };
  return { request, puts };
}
function fakeFetch({ pages = [], cdn = () => ({ Response: { TaskId: 't' } }) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const parsed = new URL(call.url);
    if (parsed.hostname === 'cdn.tencentcloudapi.com') return { status: 200, text: async () => JSON.stringify(cdn(JSON.parse(call.body))) };
    if (call.method === 'GET') return { status: 200, text: async () => pages.shift() ?? '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' };
    return { status: 204, text: async () => '' };
  };
  return { fetch, calls };
}
const mirrorWith = (env, extra = {}) => createCosMirror({ env, exists: () => false, retryDelays: [], ...extra });

test('reference keys are exactly the public src paths and nothing else', () => {
  assert.equal(uploadedReferenceKey(REF), REF);
  for (const bad of ['/media/references/r-1.jpg', `media/references/r-${'a'.repeat(32)}.gif`, 'media/up-abcd1234/first.jpg', `media/references/x/../r-${'a'.repeat(32)}.jpg`])
    assert.equal(uploadedReferenceKey(bad), null);
  assert.equal(packReferenceKey('denza-z', '01-front-three-quarter.jpg'), 'media/pack-references/denza-z/01-front-three-quarter.jpg');
  assert.equal(packReferenceKey('pack', '01-构图.png'), 'media/pack-references/pack/01-构图.png');
  for (const [task, name] of [['..', 'a.jpg'], ['a/b', 'a.jpg'], ['pack', '../a.jpg'], ['pack', '.a.jpg'], ['pack', 'a.svg'], ['', 'a.jpg']])
    assert.equal(packReferenceKey(task, name), null);
  assert.equal(packReferencePrefix('denza-z'), 'media/pack-references/denza-z/');
  assert.equal(packReferencePrefix('../x'), null);
  assert.ok(isReferenceKey('media/pack-references/denza-z/01.jpg'));
  assert.ok(!isReferenceKey('media/pack-references/denza-z/sub/01.jpg'));
});

test('reference puts share the COS_MEDIA_ACCESS_CONTROLLED gate and only accept reference keys', async () => {
  const off = fakeRequest(), offLog = logger();
  const closed = mirrorWith(CREDS, { request: off.request, log: offLog.log });
  closed.put({ key: REF, body: Buffer.from('x') });
  await closed.settled();
  assert.equal(off.puts.length, 0);
  assert.ok(offLog.lines.warn.some((line) => line.includes('COS_MEDIA_ACCESS_CONTROLLED=1')));

  const on = fakeRequest(), onLog = logger();
  const open = mirrorWith(GATED, { request: on.request, log: onLog.log });
  open.put({ key: REF, body: Buffer.from('jpeg') });
  open.put({ key: 'media/pack-references/pack/01-构图.png', body: Buffer.from('png') });
  open.put({ key: 'media/private/r-1.jpg', body: Buffer.from('no') });
  open.put({ key: '../etc/passwd', body: Buffer.from('no') });
  await open.settled();
  assert.deepEqual(on.puts.map((put) => put.path), [`/${REF}`, '/media/pack-references/pack/01-%E6%9E%84%E5%9B%BE.png']);
  assert.deepEqual(on.puts.map((put) => put.headers['Content-Type']), ['image/jpeg', 'image/png']);
});

test('purging reference keys deletes each key and refreshes exactly those URLs, never a directory', async () => {
  const { lines, log } = logger();
  const { fetch, calls } = fakeFetch();
  const mirror = mirrorWith(CREDS, { fetch, log });
  mirror.purgeKeys([REF, REF, 'media/pack-references/pack/01-构图.png', 'media/up-abcd1234/first.jpg', 'media/references/']);
  await mirror.settled();
  assert.equal(calls.filter((call) => call.method === 'GET').length, 0, 'known keys need no listing');
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname),
    [`/${REF}`, '/media/pack-references/pack/01-%E6%9E%84%E5%9B%BE.png']);
  const cdn = calls.filter((call) => call.url === 'https://cdn.tencentcloudapi.com/');
  assert.equal(cdn.length, 1);
  assert.equal(cdn[0].headers['X-TC-Action'], 'PurgeUrlsCache');
  assert.deepEqual(JSON.parse(cdn[0].body), { Urls: [`https://media.arenaofbias.icu/${REF}`, 'https://media.arenaofbias.icu/media/pack-references/pack/01-%E6%9E%84%E5%9B%BE.png'] });
  assert.ok(JSON.parse(cdn[0].body).Urls.every((url) => !url.endsWith('/')));
  assert.deepEqual(lines.warn, []);
});

test('a pack question purge lists only its prefix; CDN failures and COS_DELETE_ON_REMOVE=0 only log or skip', async () => {
  const { lines, log } = logger();
  const { fetch, calls } = fakeFetch({
    pages: ['<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>media/pack-references/denza-z/01.jpg</Key><Size>1</Size></Contents><Contents><Key>media/pack-references/denza-zz/01.jpg</Key><Size>1</Size></Contents></ListBucketResult>'],
    cdn: () => ({ Response: { Error: { Code: 'InternalError', Message: 'boom' } } }),
  });
  const mirror = mirrorWith(CREDS, { fetch, log });
  mirror.purgePackReferences('denza-z');
  mirror.purgePackReferences('../x');
  await mirror.settled();
  assert.equal(new URL(calls[0].url).searchParams.get('prefix'), 'media/pack-references/denza-z/');
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname), ['/media/pack-references/denza-z/01.jpg']);
  assert.ok(lines.warn.some((line) => line.startsWith('CDN purge failed 1 urls: InternalError')));

  const off = fakeFetch();
  const disabled = mirrorWith({ ...CREDS, COS_DELETE_ON_REMOVE: '0' }, { fetch: off.fetch, log: logger().log });
  disabled.purgeKeys([REF]); disabled.purgePackReferences('denza-z');
  await disabled.settled();
  assert.equal(off.calls.length, 0);
});

// Question lifecycle against the real references module with a recording mirror.
function lifecycle(run) {
  const root = mkdtempSync(join(tmpdir(), 'cos-references-')), db = openDatabase(':memory:');
  const seen = { puts: [], purged: [], packs: [] };
  installCosMirror({ put: (spec) => seen.puts.push({ key: spec.key, bytes: readFileSync(spec.file).length }), purgeKeys: (keys) => seen.purged.push(...keys),
    purgePackReferences: (taskId) => seen.packs.push(taskId), purge() {}, settled: async () => {} });
  try {
    for (const user of [owner, admin]) db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.id, user.role, 'salt', 'hash', 1);
    const references = createReferences({ db, config: { dataDir: root }, limits: {} });
    const questions = createQuestions(db, { references });
    references.bindQuestions(questions);
    const upload = (user, name = '01-图.png') => ({ id: references.upload(user, 'a.png', referencePng).id, name });
    run({ root, db, questions, upload, seen });
  } finally { resetCosMirror(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('drafts and pending questions stay out of COS; approval puts, edits swap, rejection and deletion purge', () => lifecycle(({ questions, upload, seen }) => {
  const draft = upload(owner);
  const first = upload(owner);
  const created = questions.create(owner, { ...body, references: [first] });
  assert.deepEqual(seen, { puts: [], purged: [], packs: [] }, 'uploads, drafts and pending questions are never written');
  const key = (id) => `media/references/${id}.png`;

  questions.review(admin, created.id, { status: 'approved' });
  assert.deepEqual(seen.puts.map((put) => put.key), [key(first.id)]);
  assert.equal(seen.puts[0].bytes, referencePng.length);

  const second = upload(admin, '02-图.png');
  questions.edit(admin, created.id, { references: [second] });
  assert.deepEqual(seen.puts.map((put) => put.key), [key(first.id), key(second.id)]);
  assert.deepEqual(seen.purged, [key(first.id)]);
  questions.edit(admin, created.id, { title: 'Renamed' });
  assert.equal(seen.puts.length, 2, 'unchanged images are not put again');

  questions.review(admin, created.id, { status: 'rejected', reason: 'No' });
  assert.deepEqual(seen.purged, [key(first.id), key(second.id)]);
  questions.edit(admin, created.id, { references: [{ id: second.id, name: second.name }, upload(admin, '03-图.png')] });
  assert.equal(seen.puts.length, 2, 'editing a rejected question writes nothing');

  questions.review(admin, created.id, { status: 'approved' });
  assert.equal(seen.puts.length, 4);
  const live = questions.get(created.id).references.map((ref) => ref.src);
  questions.remove(admin, created.id);
  assert.deepEqual(seen.purged.slice(2), live);
  assert.ok(!seen.puts.some((put) => put.key === key(draft.id)) && !seen.purged.includes(key(draft.id)));
}));

test('a pending question deleted by its author purges nothing', () => lifecycle(({ questions, upload, seen }) => {
  const created = questions.create(owner, { ...body, references: [upload(owner)] });
  questions.remove(owner, created.id);
  assert.deepEqual(seen, { puts: [], purged: [], packs: [] });
}));

test('datapack questions purge their prefix when rejected or deleted and remirror from the snapshot when approved again', () => lifecycle(({ root, questions, seen }) => {
  mkdirSync(join(root, 'pack', 'references'), { recursive: true });
  writeFileSync(join(root, 'pack', 'references', 'one.png'), referencePng);
  const task = { ...body, id: 'denza-z', tags: [], acceptsUploads: true, references: [{ name: '01-构图.png', src: 'references/one.png' }] };
  const snapshot = { root: join(root, 'pack'), task: (id) => id === task.id ? task : null, tasks: () => [task], works: () => [] };
  questions.bindCatalog({ snapshot: () => snapshot, withSnapshot: (read) => read() });
  questions.review(admin, 'denza-z', { status: 'approved' });
  assert.deepEqual(seen, { puts: [], purged: [], packs: [] }, 'already public');
  questions.review(admin, 'denza-z', { status: 'rejected', reason: 'No' });
  assert.deepEqual(seen.packs, ['denza-z']);
  questions.review(admin, 'denza-z', { status: 'approved' });
  assert.deepEqual(seen.puts, [{ key: 'media/pack-references/denza-z/01-构图.png', bytes: referencePng.length }]);
  questions.remove(admin, 'denza-z');
  assert.deepEqual(seen.packs, ['denza-z', 'denza-z']);
}));
