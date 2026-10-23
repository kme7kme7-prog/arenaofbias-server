// Private, bounded screenshot jobs. The platform owns schema migration and routes.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, constants } from 'node:fs';
import { lstat, open, readdir, realpath, readFile } from 'node:fs/promises';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { join, resolve, sep } from 'node:path';
import { fail, HttpError } from './http.mjs';
import { checkCapture } from './work-captures.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
const JOB = /^[0-9a-f]{32}$/;
const DEFAULTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, wait: { load: 'load', settleMs: 3500 } };
const LIMITS = { desktop: { width: [640, 1920], height: [480, 1440] }, mobile: { width: [320, 600], height: [480, 1200] }, settleMs: [0, 10000] };
const TERMINAL = new Set(['succeeded', 'partial', 'failed']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));

export function recaptureOptions(body) {
  if (!fields(body, ['task', 'id', 'version', 'desktop', 'mobile', 'wait']) || !ID.test(body.task ?? '') || !ID.test(body.id ?? '') || !/^[a-f0-9]{64}$/.test(body.version ?? '')) fail(400, '重截图参数或版本无效', 'invalid_recapture');
  const result = {};
  for (const slot of ['desktop', 'mobile']) {
    const value = body[slot] ?? DEFAULTS[slot];
    if (!fields(value, ['width', 'height']) || !['width', 'height'].every(key => Number.isInteger(value[key]) && value[key] >= LIMITS[slot][key][0] && value[key] <= LIMITS[slot][key][1])) fail(400, '截图尺寸超出允许范围', 'invalid_dimensions');
    result[slot] = { width: value.width, height: value.height };
  }
  const wait = body.wait ?? DEFAULTS.wait;
  if (!fields(wait, ['load', 'settleMs']) || !['load', 'domcontentloaded'].includes(wait.load) || !Number.isInteger(wait.settleMs) || wait.settleMs < 0 || wait.settleMs > 10000) fail(400, '等待条件仅支持 load/domcontentloaded 和 0–10000ms', 'invalid_wait');
  return { ...result, wait: { load: wait.load, settleMs: wait.settleMs } };
}

// Hash the bounded original tree, not a possibly stale persisted upload digest.
const sourceStamp = work => createHash('sha256').update(JSON.stringify([work.taskId, work.id, work.entry, work.dir, work.digest, work.contentKey])).digest('hex');
const statStamp = value => [value.ino,value.dev,value.size,value.mtimeMs,value.ctimeMs];
async function sourceVersion(work) {
  const root = await realpath(work.dir), hash = createHash('sha256'), manifest = [], stamp = sourceStamp(work);
  hash.update(stamp);
  let count = 0, bytes = 0;
  const buffer = Buffer.alloc(65536);
  async function walk(dir, prefix = '') {
    const initial = await lstat(dir);
    manifest.push([prefix,statStamp(initial)]);
    hash.update(JSON.stringify([prefix,statStamp(initial)]));
    for (const name of (await readdir(dir)).sort()) {
      if (++count > 4096) fail(413, '源文件数量超出重截图上限', 'source_too_large');
      const file = join(dir, name), relative = prefix + name, before = await lstat(file);
      if (before.isSymbolicLink() || !(await realpath(file)).startsWith(root + sep)) fail(409, '源文件结构已改变', 'source_changed');
      if (before.isDirectory()) { await walk(file, `${relative}/`); continue; }
      if (!before.isFile()) fail(409, '源文件结构无效', 'source_changed');
      bytes += before.size;
      if (bytes > 128 * 1024 * 1024) fail(413, '源文件超过重截图上限', 'source_too_large');
      manifest.push([relative,statStamp(before)]);
      hash.update(JSON.stringify([relative, statStamp(before)]));
      const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await fd.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail(409, '读取时源文件已改变', 'source_changed');
        let length, read = 0;
        while ((length = (await fd.read(buffer,0,buffer.length,null)).bytesRead)) { read += length; if (read > before.size) fail(409, '读取时源文件已改变', 'source_changed'); hash.update(buffer.subarray(0, length)); await yieldIO(); }
      }
      finally { await fd.close(); }
      const after = await lstat(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino) fail(409, '读取时源文件已改变', 'source_changed');
    }
    if (JSON.stringify(statStamp(await lstat(dir))) !== JSON.stringify(statStamp(initial))) fail(409, '读取时源文件目录已改变', 'source_changed');
  }
  await walk(root);
  return { version: hash.digest('hex'), stamp, manifest };
}

export function createRecaptures({ db, library, capturer, rootDir, authorizeJob, now = Date.now, retentionMs = 3600000, deadlineMs = 900000, cooldownMs = 60000, maxJobs = 100, maxPending = 8 }) {
  mkdirSync(resolve(rootDir), { recursive: true, mode: 0o700 });
  const root = realpathSync(resolve(rootDir));
  const q = {
    all: db.prepare('SELECT id,token_id,actor_id,binding_revision,task_id,work_id,source_version,state,created_at,expires_at FROM recapture_jobs ORDER BY created_at,id'),
    one: db.prepare('SELECT * FROM recapture_jobs WHERE id=?'),
    insert: db.prepare(`INSERT INTO recapture_jobs(id,token_id,actor_id,binding_revision,task_id,work_id,source_version,spec,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    update: db.prepare('UPDATE recapture_jobs SET state=?,updated_at=?,error_code=?,error_stage=?,outputs=? WHERE id=?'),
    remove: db.prepare('DELETE FROM recapture_jobs WHERE id=?'),
  };
  const pending = [], active = new Map();
  let running = false, closed = false, draining = null;
  const ownerOf = row => ({ tokenId: row.token_id, actorId: row.actor_id, bindingRevision: row.binding_revision });
  const sameOwner = (row, owner) => row.token_id === owner.tokenId && row.actor_id === owner.actorId && row.binding_revision === owner.bindingRevision;
  const dirOf = id => join(root, id);
  const update = (row, state, code = null, stage = null, outputs = {}) => q.update.run(state, now(), code, stage, JSON.stringify(outputs), row.id);
  function cleanup() {
    for (const row of q.all.all()) if (row.expires_at <= now() && !active.has(row.id)) {
      rmSync(dirOf(row.id), { recursive: true, force: true }); q.remove.run(row.id);
    }
  }
  // Pending browser work is never silently replayed after a process restart.
  for (const row of q.all.all()) if (!TERMINAL.has(row.state)) { update(row, 'failed', 'service_restarted', 'queue'); rmSync(dirOf(row.id), { recursive: true, force: true }); }
  cleanup();
  // This directory contains only private jobs owned by this module.
  for (const entry of readdirSync(root)) if (JOB.test(entry) && !q.one.get(entry)) rmSync(dirOf(entry), { recursive: true, force: true });
  function workNow(task, id) {
    if (!ID.test(task ?? '') || !ID.test(id ?? '')) fail(400, '作品标识无效', 'invalid_recapture');
    const work = library.work(task, id);
    if (!work || work.curated || !work.dir || !library.uploadById(id)) fail(404, '作品不存在或不支持重截图', 'not_found');
    return work;
  }
  async function current(task, id, expected) {
    const work = workNow(task,id);
    let snapshot;
    try { snapshot = await sourceVersion(work); }
    catch (error) { if (error instanceof HttpError) throw error; fail(409, '源文件不可用或已改变', 'source_changed'); }
    if (sourceStamp(workNow(task,id)) !== snapshot.stamp || expected && snapshot.version !== expected) fail(409, '作品源版本已改变，请重新获取版本', 'source_changed');
    return { work, ...snapshot };
  }
  function dto(row) {
    const outputs = JSON.parse(row.outputs);
    return { jobId: row.id, task: row.task_id, id: row.work_id, version: row.source_version, state: row.state,
      createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, options: (({desktop,mobile,wait})=>({desktop,mobile,wait}))(JSON.parse(row.spec)),
      ...(row.error_code ? { error: { code: row.error_code, stage: row.error_stage } } : {}),
      images: Object.entries(outputs).map(([slot, {width,height,bytes}]) => ({ slot, width,height,bytes, url: `/api/dots/admin/recaptures/${row.id}/images/${slot}` })) };
  }
  function owned(owner, id) {
    cleanup();
    const row = JOB.test(id ?? '') && q.one.get(id);
    if (!row || !sameOwner(row, owner)) fail(404, '截图任务不存在或已过期', 'not_found');
    return row;
  }
  async function valid(row) {
    if (closed || now() >= row.created_at + deadlineMs || now() >= row.expires_at) fail(409, '截图任务已超过期限', 'job_timeout');
    authorizeJob(ownerOf(row));
    const value = await current(row.task_id, row.work_id, row.source_version);
    if (closed || now() >= row.created_at + deadlineMs || now() >= row.expires_at) fail(409, '截图任务已超过期限', 'job_timeout');
    authorizeJob(ownerOf(row));
    return value.work;
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      while (pending.length && !closed) {
        const id = pending.shift(), row = q.one.get(id);
        if (!row || TERMINAL.has(row.state)) continue;
        const controller = new AbortController(); active.set(id, controller);
        const timer = setTimeout(() => controller.abort(), Math.max(1, row.created_at + deadlineMs - now())); timer.unref?.();
        try {
          const work = await valid(row), options = JSON.parse(row.spec);
          update(row, 'running'); mkdirSync(dirOf(id), { mode: 0o700 });
          const result = await capturer.enqueue(work, { publish: false, prefix: '', outputDir: dirOf(id), detailed: true, late: false, signal: controller.signal,
            shots: [{ id: 'first', viewport: options.desktop, mobile: false }, { id: 'mobile', viewport: options.mobile, mobile: true }], wait: options.wait,
            beforeCapture: () => valid(row), onProgress: state => { if (!controller.signal.aborted && q.one.get(id)?.state === 'running' && state === 'waiting-service') update(row, 'waiting-service'); } });
          await valid(row);
          if (controller.signal.aborted) fail(409, '截图任务已超过期限', 'job_timeout');
          const outputs = {};
          for (const slot of ['first', 'mobile']) {
            if (result?.captures?.[slot] !== `${slot}.jpg`) continue;
            const file = join(dirOf(id), `${slot}.jpg`), info=await lstat(file);
            if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024) fail(502,'截图文件无效或过大','invalid_output');
            const buffer = await readFile(file), image = checkCapture(buffer, 8 * 1024 * 1024);
            const wanted = options[slot === 'first' ? 'desktop' : 'mobile'];
            if (image.width !== wanted.width || image.height !== wanted.height) fail(502, '截图输出尺寸不符合任务', 'invalid_output');
            outputs[slot] = { width: image.width, height: image.height, bytes: buffer.length, fingerprint: statStamp(lstatSync(file)) };
          }
          const count = Object.keys(outputs).length;
          if (count === 2) update(row, 'succeeded', null, null, outputs);
          else update(row, count ? 'partial' : 'failed', result?.error?.code ?? (result?.unavailable || !result ? 'environment_unavailable' : 'capture_incomplete'), result?.error?.stage ?? 'capture', outputs);
        } catch (error) {
          const code = closed ? 'service_stopped' : controller.signal.aborted ? 'job_timeout' : error instanceof HttpError ? error.code : 'capture_failed';
          if (!TERMINAL.has(q.one.get(id)?.state)) update(row, 'failed', code || 'capture_failed', ['source_changed', 'not_found'].includes(code) ? 'source' : code?.startsWith('admin_') || code === 'scope_required' || code === 'unauthorized' ? 'authorization' : 'capture');
          rmSync(dirOf(id), { recursive: true, force: true });
        } finally { clearTimeout(timer); active.delete(id); }
      }
    } finally { running = false; }
  }
  const sweep = setInterval(cleanup, 60000); sweep.unref?.();
  return {
    async source(task, id) { const value = await current(task, id); return { task, id, version: value.version, defaults: DEFAULTS, limits: { ...LIMITS, retentionMs, deadlineMs, cooldownMs, maxPending } }; },
    async request(owner, body) {
      if (closed) fail(503, '截图任务服务已关闭', 'service_unavailable');
      const options = recaptureOptions(body); authorizeJob(owner);
      const snapshot = await current(body.task, body.id, body.version);
      if (closed) fail(503, '截图任务服务已关闭', 'service_unavailable');
      authorizeJob(owner); cleanup();
      const spec = { ...options, sourceStamp:snapshot.stamp, manifest:snapshot.manifest };
      const rows = q.all.all();
      const previous = rows.filter(row => row.task_id === body.task && row.work_id === body.id).at(-1);
      const inFlight = rows.find(row => row.task_id === body.task && row.work_id === body.id && !TERMINAL.has(row.state));
      if (inFlight) {
        const existing=q.one.get(inFlight.id);
        if (sameOwner(inFlight, owner) && inFlight.source_version === body.version && existing.spec === JSON.stringify(spec)) return dto(existing);
        fail(409, '这个作品已有截图任务，请等待其完成', 'job_in_progress');
      }
      if (previous && now() - previous.created_at < cooldownMs) fail(429, '这个作品重截图过于频繁，请稍后重试', 'recapture_cooldown');
      if (rows.filter(row => !TERMINAL.has(row.state)).length >= maxPending || rows.length >= maxJobs) fail(429, '截图队列或保留任务已满，请稍后重试', 'recapture_capacity');
      const id = randomBytes(16).toString('hex'), at = now();
      q.insert.run(id, owner.tokenId, owner.actorId, owner.bindingRevision, body.task, body.id, body.version, JSON.stringify(spec), 'queued', at, at, at + retentionMs);
      pending.push(id); queueMicrotask(() => { if (!draining) draining = drain().finally(() => { draining = null; }); });
      return dto(q.one.get(id));
    },
    get(owner, id) {
      const row = owned(owner, id);
      if (!TERMINAL.has(row.state) && now() >= row.created_at + deadlineMs) { active.get(id)?.abort(); update(row, 'failed', 'job_timeout', 'queue'); }
      try { if(sourceStamp(workNow(row.task_id,row.work_id))!==JSON.parse(row.spec).sourceStamp) fail(409,'作品源版本已改变','source_changed'); }
      catch (error) { if (!(error instanceof HttpError)) throw error; active.get(id)?.abort(); update(row, 'failed', error.code, 'source'); rmSync(dirOf(id), { recursive: true, force: true }); }
      return dto(q.one.get(id));
    },
    async download(owner, id, slot) {
      const row=owned(owner,id);
      try { await current(row.task_id,row.work_id,row.source_version); }
      catch(error) { if(error instanceof HttpError) { update(row,'failed',error.code,'source');rmSync(dirOf(id),{recursive:true,force:true}); } throw error; }
      return this.verifyDownload(owner,id,slot);
    },
    verifyDownload(owner, id, slot) {
      if (!['first', 'mobile'].includes(slot)) fail(404, '截图不存在', 'not_found');
      const row = owned(owner, id), info = JSON.parse(row.outputs)[slot];
      const spec=JSON.parse(row.spec),work=workNow(row.task_id,row.work_id);
      if(sourceStamp(work)!==spec.sourceStamp) fail(409,'作品源版本已改变','source_changed');
      // Metadata only; full byte hashing already finished asynchronously before open.
      try { for(const [relative,expected] of spec.manifest) {
          const file=resolve(work.dir,relative);
          if(file!==resolve(work.dir)&&!file.startsWith(resolve(work.dir)+sep)) fail(409,'源文件结构无效','source_changed');
          const actual=lstatSync(file);
          if(actual.isSymbolicLink()||JSON.stringify(statStamp(actual))!==JSON.stringify(expected)) fail(409,'作品源版本已改变','source_changed');
        }
      } catch(error) { if(error instanceof HttpError) throw error; fail(409,'源文件不可用或已改变','source_changed'); }
      if (!info || !['succeeded', 'partial'].includes(row.state)) fail(404, '截图尚未生成', 'not_found');
      const file = join(dirOf(row.id), `${slot}.jpg`);
      try { const actual=lstatSync(file); if (actual.isSymbolicLink() || realpathSync(file) !== file || actual.size !== info.bytes || JSON.stringify(statStamp(actual))!==JSON.stringify(info.fingerprint)) fail(404, '截图不可用', 'not_found'); }
      catch(error) { if(error instanceof HttpError) throw error; fail(404,'截图不可用','not_found'); }
      return { file, size: info.bytes, type: 'image/jpeg', filename: `${row.id}-${slot}.jpg` };
    },
    async close() { closed = true; clearInterval(sweep); for (const controller of active.values()) controller.abort(); for (const id of pending.splice(0)) { const row = q.one.get(id); if (row) update(row, 'failed', 'service_stopped', 'queue'); } await draining; },
  };
}
