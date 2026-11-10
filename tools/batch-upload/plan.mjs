// Canonical batch plan. The CLI and the server both hash this form, so the digest a
// person confirms is the digest the upload is checked against. Privilege fields are
// dropped before hashing and are never stored.
import { createHash } from 'node:crypto';

export const DROPPED_FIELDS = ['pipeline', 'role', 'autoVerify', 'publish', 'show_gallery', 'show_arena', 'show_entertainment', 'moderation', 'verified', 'status', 'audience'];
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PATH = /^[^\\/\0][^\\\0]{0,239}$/;
// JSON.parse will not pollute Object.prototype, but these names still break
// plain-object maps (uploaded[key], for example) and are not real work keys.
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value, max) => String(value ?? '').normalize('NFC').trim().slice(0, max);

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`);
  return value;
}

export function normalizeWorkKey(value) {
  const key = text(value, 64);
  if (!KEY.test(key) || BLOCKED_KEYS.has(key)) throw new Error('作品键无效');
  return key;
}

export function normalizeBatchId(value) {
  const batch = text(value, 64);
  if (!KEY.test(batch) || BLOCKED_KEYS.has(batch)) throw new Error('批次编号无效');
  return batch;
}

function planFile(file) {
  const path = text(file?.path, 240).replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('计划中的文件路径无效');
  }
  if (!PATH.test(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('计划中的文件路径无效');
  const sha = String(file?.sha256 ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('计划中的文件摘要无效');
  return { path, size: integer(file?.size, '文件大小'), sha256: sha };
}

function planWork(work) {
  if (!work || typeof work !== 'object' || Array.isArray(work)) throw new Error('作品计划无效');
  const key = normalizeWorkKey(work.key);
  const task = text(work.task, 80);
  if (!task || task === '__new__') throw new Error('题目无效');
  const files = (Array.isArray(work.files) ? work.files : []).map(planFile)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.length) throw new Error('作品计划缺少文件');
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path.toLowerCase())) throw new Error('作品计划有重复文件');
    seen.add(file.path);
  }
  return {
    key,
    task,
    title: text(work.title, 40),
    summary: text(work.summary, 200),
    modelId: text(work.modelId, 80),
    modelName: text(work.modelName, 60),
    vendor: text(work.vendor, 40),
    effort: text(work.effort, 20),
    providerId: text(work.providerId, 40),
    harnessId: text(work.harnessId, 80),
    harnessOther: text(work.harnessOther, 40),
    generationMode: text(work.generationMode, 40),
    humanIntervention: text(work.humanIntervention, 40),
    promptVariant: text(work.promptVariant, 80),
    note: text(work.note, 1000),
    compressedBytes: integer(work.compressedBytes, '压缩大小'),
    files,
  };
}

// Fixed key order. Dropped privilege fields never enter this object.
export function canonicalPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('批次计划无效');
  const batch = normalizeBatchId(input.batch ?? input.batchId);
  const works = (Array.isArray(input.works) ? input.works : []).map(planWork)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!works.length) throw new Error('批次计划没有作品');
  const keys = new Set();
  for (const work of works) {
    if (keys.has(work.key)) throw new Error('作品键重复');
    keys.add(work.key);
  }
  return {
    batch,
    works,
    clientName: text(input.clientName, 40) || 'aob-batch',
  };
}

export function planDigest(plan) {
  const canonical = canonicalPlan(plan);
  const body = JSON.stringify({ batch: canonical.batch, works: canonical.works });
  return { plan: canonical, digest: sha256(body) };
}
