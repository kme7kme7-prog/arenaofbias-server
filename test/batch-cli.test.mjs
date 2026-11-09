import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apiRequest } from '../tools/batch-upload/http.mjs';
import { readTree } from '../tools/batch-upload/walk.mjs';

const cli = join(process.cwd(), 'tools/batch-upload/aob-batch.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
