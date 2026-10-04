import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { verifiedUser } from './helpers/email.mjs';
import { referenceJpeg, referencePng, referenceWebp } from './helpers/reference-images.mjs';

const png = referencePng;
const galleryOrigin = 'https://gallery.example.test';
const questionBody = { title: 'Reference question', summary: 'Compare the supplied reference', prompt: 'Build a page using this reference.',
  category: '静态网页', domains: ['数学'], templates: ['static'], tags: [] };

describe('reference image HTTP contract', () => {
  let root, platform, site, base;
  const cookies = new Map();
  async function call(who, method, path, body, extraHeaders = {}, raw = false) {
    const headers = { origin: galleryOrigin, ...extraHeaders };
    if (cookies.has(who)) headers.cookie = cookies.get(who);
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers,
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie');
    if (cookie) cookies.set(who, cookie.split(';')[0]);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, buffer,
      data: response.headers.get('content-type')?.includes('application/json') && buffer.length ? JSON.parse(buffer) : null };
  }
  async function upload(who, name = '参考图.png', buffer = png, headers = {}) {
    return call(who, 'POST', `/api/references?name=${encodeURIComponent(name)}`, buffer,
      { 'content-type': 'image/png', ...headers }, true);
  }
  async function uploaded(who, name = '参考图.png') {
    const result = await upload(who, name);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.reference;
  }
  const mediaPath = (reference) => '/' + reference.src;
  const refs = (reference, name = '01-参考.png', caption = '') => [{ id: reference.id, name, caption }];
  const moderate = (id, status, reason = '') => call('root', 'POST', `/api/questions/${id}/moderation`, { status, reason });
  const create = (who, references, extra = {}) => call(who, 'POST', '/api/questions', { ...questionBody, references, ...extra });
  const stored = (id) => platform.db.prepare('SELECT * FROM reference_uploads WHERE id = ?').get(id);
  const fileOf = (reference) => join(root, 'data', 'references', reference.src.split('/').at(-1));

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'references-http-'));
    const dist = join(root, 'dist'); mkdirSync(dist);
    writeFileSync(join(dist, 'data.json'), JSON.stringify({ title: 'Synthetic reference test',
      models: [{ id: 'model-a', name: 'Model A', vendor: 'Test' }], tasks: [
        { id: 'one', title: 'One', summary: 'Synthetic package question', prompt: 'Original packaged prompt.',
          category: '静态网页', templates: ['static'], domains: ['数学'], results: [] },
      ] }));
    writeFileSync(join(dist, '.datapack-source.json'), JSON.stringify({ source: 'github', repo: 'synthetic/example', commit: 'a'.repeat(40) }));
    const config = { dist, dataDir: join(root, 'data'), contentTemplate: 'https://{token}.content.example.test',
      siteOrigins: [galleryOrigin], admins: ['root'], cdn: [], capture: false, secureCookies: false,
      trustProxy: false, moderation: { enabled: false } };
    platform = createPlatform({ config, limits: { ...limits, pendingPerUser: 30, referenceCount: 8, referenceBytes: 5 * 1024 * 1024 } });
    site = createServer(platform.handleSite).listen(0, '127.0.0.1');
    await new Promise(resolve => site.once('listening', resolve));
    base = `http://127.0.0.1:${site.address().port}`;
    for (const name of ['author', 'other', 'errors', 'quota', 'sample', 'moderator']) {
      await verifiedUser(platform.auth, name);
      if (name === 'moderator') platform.auth.promote(name, 'moderator');
      const login = await call(name, 'POST', '/api/auth/login', { name, password: 'correct horse' });
      assert.equal(login.status, 200, JSON.stringify(login.data));
    }
    await platform.auth.register('unbound', 'correct horse');
    assert.equal((await call('unbound', 'POST', '/api/auth/login', { name: 'unbound', password: 'correct horse' })).status, 200);
    const admin = platform.auth.createAdmin('root', 'correct horse');
    platform.auth.bindEmail(admin.id, 'root@example.test');
    assert.equal((await call('root', 'POST', '/api/auth/login', { name: 'root', password: 'correct horse' })).status, 200);
  });
  after(async () => {
    site?.closeAllConnections();
    if (site) await new Promise(resolve => site.close(resolve));
    await platform?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('upload requires a bound account, validates the original image and signals stale datapacks', async () => {
    assert.equal((await upload('guest')).status, 401);
    assert.equal((await upload('unbound')).status, 403);
    const beforeRows = platform.db.prepare('SELECT count(*) AS n FROM reference_uploads').get().n;
    for (const [name, buffer] of [
      ['image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['image.png.html', png], ['image.jpg', png], ['image.png', Buffer.from('<html>not an image</html>')],
    ]) assert.equal((await upload('errors', name, buffer)).status, 400, name);
    assert.equal((await upload('errors', 'huge.png', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM reference_uploads').get().n, beforeRows);
    const result = await upload('errors', '原始参考.png', png, { 'x-datapack-version': 'b'.repeat(40) });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.headers.get('x-datapack-stale'), '1');
    const reference = result.data.reference;
    assert.equal(reference.name, '原始参考.png');
    assert.equal(reference.bytes, png.length);
    assert.equal(reference.width, 3); assert.equal(reference.height, 2);
    assert.match(reference.src, /^media\/references\/[^/]+\.png$/);
    assert.ok(stored(reference.id));
    const image = await call('errors', 'GET', mediaPath(reference));
    assert.deepEqual(image.buffer, png);
    assert.ok(!JSON.stringify(reference).includes(root));
    for (const [name, buffer, type, extension] of [
      ['参考.jpeg', referenceJpeg, 'image/jpeg', 'jpg'], ['参考.webp', referenceWebp, 'image/webp', 'webp'],
    ]) {
      const result = await upload('errors', name, buffer, { 'content-type': type });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.ok(result.data.reference.src.endsWith(`.${extension}`));
      const image = await call('errors', 'GET', mediaPath(result.data.reference));
      assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), type);
      assert.equal(image.buffer.length, result.data.reference.bytes);
      assert.equal(result.data.reference.width, 3); assert.equal(result.data.reference.height, 2);
    }
    const preflight = await call('guest', 'OPTIONS', '/api/references', undefined,
      { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-datapack-version' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), galleryOrigin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    platform.db.prepare('UPDATE reference_uploads SET created_at = ? WHERE id = ?').run(Date.now() - limits.draftTtl - 1, reference.id);
    assert.equal((await call('errors', 'GET', mediaPath(reference))).status, 404);
    assert.equal(platform.references.cleanup(), 1);
    assert.equal(stored(reference.id), undefined); assert.equal(existsSync(fileOf(reference)), false);
  });

  test('unpublished media allows its author and staff, with credentialed CORS and HEAD', async () => {
    const reference = await uploaded('author', '私有参考.png');
    const path = mediaPath(reference);
    for (const who of ['guest', 'other']) {
      assert.equal((await call(who, 'GET', path)).status, 404);
      assert.equal((await call(who, 'HEAD', path)).status, 404);
    }
    for (const who of ['author', 'root', 'moderator']) {
      const image = await call(who, 'GET', path);
      assert.equal(image.status, 200);
      assert.deepEqual(image.buffer, png);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal(image.headers.get('access-control-allow-origin'), galleryOrigin);
      assert.equal(image.headers.get('access-control-allow-credentials'), 'true');
      assert.match(image.headers.get('vary'), /Cookie/i);
      assert.match(image.headers.get('content-disposition'), /inline;.*filename\*=UTF-8''/);
      assert.ok(image.headers.get('content-disposition').includes(encodeURIComponent(reference.name)));
    }
    const head = await call('author', 'HEAD', path);
    assert.equal(head.status, 200); assert.equal(head.buffer.length, 0);
    assert.equal(Number(head.headers.get('content-length')), png.length);
    const preflight = await call('guest', 'OPTIONS', path, undefined, { 'access-control-request-method': 'GET' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), galleryOrigin);
    const untrusted = await call('author', 'GET', path, undefined, { origin: 'https://untrusted.example.test' });
    assert.equal(untrusted.status, 200); assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
    assert.equal((await call('author', 'GET', path.replace(/\.png$/, '.jpg'))).status, 404);
  });

  test('question references appear in author, admin and public DTOs, then become private on rejection and disappear on deletion', async () => {
    const reference = await uploaded('author', '正面.png');
    const created = await create('author', refs(reference, '01-正面参考.png', '保留边缘形状'), { referenceCredit: '作者提供参考' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const question = created.data.question;
    assert.equal(question.references.length, 1);
    assert.equal(question.references[0].id, reference.id);
    assert.equal(question.references[0].name, '01-正面参考.png');
    assert.equal(question.references[0].caption, '保留边缘形状');
    assert.equal(question.references[0].src, reference.src);
    assert.equal(question.referenceCredit, '作者提供参考');
    const owner = (await call('author', 'GET', '/api/me')).data.questions.find(item => item.id === question.id);
    const admin = (await call('root', 'GET', '/api/admin/questions')).data.questions.find(item => item.id === question.id);
    const review = await call('root', 'GET', '/api/review');
    assert.equal(review.status, 200, JSON.stringify(review.data));
    const reviewing = review.data.questions.find(item => item.id === question.id);
    for (const dto of [owner, admin, reviewing]) {
      assert.deepEqual(dto.references, question.references);
      assert.equal(dto.referenceCredit, question.referenceCredit);
    }
    const moderatorReview = await call('moderator', 'GET', '/api/review');
    assert.equal(moderatorReview.status, 200, JSON.stringify(moderatorReview.data));
    assert.deepEqual(moderatorReview.data.questions, []);
    assert.ok(!(await call('guest', 'GET', '/api/bootstrap')).data.questions.some(item => item.id === question.id));
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    const publicQuestion = (await call('guest', 'GET', '/api/bootstrap')).data.questions.find(item => item.id === question.id);
    assert.deepEqual(publicQuestion.references, question.references);
    assert.equal(publicQuestion.referenceCredit, question.referenceCredit);
    const publicImage = await call('guest', 'GET', mediaPath(reference));
    assert.equal(publicImage.status, 200); assert.deepEqual(publicImage.buffer, png);
    assert.equal(publicImage.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await moderate(question.id, 'rejected', 'Temporary rejection')).status, 200);
    assert.ok(stored(reference.id));
    assert.ok(existsSync(fileOf(reference)));
    assert.equal((await call('guest', 'GET', mediaPath(reference))).status, 404);
    assert.equal((await call('author', 'GET', mediaPath(reference))).status, 200);
    assert.equal((await call('other', 'DELETE', `/api/questions/${question.id}`)).status, 403);
    assert.equal((await call('author', 'DELETE', `/api/questions/${question.id}`)).status, 200);
    assert.equal(stored(reference.id), undefined);
    assert.equal(existsSync(fileOf(reference)), false);
    assert.equal((await call('author', 'GET', mediaPath(reference))).status, 404);
  });

  test('reference ownership, count and credit are checked before attaching uploads; only senior staff edit references', async () => {
    const references = [];
    for (let index = 0; index < 8; index++) references.push(await uploaded('quota', `参考${index}.png`));
    const submitted = references.map((reference, index) => ({ id: reference.id, name: `${String(index + 1).padStart(2, '0')}-参考${index}.png`, caption: '' }));
    const other = await uploaded('other');
    for (const overrides of [
      { references: refs(other) }, { references: [...submitted, submitted[0]] },
      { references: [submitted[0], submitted[0]] }, { references: [{ ...submitted[0], id: 'missing-reference' }] },
      { references: [{ ...submitted[0], name: '' }] }, { references: [{ ...submitted[0], caption: '字'.repeat(41) }] },
      { references: [{ ...submitted[0], name: '01-../参考.png' }] }, { referenceCredit: 'x'.repeat(81) },
    ]) {
      const result = await create('quota', submitted, overrides);
      assert.equal(result.status, 400, JSON.stringify(result.data));
    }
    const created = await create('quota', submitted, { referenceCredit: 'x'.repeat(80) });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const question = created.data.question;
    assert.equal(question.references.length, 8); assert.equal(question.referenceCredit.length, 80);
    const path = `/api/admin/questions/${question.id}/meta`;
    for (const who of ['quota', 'moderator']) assert.equal((await call(who, 'POST', path, { referenceCredit: 'Edit' })).status, 403);
    const edited = await call('root', 'POST', path, { references: [{ ...submitted[0], name: '01-改名参考.png', caption: '改后说明' }], referenceCredit: '改后来源' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.question.references[0].name, '01-改名参考.png');
    assert.equal(edited.data.question.references[0].caption, '改后说明');
    assert.equal(edited.data.question.referenceCredit, '改后来源');
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    assert.equal((await call('root', 'DELETE', `/api/questions/${question.id}`)).status, 200);
  });

  test('references work with a sample submission and public questions with works lock reference edits', async () => {
    const reference = await uploaded('sample', '样例参考.png');
    const draft = await call('sample', 'POST', '/api/drafts?task=__new__&template=static&name=sample.html',
      '<!doctype html><title>Sample</title><h1>Sample</h1>', {}, true);
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    const created = await create('sample', refs(reference), { draftId: draft.data.draft.id, confirmed: true,
      work: { title: 'Sample', modelId: 'model-a', effort: 'High', providerId: 'official', harnessOther: 'Test harness', trial: { loaded: true } } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.ok(created.data.work.id);
    const question = created.data.question;
    assert.equal(question.references[0].id, reference.id);
    assert.equal((await moderate(question.id, 'approved')).status, 200);
    const path = `/api/admin/questions/${question.id}/meta`;
    for (const body of [{ references: [] }, { references: refs(reference, '01-Changed.png') }, { referenceCredit: 'Changed credit' }]) {
      const edited = await call('root', 'POST', path, body);
      assert.equal(edited.status, 409, JSON.stringify(edited.data));
    }
    const unchanged = await call('root', 'POST', path, { references: refs(reference), referenceCredit: question.referenceCredit });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.data));
    assert.equal((await call('sample', 'DELETE', `/api/questions/${question.id}`)).status, 200);
    assert.equal(stored(reference.id), undefined);
  });

  test('catalog refresh retains title overrides while serving the latest packaged reference prompt without importing images', async () => {
    const edited = await call('root', 'POST', '/api/admin/questions/one/meta', { title: 'Edited package title' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.question.prompt, 'Original packaged prompt.');
    const filesBefore = readdirSync(join(root, 'data', 'references')).sort();
    const rowsBefore = platform.db.prepare('SELECT count(*) AS n FROM reference_uploads').get().n;
    const dist = join(root, 'dist');
    const data = JSON.parse(readFileSync(join(dist, 'data.json'), 'utf8'));
    const prompt = 'Updated packaged prompt.\n\n【参考图】\n01-构图.png：保留主体布局。';
    data.tasks[0].prompt = prompt;
    data.tasks[0].references = [{ name: '01-构图.png', src: 'references/fake.png', caption: '包内说明', width: 2, height: 3 }];
    data.tasks[0].referenceCredit = '包内来源';
    mkdirSync(join(dist, 'references'));
    writeFileSync(join(dist, 'references', 'fake.png'), png);
    writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
    writeFileSync(join(dist, '.datapack-source.json'), JSON.stringify({ source: 'github', repo: 'synthetic/example', commit: 'b'.repeat(40) }));
    const bootstrap = await call('guest', 'GET', '/api/bootstrap');
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.data));
    assert.equal(bootstrap.data.datapack, 'b'.repeat(40));
    const admin = await call('root', 'GET', '/api/admin/questions');
    assert.equal(admin.status, 200, JSON.stringify(admin.data));
    const review = await call('root', 'GET', '/api/review');
    const expectedReference = { ...data.tasks[0].references[0], src: 'media/pack-references/one/01-%E6%9E%84%E5%9B%BE.png' };
    for (const question of [bootstrap.data.questions.find(item => item.id === 'one'), admin.data.questions.find(item => item.id === 'one'),
      review.data.questions.find(item => item.id === 'one')]) {
      assert.equal(question.title, 'Edited package title');
      assert.equal(question.prompt, prompt);
      assert.deepEqual(question.references, [expectedReference]); assert.equal(question.referenceCredit, '包内来源');
    }
    const path = mediaPath(expectedReference);
    const image = await call('guest', 'GET', path);
    assert.equal(image.status, 200); assert.deepEqual(image.buffer, png);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cache-control'), 'no-cache');
    assert.equal(image.headers.get('access-control-allow-origin'), galleryOrigin);
    assert.equal((await call('guest', 'HEAD', path)).status, 200);
    assert.equal((await call('guest', 'OPTIONS', path, undefined, { 'access-control-request-method': 'GET' })).status, 204);
    assert.equal((await call('guest', 'GET', '/media/pack-references/one/not-declared.png')).status, 404);
    const resent = await call('root', 'POST', '/api/admin/questions/one/meta', {
      references: [{ name: expectedReference.name, caption: expectedReference.caption }], referenceCredit: '包内来源' });
    assert.equal(resent.status, 200, JSON.stringify(resent.data));
    assert.equal((await moderate('one', 'rejected', 'Hold packaged question')).status, 200);
    assert.equal((await call('guest', 'GET', path)).status, 404);
    assert.equal((await call('root', 'GET', path)).status, 200);
    assert.equal(platform.db.prepare('SELECT count(*) AS n FROM reference_uploads').get().n, rowsBefore);
    assert.deepEqual(readdirSync(join(root, 'data', 'references')).sort(), filesBefore);
  });
});
