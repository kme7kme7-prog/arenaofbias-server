// Local batch uploader for an ordinary moderator. No --token, --endpoint, or --insecure.
// The upload token is never printed. auth/upload talk only to https://api.arenaofbias.icu.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { planDigest } from '../../server/batch-plan.mjs';
import { assertStore, deleteSecret, readSecret, storeSecret } from './credentials.mjs';
import { ORIGIN, apiJson, apiRequest } from './http.mjs';
import { assertInside, readTree, realRoot } from './walk.mjs';
import { storeZip } from './zip.mjs';

const BANNED = new Set(['--token', '--endpoint', '--insecure', '--api', '-k']);
const BANNED_ENV = ['AOB_TOKEN', 'AOB_API', 'AOB_ENDPOINT', 'AOB_INSECURE'];

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

for (const arg of process.argv.slice(2)) {
  const name = arg.split('=')[0];
  if (BANNED.has(name)) die('不接受该参数', 2);
}
for (const key of BANNED_ENV) if (process.env[key]) die('环境变量包含不被接受的配置，已拒绝执行', 2);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') out.dir = argv[++i];
    else if (arg.startsWith('--dir=')) out.dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--')) die('不接受该参数', 2);
    else out._.push(arg);
  }
  return out;
}

function allowRoot() {
  const file = join(homedir(), '.config', 'arenaofbias', 'batch-root');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { die('请先在 ~/.config/arenaofbias/batch-root 写入唯一的允许根目录'); }
  const root = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  if (!root) die('允许根目录为空');
  return realRoot(resolve(root));
}

function loadManifest(dir) {
  const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.works)) die('manifest.json 无效');
  return raw;
}

function buildPlan(dir) {
  const root = allowRoot();
  const batchDir = assertInside(root, resolve(dir)).absolute;
  const manifest = loadManifest(batchDir);
  const works = manifest.works.map((work) => {
    const relativeDir = String(work.dir ?? '');
    if (!relativeDir || relativeDir.startsWith('/') || relativeDir.includes('..')) die('作品目录必须是批次内的相对路径');
    const files = readTree(batchDir, relativeDir).map(({ data, ...meta }) => ({ ...meta, data }));
    if (!files.length) die(`作品 ${work.key ?? ''} 没有可上传的文件`);
    const body = files.length === 1 && files[0].path === 'index.html'
      ? files[0].data
      : storeZip(files);
    return {
      ...work,
      files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      compressedBytes: body.length,
      body,
    };
  });
  const plan = {
    batch: manifest.batch,
    clientName: 'aob-batch',
    works: works.map(({ body, ...work }) => work),
  };
  const packed = planDigest(plan);
  return { root, batchDir, packed, bodies: new Map(works.map((work) => [work.key, work.body])) };
}

function checkpoint(batchDir, state) {
  writeFileSync(join(batchDir, 'plan.json'), `${JSON.stringify(state, null, 2)}\n`);
}

async function planCommand(dir) {
  const built = buildPlan(dir);
  checkpoint(built.batchDir, { ...built.packed.plan, payloadDigest: built.packed.digest, uploaded: {} });
  console.log(`${built.packed.digest} ${built.packed.plan.works.length}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function authCommand(dir) {
  assertStore();
  const built = buildPlan(dir);
  const saved = JSON.parse(readFileSync(join(built.batchDir, 'plan.json'), 'utf8'));
  if (saved.payloadDigest !== built.packed.digest) die('计划已变化，请重新执行 plan');
  const response = await apiJson('POST', '/api/batch/device', {
    body: { ...built.packed.plan, payloadDigest: built.packed.digest },
  });
  if (response.status !== 200 || !response.data.device_code) die(`登记失败（${response.status}）`);
  storeSecret(`device:${built.packed.plan.batch}`, response.data.device_code);
  const page = new URL(response.data.verification_url, ORIGIN);
  console.log(page.href);
  console.log(response.data.user_code);
  console.log(built.packed.digest);
  const deadline = Date.now() + 15 * 60 * 1000;
  let interval = (response.data.interval ?? 3) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const code = readSecret(`device:${built.packed.plan.batch}`);
    const polled = await apiJson('POST', '/api/batch/device/poll', { body: { device_code: code } });
    if (polled.status === 202) {
      interval = Math.min(15_000, (polled.data.interval ?? 3) * 1000);
      continue;
    }
    if (polled.status === 200 && polled.data.token) {
      storeSecret(`grant:${built.packed.plan.batch}`, polled.data.token);
      deleteSecret(`device:${built.packed.plan.batch}`);
      console.log('已确认');
      return;
    }
    if ([400, 401, 403, 409].includes(polled.status)) die(`确认失败（${polled.status}）`);
    interval = Math.min(15_000, interval * 2);
  }
  die('等待确认超时');
}

const RETRY = new Set([429, 503]);

async function uploadCommand(dir) {
  assertStore();
  const built = buildPlan(dir);
  const state = JSON.parse(readFileSync(join(built.batchDir, 'plan.json'), 'utf8'));
  if (state.payloadDigest !== built.packed.digest) die('计划已变化，请重新执行 plan 和 auth');
  const token = readSecret(`grant:${built.packed.plan.batch}`);
  state.uploaded ??= {};
  for (const work of built.packed.plan.works) {
    if (state.uploaded[work.key]) continue;
    const body = built.bodies.get(work.key);
    let attempt = 0;
    let delay = 1000;
    for (;;) {
      const response = await apiRequest('PUT', `/api/batch/${encodeURIComponent(built.packed.plan.batch)}/works/${encodeURIComponent(work.key)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': work.key,
          'content-length': String(body.length),
        },
        body,
      });
      if (response.status === 200 || response.status === 201) {
        const data = JSON.parse(response.body.toString('utf8'));
        state.uploaded[work.key] = data.workId;
        checkpoint(built.batchDir, { ...state, payloadDigest: built.packed.digest });
        console.log(`${work.key} ${response.status}`);
        break;
      }
      if (!RETRY.has(response.status) || attempt >= 3) die(`${work.key} 失败（${response.status}）`);
      const retryAfter = Number(response.headers['retry-after']);
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay));
      attempt += 1;
      delay *= 2;
    }
  }
}

async function statusCommand(dir) {
  assertStore();
  const built = buildPlan(dir);
  const token = readSecret(`grant:${built.packed.plan.batch}`);
  const response = await apiJson('GET', `/api/batch/${encodeURIComponent(built.packed.plan.batch)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) die(`查询失败（${response.status}）`);
  for (const work of response.data.works ?? []) console.log(`${work.key} ${work.state} ${work.workId ?? ''}`);
}

async function cancelCommand(dir) {
  assertStore();
  const built = buildPlan(dir);
  const token = readSecret(`grant:${built.packed.plan.batch}`);
  const response = await apiJson('POST', `/api/batch/${encodeURIComponent(built.packed.plan.batch)}/cancel`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '2' },
    body: {},
  });
  if (response.status !== 200) die(`取消失败（${response.status}）`);
  console.log(`cancelled ${(response.data.cancelled ?? []).length}`);
}

const parsed = args(process.argv.slice(3));
const command = process.argv[2];
const run = {
  plan: () => planCommand(parsed.dir),
  auth: () => authCommand(parsed.dir),
  upload: () => uploadCommand(parsed.dir),
  status: () => statusCommand(parsed.dir),
  cancel: () => cancelCommand(parsed.dir),
}[command];
if (!run || !parsed.dir) {
  console.log('用法: aob-batch plan|auth|upload|status|cancel --dir <允许根内的批次目录>');
  process.exit(run ? 1 : 2);
}
run().catch((error) => die(error.message || '失败'));
