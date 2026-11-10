// Local batch uploader for an ordinary moderator. No --token, --endpoint, or --insecure.
// The upload token is never printed. auth/upload talk only to https://api.arenaofbias.icu.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStore, deleteSecret, readSecret, storeSecret } from './credentials.mjs';
import { apiJson, apiRequest, assertVerificationUrl } from './http.mjs';
import { parseStrictJson } from './json.mjs';
import { LOCAL_LIMITS, assertBatchTotals, assertWorkBudget } from './limits.mjs';
import { normalizeBatchId, normalizeWorkKey, planDigest } from './plan.mjs';
import { openBatch, readLocalFile, readTree, realRoot, writeAtomicFile } from './walk.mjs';
import { assertZipRuntime, storeZip } from './zip.mjs';

const BANNED = new Set(['--token', '--endpoint', '--insecure', '--api', '-k']);
const BANNED_ENV = ['AOB_TOKEN', 'AOB_API', 'AOB_ENDPOINT', 'AOB_INSECURE'];
const WORK_FIELDS = ['task', 'title', 'summary', 'modelId', 'modelName', 'vendor', 'effort', 'providerId', 'harnessId', 'harnessOther', 'generationMode', 'humanIntervention', 'promptVariant', 'note'];

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

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

export function loadAllowRoot(home = homedir()) {
  const directory = join(home, '.config', 'arenaofbias');
  let bytes;
  try { bytes = readLocalFile(directory, 'batch-root', 64 * 1024); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('请先在 ~/.config/arenaofbias/batch-root 写入唯一的允许根目录');
    throw error;
  }
  const root = bytes.toString('utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  if (!root) throw new Error('允许根目录为空');
  return realRoot(resolve(root));
}

function locate(dir, home = homedir()) {
  return openBatch(loadAllowRoot(home), dir);
}

function ownUploaded(value) {
  const out = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of Object.keys(value)) {
    try { normalizeWorkKey(key); }
    catch { continue; }
    const id = value[key];
    if (typeof id === 'string' && id && id.length <= 80 && !id.includes('\n') && !id.includes('\r')) out[key] = id;
  }
  return out;
}

function workRecord(source, key) {
  const record = { key };
  for (const field of WORK_FIELDS) if (source[field] != null) record[field] = source[field];
  return record;
}

function loadManifest(batchDir) {
  let raw;
  try { raw = parseStrictJson(readLocalFile(batchDir, 'manifest.json').toString('utf8')); }
  catch (error) {
    if (error.code === 'local_refused' || error.message === '拒绝特殊字段名') throw error;
    throw new Error('manifest.json 无效');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.works)) throw new Error('manifest.json 无效');
  return raw;
}

export function buildPlan(dir, home = homedir()) {
  const { batchDir } = locate(dir, home);
  const manifest = loadManifest(batchDir);
  normalizeBatchId(manifest.batch);
  assertBatchTotals({ works: manifest.works.length, compressed: 0, expanded: 0 });
  const seen = new Set();
  const listed = manifest.works.map((work) => {
    if (!work || typeof work !== 'object' || Array.isArray(work)) throw new Error('作品计划无效');
    const key = normalizeWorkKey(work.key);
    if (seen.has(key)) throw new Error('作品键重复');
    seen.add(key);
    return { key, work };
  });
  let expanded = 0;
  let compressed = 0;
  const works = listed.map(({ key, work }) => {
    const relativeDir = String(work.dir ?? '');
    if (!relativeDir || relativeDir.startsWith('/') || relativeDir.includes('\\') || relativeDir.includes('..')) {
      throw new Error('作品目录必须是批次内的相对路径');
    }
    const files = readTree(batchDir, relativeDir, {
      maxBatchBytes: LOCAL_LIMITS.maxExpanded - expanded,
    });
    if (!files.length) throw new Error(`作品 ${key} 没有可上传的文件`);
    const workExpanded = files.reduce((sum, file) => sum + file.size, 0);
    assertWorkBudget({ expanded: workExpanded, files: files.length, fileBytes: 0 });
    expanded += workExpanded;
    let body;
    if (files.length === 1 && files[0].path === 'index.html') body = files[0].data;
    else {
      body = storeZip(files);
      for (const file of files) file.data = null;
    }
    assertWorkBudget({ compressed: body.length, expanded: workExpanded, files: files.length });
    compressed += body.length;
    assertBatchTotals({ works: listed.length, compressed, expanded });
    return {
      record: {
        ...workRecord(work, key),
        files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        compressedBytes: body.length,
      },
      body,
    };
  });
  const plan = {
    batch: manifest.batch,
    clientName: 'aob-batch',
    works: works.map(({ record }) => record),
  };
  const packed = planDigest(plan);
  return {
    batchDir,
    packed,
    bodies: new Map(works.map((work) => [work.record.key, work.body])),
  };
}

function checkpoint(batchDir, state) {
  const uploaded = ownUploaded(state.uploaded);
  const safe = {
    batch: state.batch,
    clientName: state.clientName,
    works: state.works,
    payloadDigest: state.payloadDigest,
    uploaded,
  };
  writeAtomicFile(batchDir, 'plan.json', `${JSON.stringify(safe, null, 2)}\n`);
}

function readPlanFile(batchDir) {
  let state;
  try { state = parseStrictJson(readLocalFile(batchDir, 'plan.json').toString('utf8')); }
  catch (error) {
    if (error.message === '请先执行 plan' || error.code === 'local_refused' || error.message === '拒绝特殊字段名') throw error;
    throw new Error('plan.json 无效，请重新执行 plan');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('plan.json 无效，请重新执行 plan');
  let batch;
  try { batch = normalizeBatchId(state.batch); }
  catch { throw new Error('plan.json 无效，请重新执行 plan'); }
  return { state, batch, uploaded: ownUploaded(state.uploaded) };
}

// status and cancel use this. They do not walk work files.
export function readLocalState(dir, home = homedir()) {
  const { batchDir } = locate(dir, home);
  const { batch, state, uploaded } = readPlanFile(batchDir);
  return { batchDir, batch, payloadDigest: typeof state.payloadDigest === 'string' ? state.payloadDigest : '', uploaded };
}

export async function planCommand(dir, home = homedir()) {
  assertZipRuntime();
  const built = buildPlan(dir, home);
  checkpoint(built.batchDir, { ...built.packed.plan, payloadDigest: built.packed.digest, uploaded: {} });
  console.log(`${built.packed.digest} ${built.packed.plan.works.length}`);
  return built.packed.digest;
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function authCommand(dir, deps = {}) {
  const home = deps.home ?? homedir();
  const request = deps.request ?? apiJson;
  const store = deps.storeSecret ?? storeSecret;
  const remove = deps.deleteSecret ?? deleteSecret;
  const read = deps.readSecret ?? readSecret;
  const checkStore = deps.assertStore ?? assertStore;
  const wait = deps.sleep ?? sleep;
  const clock = deps.now ?? Date.now;
  checkStore();
  const built = buildPlan(dir, home);
  const saved = readPlanFile(built.batchDir).state;
  if (saved.payloadDigest !== built.packed.digest) throw new Error('计划已变化，请重新执行 plan');
  const response = await request('POST', '/api/batch/device', {
    body: { ...built.packed.plan, payloadDigest: built.packed.digest },
  });
  if (response.status !== 200 || typeof response.data?.device_code !== 'string' || !response.data.device_code) {
    throw new Error(`登记失败（${response.status}）`);
  }
  const page = assertVerificationUrl(response.data.verification_url);
  if (typeof response.data.user_code !== 'string' || !response.data.user_code) throw new Error(`登记失败（${response.status}）`);
  const deviceAccount = `device:${built.packed.plan.batch}`;
  await store(deviceAccount, response.data.device_code);
  try {
    console.log(page.href);
    console.log(response.data.user_code);
    console.log(built.packed.digest);
    const deadline = clock() + 15 * 60 * 1000;
    let interval = (response.data.interval ?? 3) * 1000;
    while (clock() < deadline) {
      await wait(interval);
      const code = await read(deviceAccount);
      const polled = await request('POST', '/api/batch/device/poll', { body: { device_code: code } });
      if (polled.status === 202) {
        interval = Math.min(15_000, (polled.data.interval ?? 3) * 1000);
        continue;
      }
      if (polled.status === 200 && polled.data.token) {
        await store(`grant:${built.packed.plan.batch}`, polled.data.token);
        console.log('已确认');
        return;
      }
      if ([400, 401, 403, 409].includes(polled.status)) throw new Error(`确认失败（${polled.status}）`);
      interval = Math.min(15_000, interval * 2);
    }
    throw new Error('等待确认超时');
  } finally {
    try { await remove(deviceAccount); }
    catch { /* leaving the device code behind is preferable to hiding the auth result */ }
  }
}

const RETRY = new Set([429, 503]);

export async function uploadCommand(dir, deps = {}) {
  const home = deps.home ?? homedir();
  const request = deps.request ?? apiRequest;
  const read = deps.readSecret ?? readSecret;
  const checkStore = deps.assertStore ?? assertStore;
  const wait = deps.sleep ?? sleep;
  checkStore();
  const built = buildPlan(dir, home);
  const saved = readPlanFile(built.batchDir);
  if (saved.state.payloadDigest !== built.packed.digest) throw new Error('计划已变化，请重新执行 plan 和 auth');
  const token = await read(`grant:${built.packed.plan.batch}`);
  const uploaded = saved.uploaded;
  for (const work of built.packed.plan.works) {
    if (uploaded[work.key]) continue;
    const body = built.bodies.get(work.key);
    let attempt = 0;
    let delay = 1000;
    for (;;) {
      const response = await request('PUT', `/api/batch/${encodeURIComponent(built.packed.plan.batch)}/works/${encodeURIComponent(work.key)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': work.key,
          'content-length': String(body.length),
        },
        body,
      });
      if (response.status === 200 || response.status === 201) {
        let data;
        try { data = parseStrictJson(response.body.toString('utf8') || '{}'); }
        catch { throw new Error(`${work.key} 失败（${response.status}）`); }
        if (typeof data.workId !== 'string' || !data.workId || data.workId.length > 80) {
          throw new Error(`${work.key} 失败（${response.status}）`);
        }
        uploaded[work.key] = data.workId;
        checkpoint(built.batchDir, { ...saved.state, ...built.packed.plan, payloadDigest: built.packed.digest, uploaded });
        console.log(`${work.key} ${response.status}`);
        break;
      }
      if (!RETRY.has(response.status) || attempt >= 3) throw new Error(`${work.key} 失败（${response.status}）`);
      const retryAfter = Number(response.headers?.['retry-after']);
      await wait((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay));
      attempt += 1;
      delay *= 2;
    }
  }
}

export async function statusCommand(dir, deps = {}) {
  const home = deps.home ?? homedir();
  const request = deps.request ?? apiJson;
  const read = deps.readSecret ?? readSecret;
  const checkStore = deps.assertStore ?? assertStore;
  checkStore();
  const state = readLocalState(dir, home);
  const token = await read(`grant:${state.batch}`);
  const response = await request('GET', `/api/batch/${encodeURIComponent(state.batch)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) throw new Error(`查询失败（${response.status}）`);
  for (const work of response.data.works ?? []) console.log(`${work.key} ${work.state} ${work.workId ?? ''}`);
  return response.data;
}

export async function cancelCommand(dir, deps = {}) {
  const home = deps.home ?? homedir();
  const request = deps.request ?? apiJson;
  const read = deps.readSecret ?? readSecret;
  const checkStore = deps.assertStore ?? assertStore;
  checkStore();
  const state = readLocalState(dir, home);
  const token = await read(`grant:${state.batch}`);
  const response = await request('POST', `/api/batch/${encodeURIComponent(state.batch)}/cancel`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '2' },
    body: {},
  });
  if (response.status !== 200) throw new Error(`取消失败（${response.status}）`);
  console.log(`cancelled ${(response.data.cancelled ?? []).length}`);
  return response.data;
}

function main() {
  for (const arg of process.argv.slice(2)) {
    const name = arg.split('=')[0];
    if (BANNED.has(name)) die('不接受该参数', 2);
  }
  for (const key of BANNED_ENV) if (process.env[key]) die('环境变量包含不被接受的配置，已拒绝执行', 2);
  assertZipRuntime();
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
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedDirectly()) main();
