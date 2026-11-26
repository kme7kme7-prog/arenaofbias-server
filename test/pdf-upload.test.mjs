import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createCapturer } from '../server/capture.mjs';
import { limits } from '../server/config.mjs';
import { MIGRATIONS, openDatabase, transaction } from '../server/db.mjs';
import { inspectUpload } from '../server/inspect.mjs';
import { renderPdfUpload, validatePdfBuffer } from '../server/pdf.mjs';
import { canonicalPlan, planDigest } from '../tools/batch-upload/plan.mjs';
import { verifiedUser } from './helpers/email.mjs';

function makePdf({ pages = 2, mediaBox = '[0 0 612 792]', encrypt = '', metadata = '', omitPagesDict = false } = {}) {
  const body = [
    '%PDF-1.7',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    omitPagesDict ? '' : `2 0 obj << /Type /Pages /Kids [3 0 R] /Count ${pages} >> endobj`,
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} >> endobj`,
    metadata,
    encrypt,
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].filter(Boolean).join('\n');
  return Buffer.from(body, 'latin1');
}

test('validatePdfBuffer and renderPdfUpload enforce strict PDF validation and blind-safe viewer output', () => {
  assert.throws(() => validatePdfBuffer(Buffer.alloc(0), 'empty.pdf'), { status: 400 });
  assert.throws(() => validatePdfBuffer(Buffer.from('<!doctype html><h1>hi</h1>'), 'page.html'), {
    status: 400, message: 'PDF 题目不接受 HTML 文件，请上传单个 .pdf 文件',
  });
  assert.throws(() => validatePdfBuffer(Buffer.from('<html><body>fake</body></html>'), 'trick.pdf'), {
    status: 400, message: 'PDF 题目不接受 HTML 文件，请上传单个 .pdf 文件',
  });
  const zipHead = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.throws(() => validatePdfBuffer(zipHead, 'archive.pdf'), { status: 400, message: 'PDF 题目只接受单个 .pdf 文件' });
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => validatePdfBuffer(pngHead, 'pic.pdf'), { status: 400, message: 'PDF 题目只接受单个 .pdf 文件' });
  assert.throws(() => validatePdfBuffer(makePdf(), 'doc.txt'), { status: 400, message: 'PDF 题目只接受单个 .pdf 文件' });
  assert.throws(() => validatePdfBuffer(Buffer.from('not a pdf %%EOF'), 'bad.pdf'), { status: 400 });
  assert.throws(() => validatePdfBuffer(Buffer.from('%PDF-1.7\nno trailer'), 'trunc.pdf'), { status: 400 });
  assert.throws(() => validatePdfBuffer(makePdf({ encrypt: '4 0 obj << /Filter /Standard >> endobj\n/Encrypt 4 0 R' }), 'enc.pdf'), { status: 400 });

  const portraitPdf = makePdf({ pages: 5, mediaBox: '[0 0 595 842]', metadata: '/Author (SecretAuthor) /Title (LeakTitle)' });
  const portraitInfo = validatePdfBuffer(portraitPdf, 'secret-model-name.pdf');
  assert.equal(portraitInfo.version, '1.7');
  assert.equal(portraitInfo.pageCount, 5);
  assert.equal(portraitInfo.orientation, 'portrait');

  const landscapePdf = makePdf({ pages: 1, mediaBox: '[0 0 1920 1080]', omitPagesDict: true });
  const rendered = renderPdfUpload(landscapePdf, 'secret-slide-file.pdf');
  assert.equal(rendered.orientation, 'landscape');
  assert.equal(rendered.pageCount, 1);
  assert.ok(rendered.files.has('index.html'));
  assert.ok(rendered.files.has('document.pdf'));

  const html = rendered.files.get('index.html').toString('utf8');
  assert.equal(html.includes('secret-slide-file'), false);
  assert.equal(html.includes('SecretAuthor'), false);
  assert.ok(html.includes("dataset.pdfViewer = '1'"));
  assert.ok(html.includes("dataset.pdfReady = '1'"));
  assert.ok(html.includes("aob:work-ready"));
  assert.ok(html.includes('sp-arena-theme'));
  assert.ok(html.includes('pdfjs-dist@4.10.38'));
  assert.ok(html.includes('unpkg.com/pdfjs-dist@4.10.38'));
  assert.ok(html.includes('cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38'));
  assert.ok(html.includes('globalThis.pdfjsWorker'));
  assert.ok(html.includes('文本解析'));
  assert.ok(html.includes('getTextContent'));
});

test('inspectUpload enforces PDF format isolation across templates', () => {
  const pdf = makePdf({ pages: 3 });
  const inspected = inspectUpload(pdf, 'report.pdf', { limits, cdn: ['cdn.jsdelivr.net'], template: 'pdf' });
  assert.equal(inspected.kind, 'pdf');
  assert.equal(inspected.checks.find((c) => c.id === 'format')?.state, 'ok');
  assert.equal(inspected.checks.some((c) => c.id === 'readme'), false);

  for (const tpl of [null, 'static', 'vite', 'text', 'audio']) {
    assert.throws(
      () => inspectUpload(pdf, tpl === 'audio' ? 'x.mp3' : 'doc.pdf', { limits, cdn: [], template: tpl }),
      { status: 400, message: '该题不接受 PDF 文件，请上传符合要求的文件格式' },
    );
  }
  assert.throws(
    () => inspectUpload(Buffer.from('<!doctype html><h1>Hi</h1>'), 'page.html', { limits, cdn: [], template: 'pdf' }),
    { status: 400, message: 'PDF 题目不接受 HTML 文件，请上传单个 .pdf 文件' },
  );
});

test('v62 migration converts Word/PPT/Excel subcategories to PDF idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-v62-'));
  const file = join(root, 'platform.db');
  try {
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys=ON');
    for (const [i, step] of MIGRATIONS.slice(0, 61).entries()) {
      if (step.foreignKeysOff) old.exec('PRAGMA foreign_keys=OFF');
      transaction(old, () => { typeof step === 'function' ? step(old) : old.exec(step); old.exec(`PRAGMA user_version=${i + 1}`); });
      old.exec('PRAGMA foreign_keys=ON');
    }
    const ins = old.prepare('INSERT INTO task_subcategories (task_id, subcategory, updated_by, updated_at) VALUES (?, ?, ?, ?)');
    ins.run('t1', 'Word', 'u', '2026-11-26');
    ins.run('t2', 'PPT', 'u', '2026-11-26');
    ins.run('t3', 'Excel', 'u', '2026-11-26');
    ins.run('t4', '网页', 'u', '2026-11-26');
    old.close();

    const db = openDatabase(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const read = () => Object.fromEntries(db.prepare('SELECT task_id, subcategory FROM task_subcategories ORDER BY task_id').all().map((r) => [r.task_id, r.subcategory]));
    assert.deepEqual(read(), { t1: 'PDF', t2: 'PDF', t3: 'PDF', t4: '网页' });
    MIGRATIONS.at(-1)(db);
    assert.deepEqual(read(), { t1: 'PDF', t2: 'PDF', t3: 'PDF', t4: '网页' });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PDF question lifecycle, public catalog fallback, subcategory toggle, inbox, and batch enforcement', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-e2e-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'data.json'), JSON.stringify({
    models: [{ id: 'm1', name: 'M1', vendor: 'Test' }],
    tasks: [
      { id: 'pack-web', title: 'Pack Web', summary: 'S', prompt: 'P', category: '静态网页', domains: ['计算机技术'], results: [] },
    ],
  }));
  const origin = 'https://gallery.example.test';
  const platform = createPlatform({
    config: {
      dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost',
      siteOrigins: [origin], admins: [], cdn: ['cdn.jsdelivr.net'], capture: false, secureCookies: false,
      moderation: { enabled: false }, readLimits: { api: 1000, catalog: 1000 }, leaderboardWarmup: false,
      batch: { enabled: true, diskFloorBytes: 0, diskFloorRatio: 0, inodeFloor: 0, statfs: () => ({ bytes: 1e11, capacity: 1e11, inodes: 1e7 }) },
    },
    limits,
  });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  });

  const admin = platform.auth.createAdmin('root', 'secret pass');
  platform.auth.bindEmail(admin.id, 'root@example.test');
  const member = await verifiedUser(platform.auth, 'member');
  platform.auth.promote(member.id, 1);
  const mod = await verifiedUser(platform.auth, 'mod');
  platform.auth.setRole(admin, mod.id, 'moderator');
  platform.auth.bindEmail(mod.id, 'mod@example.test');
  const cookies = {};
  for (const [k, u] of Object.entries({ admin, member, mod })) {
    platform.auth.startSession({ setHeader: (_n, v) => { cookies[k] = v.split(';')[0]; } }, u.id);
  }
  const call = async (path, { who, method = 'GET', body, rawBody, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        origin,
        'accept-encoding': 'identity',
        ...(who ? { cookie: cookies[who] } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, headers: res.headers, data };
  };

  const pdfBytes = makePdf({ pages: 2 });

  // 1. Create a PDF question with a PDF draft; rejecting mismatched HTML draft.
  const htmlDraft = await call('/api/drafts?task=__new__&name=page.html', {
    who: 'member', method: 'POST', rawBody: Buffer.from('<!doctype html><h1>HTML</h1>'),
  });
  assert.equal(htmlDraft.status, 200);
  const mismatchedCreate = await call('/api/questions', {
    who: 'member',
    method: 'POST',
    body: {
      title: 'PDF Report Task', summary: 'Summary', prompt: 'Export PDF',
      category: '静态网页', subcategory: 'PDF', domains: ['计算机技术'], templates: ['pdf'],
      draftId: htmlDraft.data.draft.id, confirmed: true,
      work: { modelId: 'm1', effort: 'High', providerId: 'official', harnessOther: 'CLI', generationMode: 'single-turn', humanIntervention: 'none' },
    },
  });
  assert.equal(mismatchedCreate.status, 400);

  const pdfDraft = await call('/api/drafts?task=__new__&name=report.pdf&template=pdf', {
    who: 'member', method: 'POST', rawBody: pdfBytes,
  });
  assert.equal(pdfDraft.status, 200);
  const created = await call('/api/questions', {
    who: 'member',
    method: 'POST',
    body: {
      title: 'PDF Report Task', summary: 'Summary', prompt: 'Export PDF',
      category: '静态网页', subcategory: 'PDF', domains: ['计算机技术'],
      draftId: pdfDraft.data.draft.id, confirmed: true,
      work: { modelId: 'm1', effort: 'High', providerId: 'official', harnessOther: 'CLI', generationMode: 'single-turn', humanIntervention: 'none' },
    },
  });
  assert.equal(created.status, 200);
  const qId = created.data.question.id;
  assert.deepEqual(created.data.question.templates, ['pdf']);

  // Approve question so it appears in catalogs
  await call(`/api/questions/${qId}/moderation`, { who: 'admin', method: 'POST', body: { status: 'approved', reason: 'ok' } });

  // 2. Public catalog reports templates: ['static'] for PDF question; guided catalog reports ['pdf'] + subcategory 'PDF'
  const pubCat = await call('/api/catalog');
  assert.equal(pubCat.status, 200);
  assert.deepEqual(pubCat.data.questions.find((q) => q.id === qId).templates, ['static']);

  const guidedCat = await call('/api/catalog?guided=1');
  assert.equal(guidedCat.status, 200);
  const guidedQ = guidedCat.data.questions.find((q) => q.id === qId);
  assert.equal(guidedQ.subcategory, 'PDF');
  assert.deepEqual(guidedQ.templates, ['pdf']);

  // 3. Switching subcategory on a question WITH works fails 409; on empty DB question syncs templates
  const switchWithWork = await call(`/api/admin/tasks/${qId}/subcategory`, {
    who: 'admin', method: 'PUT', body: { subcategory: '网页' },
  });
  assert.equal(switchWithWork.status, 409);

  const emptyQ = await call('/api/admin/questions', {
    who: 'admin',
    method: 'POST',
    body: {
      title: 'Empty Web Task', summary: 'Summary', prompt: 'Prompt',
      category: '静态网页', domains: ['计算机技术'], templates: ['static'],
    },
  });
  assert.equal(emptyQ.status, 200);
  const emptyId = emptyQ.data.question.id;
  await call(`/api/questions/${emptyId}/moderation`, { who: 'admin', method: 'POST', body: { status: 'approved', reason: 'ok' } });

  const toPdf = await call(`/api/admin/tasks/${emptyId}/subcategory`, {
    who: 'admin', method: 'PUT', body: { subcategory: 'PDF' },
  });
  assert.equal(toPdf.status, 200);
  assert.deepEqual(JSON.parse(platform.db.prepare('SELECT templates FROM questions WHERE id = ?').get(emptyId).templates), ['pdf']);

  // 4. Inbox PDF upload, preview, raw file MIME, and register
  const inboxUp = await call('/api/admin/inbox?name=' + encodeURIComponent('「季度报告，TestModel.pdf」'), {
    who: 'admin', method: 'POST', rawBody: pdfBytes,
  });
  assert.equal(inboxUp.status, 200);
  const inboxList = await call('/api/admin/inbox', { who: 'admin' });
  assert.equal(inboxList.data.entries.length, 1);
  const entry = inboxList.data.entries[0];
  assert.equal(entry.kind, 'pdf');
  assert.ok(entry.preview.endsWith('/index.html'));

  const previewRes = await call(entry.preview, { who: 'admin' });
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.data, /pdfjs-dist@4\.10\.38/);

  const rawPdfRes = await fetch(`${base}/admin/inbox/${entry.id}/file`, { headers: { cookie: cookies.admin } });
  assert.equal(rawPdfRes.status, 200);
  assert.equal(rawPdfRes.headers.get('content-type'), 'application/pdf');

  const reg = await call('/api/admin/inbox/register', {
    who: 'admin',
    method: 'POST',
    body: { id: entry.id, task: emptyId, modelId: 'm1', effort: 'High', providerId: 'official', harnessOther: 'CLI' },
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.work.task, emptyId);

  // 5. Batch upload enforces PDF for PDF tasks and rejects PDF on non-PDF tasks
  const pdfRendered = renderPdfUpload(pdfBytes, 'batch.pdf');
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  const planFiles = [...pdfRendered.files].map(([path, data]) => ({ path, size: data.length, sha256: sha(data) }));
  const batchInput = {
    batch: 'batch-pdf-1',
    clientName: 'test-cli',
    works: [{
      key: 'w1', task: qId, title: 'Batch PDF', modelId: 'm1', effort: 'High', providerId: 'official',
      harnessOther: 'CLI', generationMode: 'single-turn', humanIntervention: 'none',
      compressedBytes: pdfBytes.length, files: planFiles,
    }],
  };
  const { digest } = planDigest(batchInput);
  const regBatch = await call('/api/batch/device', { method: 'POST', body: { ...canonicalPlan(batchInput), payloadDigest: digest } });
  assert.equal(regBatch.status, 200);
  const appRes = await call('/api/batch/batch-pdf-1/approve', {
    who: 'mod', method: 'POST', body: { userCode: regBatch.data.user_code, payloadDigest: digest },
  });
  assert.equal(appRes.status, 200);
  const poll = await call('/api/batch/device/poll', { method: 'POST', body: { device_code: regBatch.data.device_code } });
  assert.equal(poll.status, 200);
  const grantToken = poll.data.token;

  // Uploading HTML to PDF batch work fails 400
  const badBatchUp = await call('/api/batch/batch-pdf-1/works/w1', {
    method: 'PUT',
    rawBody: Buffer.from('<!doctype html><h1>not pdf</h1>'.padEnd(pdfBytes.length, ' ')),
    headers: { authorization: `Bearer ${grantToken}`, 'idempotency-key': 'w1', 'content-length': String(pdfBytes.length) },
  });
  assert.equal(badBatchUp.status, 400);

  // Uploading valid PDF succeeds 201
  const okBatchUp = await call('/api/batch/batch-pdf-1/works/w1', {
    method: 'PUT',
    rawBody: pdfBytes,
    headers: { authorization: `Bearer ${grantToken}`, 'idempotency-key': 'w1', 'content-length': String(pdfBytes.length) },
  });
  assert.equal(okBatchUp.status, 201);

  // Uploading PDF to a non-PDF batch task fails 400
  const nonPdfInput = {
    batch: 'batch-nonpdf-1',
    clientName: 'test-cli',
    works: [{
      key: 'w1', task: 'pack-web', title: 'Bad PDF', modelId: 'm1', effort: 'High', providerId: 'official',
      harnessOther: 'CLI', generationMode: 'single-turn', humanIntervention: 'none',
      compressedBytes: pdfBytes.length, files: [{ path: 'index.html', size: pdfBytes.length, sha256: sha(pdfBytes) }],
    }],
  };
  const nonPdfDigest = planDigest(nonPdfInput).digest;
  const regNonPdf = await call('/api/batch/device', { method: 'POST', body: { ...canonicalPlan(nonPdfInput), payloadDigest: nonPdfDigest } });
  assert.equal(regNonPdf.status, 200);
  await call('/api/batch/batch-nonpdf-1/approve', {
    who: 'mod', method: 'POST', body: { userCode: regNonPdf.data.user_code, payloadDigest: nonPdfDigest },
  });
  const pollNonPdf = await call('/api/batch/device/poll', { method: 'POST', body: { device_code: regNonPdf.data.device_code } });
  const badNonPdfUp = await call('/api/batch/batch-nonpdf-1/works/w1', {
    method: 'PUT',
    rawBody: pdfBytes,
    headers: { authorization: `Bearer ${pollNonPdf.data.token}`, 'idempotency-key': 'w1', 'content-length': String(pdfBytes.length) },
  });
  assert.equal(badNonPdfUp.status, 400);
});

test('capturer waits for pdfReady on PDF viewer pages and degrades gracefully on timeout', async (t) => {
  const mediaDir = mkdtempSync(join(tmpdir(), 'capture-pdf-'));
  let waitedForPdf = false;
  let shotsTaken = 0;
  const browser = {
    on() {},
    close: async () => {},
    newContext: async () => ({
      route: async () => {},
      routeWebSocket: async () => {},
      addInitScript: async () => {},
      close: async () => {},
      newPage: async () => ({
        goto: async () => ({ ok: () => true }),
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn) => {
          if (String(fn).includes('pdfViewer')) return true;
          return false;
        },
        waitForFunction: async (fn) => {
          if (String(fn).includes('pdfReady')) {
            waitedForPdf = true;
            throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
          }
        },
        screenshot: async () => { shotsTaken++; },
        mouse: { move: async () => {}, wheel: async () => {}, click: async () => {} },
        frames: () => [{ locator: () => ({ innerText: async () => 'pdf text' }), evaluate: async () => false }],
      }),
    }),
  };
  const capturer = createCapturer({
    config: { capture: true, cdn: [] },
    library: { mediaDir, publicContent: () => true, originOf: () => 'http://work.localhost', hasDirectory: () => true, setCaptures: () => {} },
    loadChromium: async () => ({ launch: async () => browser }),
  });
  t.after(async () => { await capturer.close(); rmSync(mediaDir, { recursive: true, force: true }); });

  const result = await capturer.enqueue({ id: 'pdf-work', contentKey: 'w0' }, { late: false });
  assert.equal(waitedForPdf, true);
  assert.equal(shotsTaken, 2);
  assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
});
