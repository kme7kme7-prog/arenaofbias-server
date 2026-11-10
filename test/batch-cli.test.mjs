import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authCommand, planCommand, readLocalState, statusCommand, cancelCommand } from '../tools/batch-upload/aob-batch.mjs';
import { MAX_DARWIN_SECRET_BYTES, planCredentialCall } from '../tools/batch-upload/credentials.mjs';
import { assertVerificationUrl } from '../tools/batch-upload/http.mjs';
import { parseStrictJson } from '../tools/batch-upload/json.mjs';
import { LOCAL_LIMITS, assertBatchTotals, assertWorkBudget } from '../tools/batch-upload/limits.mjs';
import { planDigest as toolPlanDigest } from '../tools/batch-upload/plan.mjs';
import { MIN_NODE, assertZipRuntime } from '../tools/batch-upload/zip.mjs';
import { apiRequest } from '../tools/batch-upload/http.mjs';
import { planDigest as serverPlanDigest } from '../server/batch-plan.mjs';
import { batchConfig, limits } from '../server/config.mjs';
import { readTree } from '../tools/batch-upload/walk.mjs';

const cli = join(process.cwd(), 'tools/batch-upload/aob-batch.mjs');

function run(args, env = {}, timeout) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  });
}

test('the CLI rejects token and endpoint flags without echoing them', () => {
  const secret = 'super-secret-token-value';
  const result = run(['plan', '--token', secret, '--dir', '/tmp']);
  assert.equal(result.status, 2);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  const endpoint = run(['upload', '--endpoint', 'http://127.0.0.1:9', '--dir', '/tmp']);
  assert.equal(endpoint.status, 2);
  assert.equal(`${endpoint.stdout}${endpoint.stderr}`.includes('127.0.0.1'), false);
  const insecure = run(['auth', '--insecure', '--dir', '/tmp'], { AOB_TOKEN: secret });
  assert.equal(insecure.status, 2);
  assert.equal(`${insecure.stdout}${insecure.stderr}`.includes(secret), false);
});

test('local planning refuses links, hidden names, and paths outside the allow root', () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'batch-home-'));
  const allow = join(root, 'allowed');
  const batch = join(allow, 'lamp');
  const outside = join(root, 'outside');
  mkdirSync(join(batch, 'works', 'lamp-01'), { recursive: true });
  mkdirSync(join(home, '.config', 'arenaofbias'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, '.config', 'arenaofbias', 'batch-root'), `${allow}\n`);
  writeFileSync(join(batch, 'works', 'lamp-01', 'index.html'), '<!doctype html><html><body><h1>ok</h1></body></html>');
  writeFileSync(join(batch, 'manifest.json'), JSON.stringify({
    batch: 'lampcli',
    works: [{ key: 'lamp-01', task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local' }],
  }));
  const env = { HOME: home };
  const planned = run(['plan', '--dir', batch], env);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /^[a-f0-9]{64} 1\n$/);

  writeFileSync(join(batch, 'works', 'lamp-01', '.env'), 'SECRET=1');
  const hidden = run(['plan', '--dir', batch], env);
  assert.notEqual(hidden.status, 0);
  assert.equal(`${hidden.stdout}${hidden.stderr}`.includes('SECRET'), false);
  rmSync(join(batch, 'works', 'lamp-01', '.env'));

  symlinkSync(outside, join(batch, 'works', 'lamp-01', 'escape'));
  const linked = run(['plan', '--dir', batch], env);
  assert.notEqual(linked.status, 0);
  rmSync(join(batch, 'works', 'lamp-01', 'escape'));

  const hard = join(batch, 'works', 'lamp-01', 'hard.html');
  linkSync(join(batch, 'works', 'lamp-01', 'index.html'), hard);
  assert.throws(() => readTree(batch, 'works/lamp-01'), /硬链接/);
  rmSync(hard);

  const escaped = run(['plan', '--dir', outside], env);
  assert.notEqual(escaped.status, 0);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('credential storage fails closed when the OS store is missing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'batch-path-'));
  const result = run(['status', '--dir', '/tmp'], { PATH: empty });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /凭据库/);
  assert.equal(result.stdout.includes('Bearer'), false);
  rmSync(empty, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'batch-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'batch-home-'));
  const allow = join(root, 'allowed');
  const batch = join(allow, 'lamp');
  mkdirSync(join(batch, 'works', 'lamp-01'), { recursive: true });
  mkdirSync(join(home, '.config', 'arenaofbias'), { recursive: true });
  writeFileSync(join(home, '.config', 'arenaofbias', 'batch-root'), `${allow}\n`);
  writeFileSync(join(batch, 'works', 'lamp-01', 'index.html'), '<!doctype html><html><body><h1>ok</h1></body></html>');
  writeFileSync(join(batch, 'manifest.json'), JSON.stringify({
    batch: 'lampcli',
    works: [{ key: 'lamp-01', task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local' }],
  }));
  return {
    root, home, allow, batch,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('metadata refuses symlinks, hard links, and fifos before reading or truncating them', () => {
  const box = fixture();
  const env = { HOME: box.home };
  const secret = 'OUTSIDE-MANIFEST-SECRET';
  const outside = join(box.root, 'outside-manifest.json');
  writeFileSync(outside, `{"secret":"${secret}"}`);
  rmSync(join(box.batch, 'manifest.json'));
  symlinkSync(outside, join(box.batch, 'manifest.json'));
  const linked = run(['plan', '--dir', box.batch], env);
  assert.notEqual(linked.status, 0);
  assert.equal(`${linked.stdout}${linked.stderr}`.includes(secret), false);

  rmSync(join(box.batch, 'manifest.json'));
  writeFileSync(join(box.batch, 'manifest.json'), JSON.stringify({
    batch: 'lampcli',
    works: [{ key: 'lamp-01', task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local' }],
  }));
  const victim = join(box.root, 'victim.txt');
  writeFileSync(victim, 'KEEP-PLAN-SECRET');
  symlinkSync(victim, join(box.batch, 'plan.json'));
  const followed = run(['plan', '--dir', box.batch], env);
  assert.notEqual(followed.status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'KEEP-PLAN-SECRET');
  rmSync(join(box.batch, 'plan.json'));

  writeFileSync(join(box.batch, 'plan.json'), 'OLD-PLAN');
  const hard = join(box.root, 'plan-hard.json');
  linkSync(join(box.batch, 'plan.json'), hard);
  const linkedPlan = run(['plan', '--dir', box.batch], env);
  assert.notEqual(linkedPlan.status, 0);
  assert.equal(readFileSync(hard, 'utf8'), 'OLD-PLAN');
  assert.equal(readFileSync(join(box.batch, 'plan.json'), 'utf8'), 'OLD-PLAN');
  rmSync(join(box.batch, 'plan.json'));

  const fifoCreate = spawnSync('mkfifo', [join(box.batch, 'plan.json')]);
  assert.equal(fifoCreate.status, 0, fifoCreate.stderr?.toString());
  const fifo = run(['plan', '--dir', box.batch], env, 3000);
  assert.equal(fifo.status, 1);
  assert.match(fifo.stderr, /普通文件|拒绝/);
  box.cleanup();
});

test('a normal plan writes a regular plan.json and status does not need the work files', async () => {
  const box = fixture();
  const digest = await planCommand(box.batch, box.home);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const planStat = lstatSync(join(box.batch, 'plan.json'));
  assert.equal(planStat.isSymbolicLink(), false);
  assert.equal(planStat.isFile(), true);
  assert.equal(planStat.nlink, 1);
  const saved = JSON.parse(readFileSync(join(box.batch, 'plan.json'), 'utf8'));
  assert.equal(saved.payloadDigest, digest);
  assert.equal(saved.batch, 'lampcli');
  rmSync(join(box.batch, 'works'), { recursive: true, force: true });
  rmSync(join(box.batch, 'manifest.json'));
  const state = readLocalState(box.batch, box.home);
  assert.equal(state.batch, 'lampcli');
  assert.equal(state.payloadDigest, digest);
  const seen = [];
  await statusCommand(box.batch, {
    home: box.home,
    assertStore() {},
    readSecret(account) { seen.push(account); return 'aobb_token'; },
    request(method, path, options) {
      seen.push({ method, path, authorization: options.headers.authorization });
      return { status: 200, data: { works: [{ key: 'lamp-01', state: 'committed', workId: 'w1' }] } };
    },
  });
  assert.deepEqual(seen, ['grant:lampcli', { method: 'GET', path: '/api/batch/lampcli', authorization: 'Bearer aobb_token' }]);
  const cancelled = [];
  await cancelCommand(box.batch, {
    home: box.home,
    assertStore() {},
    readSecret(account) { cancelled.push(account); return 'aobb_token'; },
    request(method, path) {
      cancelled.push(`${method} ${path}`);
      return { status: 200, data: { cancelled: ['lamp-01'] } };
    },
  });
  assert.deepEqual(cancelled, ['grant:lampcli', 'POST /api/batch/lampcli/cancel']);
  box.cleanup();
});

test('duplicate and special work keys are rejected before they can be used as object keys', () => {
  const box = fixture();
  const env = { HOME: box.home };
  const manifest = (works) => writeFileSync(join(box.batch, 'manifest.json'), JSON.stringify({ batch: 'lampcli', works }));
  const base = { task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local' };
  manifest([{ key: 'lamp-01', ...base }, { key: 'lamp-01', ...base, dir: 'missing' }]);
  const duplicate = run(['plan', '--dir', box.batch], env);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /作品键重复/);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    manifest([{ ...base, key }]);
    const special = run(['plan', '--dir', box.batch], env);
    assert.notEqual(special.status, 0, key);
    assert.match(special.stderr, /作品键无效/);
  }
  writeFileSync(join(box.batch, 'manifest.json'), '{"batch":"lampcli","__proto__":{"admin":true},"works":[{"key":"lamp-01","task":"one","dir":"works/lamp-01"}]}');
  const polluted = run(['plan', '--dir', box.batch], env);
  assert.notEqual(polluted.status, 0);
  assert.match(polluted.stderr, /特殊字段名/);
  assert.equal(Object.prototype.admin, undefined);
  const sha = 'ab'.repeat(32);
  const file = { path: 'index.html', size: 1, sha256: sha };
  assert.throws(() => toolPlanDigest({ batch: 'lampcli', works: [{ key: 'lamp-01', task: 'one', compressedBytes: 1, files: [file] }, { key: 'lamp-01', task: 'one', compressedBytes: 1, files: [file] }] }), /作品键重复/);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => serverPlanDigest({ batch: 'lampcli', works: [{ key, task: 'one', compressedBytes: 1, files: [file] }] }), /作品键无效/);
  }
  assert.equal(serverPlanDigest, toolPlanDigest);
  box.cleanup();
});

test('local batch limits match the server pilot defaults and stop before a huge file is required', () => {
  const pilot = batchConfig({});
  assert.equal(LOCAL_LIMITS.maxWorks, pilot.maxWorks);
  assert.equal(LOCAL_LIMITS.maxCompressed, pilot.maxCompressed);
  assert.equal(LOCAL_LIMITS.maxExpanded, pilot.maxExpanded);
  assert.equal(LOCAL_LIMITS.maxWorkCompressed, limits.uploadBytes);
  assert.equal(LOCAL_LIMITS.maxWorkExpanded, limits.unpackedBytes);
  assert.equal(LOCAL_LIMITS.maxFileBytes, limits.fileBytes);
  assert.equal(LOCAL_LIMITS.maxFilesPerWork, limits.files);
  assert.doesNotThrow(() => assertBatchTotals({ works: 10, compressed: LOCAL_LIMITS.maxCompressed, expanded: LOCAL_LIMITS.maxExpanded }));
  assert.throws(() => assertBatchTotals({ works: 11, compressed: 0, expanded: 0 }), /一批最多 10/);
  assert.throws(() => assertBatchTotals({ works: 1, compressed: LOCAL_LIMITS.maxCompressed + 1, expanded: 0 }), /压缩体积超过上限/);
  assert.throws(() => assertBatchTotals({ works: 1, compressed: 0, expanded: LOCAL_LIMITS.maxExpanded + 1 }), /解压体积超过上限/);
  assert.doesNotThrow(() => assertWorkBudget({
    compressed: LOCAL_LIMITS.maxWorkCompressed,
    expanded: LOCAL_LIMITS.maxWorkExpanded,
    files: LOCAL_LIMITS.maxFilesPerWork,
    fileBytes: LOCAL_LIMITS.maxFileBytes,
  }));
  assert.throws(() => assertWorkBudget({ compressed: LOCAL_LIMITS.maxWorkCompressed + 1 }), /单件作品超过上传上限/);
  assert.throws(() => assertWorkBudget({ fileBytes: LOCAL_LIMITS.maxFileBytes + 1 }), /单个文件超过上限/);

  const box = fixture();
  const env = { HOME: box.home };
  const works = Array.from({ length: 11 }, (_, index) => ({
    key: `lamp-${index}`, task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local',
  }));
  writeFileSync(join(box.batch, 'manifest.json'), JSON.stringify({ batch: 'lampcli', works }));
  const tooMany = run(['plan', '--dir', box.batch], env);
  assert.match(tooMany.stderr, /一批最多 10/);
  const big = join(box.batch, 'works', 'lamp-01', 'big.bin');
  const fd = openSync(big, 'w');
  ftruncateSync(fd, LOCAL_LIMITS.maxFileBytes + 1);
  closeSync(fd);
  writeFileSync(join(box.batch, 'manifest.json'), JSON.stringify({
    batch: 'lampcli',
    works: [{ key: 'lamp-01', task: 'one', dir: 'works/lamp-01', title: '台灯', modelId: 'ma', effort: 'High', providerId: 'official', harnessOther: 'local' }],
  }));
  const tooBig = run(['plan', '--dir', box.batch], env);
  assert.match(tooBig.stderr, /单个文件超过上限/);
  assert.equal(tooBig.stdout.includes('big'), false);
  box.cleanup();
});

test('confirmation URL must stay on the fixed origin', () => {
  const page = assertVerificationUrl('/admin/batch.html#c=ABCD');
  assert.equal(page.origin, 'https://api.arenaofbias.icu');
  assert.equal(assertVerificationUrl('https://api.arenaofbias.icu/admin/batch.html#c=ABCD').href, page.href);
  for (const value of ['https://evil.example/phish', 'https://api.arenaofbias.icu.evil.example/admin/batch.html', '//evil.example/phish', 'http://api.arenaofbias.icu/admin/batch.html', 'https://user:pass@api.arenaofbias.icu/admin/batch.html', 'javascript:alert(1)', '/\\evil.example', '', 12]) {
    assert.throws(() => assertVerificationUrl(value), /确认页地址无效/);
  }
});

test('auth deletes the device code on failure and refuses a foreign confirmation page', async () => {
  const box = fixture();
  await planCommand(box.batch, box.home);
  const stored = [];
  const deleted = [];
  const deps = {
    home: box.home,
    assertStore() {},
    storeSecret(account, secret) { stored.push([account, secret]); },
    deleteSecret(account) { deleted.push(account); },
    readSecret() { return 'aobc_device'; },
    sleep: async () => {},
  };
  stored.length = 0;
  deleted.length = 0;
  await assert.rejects(() => authCommand(box.batch, {
    ...deps,
    request: async () => ({ status: 200, data: { device_code: 'aobc_device', user_code: 'ABCD', verification_url: 'https://evil.example/phish' } }),
  }), /确认页地址无效/);
  assert.deepEqual(stored, []);
  assert.deepEqual(deleted, []);

  let ticks = 0;
  await assert.rejects(() => authCommand(box.batch, {
    ...deps,
    now() { ticks += 1; return ticks === 1 ? 0 : 1e15; },
    request: async () => ({ status: 200, data: { device_code: 'aobc_device', user_code: 'ABCD', verification_url: '/admin/batch.html#c=ABCD', interval: 0 } }),
  }), /等待确认超时/);
  assert.deepEqual(deleted, ['device:lampcli']);
  assert.equal(stored.some(([account]) => account.startsWith('grant:')), false);

  stored.length = 0;
  deleted.length = 0;
  let calls = 0;
  await assert.rejects(() => authCommand(box.batch, {
    ...deps,
    now: () => 0,
    request: async () => {
      calls += 1;
      if (calls === 1) return { status: 200, data: { device_code: 'aobc_device', user_code: 'ABCD', verification_url: '/admin/batch.html#c=ABCD', interval: 0 } };
      return { status: 403, data: {} };
    },
  }), /确认失败（403）/);
  assert.deepEqual(deleted, ['device:lampcli']);

  stored.length = 0;
  deleted.length = 0;
  calls = 0;
  await authCommand(box.batch, {
    ...deps,
    now: () => 0,
    request: async () => {
      calls += 1;
      if (calls === 1) return { status: 200, data: { device_code: 'aobc_device', user_code: 'ABCD', verification_url: '/admin/batch.html#c=ABCD', interval: 0 } };
      return { status: 200, data: { token: 'aobb_upload' } };
    },
  });
  assert.deepEqual(stored.map(([account]) => account), ['device:lampcli', 'grant:lampcli']);
  assert.deepEqual(deleted, ['device:lampcli']);
  assert.equal(stored[1][1], 'aobb_upload');
  box.cleanup();
});

test('credential commands keep the secret off argv, including Windows deletion', () => {
  const secret = 'aobb_upload-token_value';
  const account = 'grant:lampcli';
  const darwin = planCredentialCall('darwin', 'store', account, secret);
  assert.deepEqual(darwin.args, ['add-generic-password', '-U', '-s', 'arenaofbias-batch', '-a', account, '-w']);
  assert.equal(darwin.args.includes(secret), false);
  assert.equal(darwin.args.join('\0').includes(secret), false);
  assert.deepEqual(darwin.input.split('\n').filter(Boolean), [secret, secret]);
  const linux = planCredentialCall('linux', 'store', account, secret);
  assert.equal(linux.args.includes(secret), false);
  assert.equal(linux.input, secret);
  const winDelete = planCredentialCall('win32', 'delete', 'device:lampcli');
  assert.equal(winDelete.args.join('\n').includes('device:lampcli'), false);
  assert.equal(winDelete.args.join('\n').includes(secret), false);
  assert.match(winDelete.args.join('\n'), /PasswordVault/);
  assert.match(winDelete.args.join('\n'), /\$vault\.Remove/);
  assert.equal(winDelete.env.AOB_ACCOUNT, 'device:lampcli');
  assert.equal(winDelete.input, null);
  const winStore = planCredentialCall('win32', 'store', account, secret);
  assert.equal(winStore.args.join('\n').includes(secret), false);
  assert.equal(winStore.input, secret);
  assert.throws(() => planCredentialCall('darwin', 'store', account, `${'a'.repeat(MAX_DARWIN_SECRET_BYTES + 1)}`), /拒绝/);
  assert.throws(() => planCredentialCall('darwin', 'store', account, 'line\nbreak'), /拒绝/);
  assert.equal(parseStrictJson('{"key":"lamp-01"}').key, 'lamp-01');
  assert.throws(() => parseStrictJson('{"__proto__":{"admin":true}}'), /特殊字段名/);
  assert.throws(() => parseStrictJson('{"constructor":{"x":1}}'), /特殊字段名/);
  assert.throws(() => parseStrictJson('{"prototype":1}'), /特殊字段名/);
  assert.throws(() => assertZipRuntime({}), new RegExp(MIN_NODE.replaceAll('.', '\\.')));
  assert.doesNotThrow(() => assertZipRuntime());
  for (const name of readdirSync(join(process.cwd(), 'tools/batch-upload'))) {
    if (!name.endsWith('.mjs')) continue;
    assert.equal(readFileSync(join(process.cwd(), 'tools/batch-upload', name), 'utf8').includes('server/'), false, name);
  }
});

test('HTTP client refuses a redirect that would carry Authorization', async () => {
  await assert.rejects(() => apiRequest('GET', '/api/batch/example', {
    headers: { authorization: 'Bearer aobb_test' },
    transport: async ({ url, headers }) => {
      assert.equal(url.origin, 'https://api.arenaofbias.icu');
      assert.equal(headers.authorization, 'Bearer aobb_test');
      return { status: 302, headers: { location: 'https://evil.example/collect' }, body: Buffer.alloc(0) };
    },
  }), /redirect_refused/);
});
