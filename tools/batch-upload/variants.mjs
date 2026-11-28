// Prompt-variant ids for local planning. The only source is
// GET https://api.arenaofbias.icu/api/catalog. Labels are shown in errors;
// the accepted manifest value is the variant id.
import { apiJson } from './http.mjs';

const CATALOG_ERROR = '无法读取官方题库，不能核对提示词版本';
const FIELD_ERROR = '官方题库没有提示词版本字段，不能核对 promptVariant';

const taskId = (value) => String(value ?? '').normalize('NFC').trim().slice(0, 80);
const oneLine = (value) => String(value ?? '').replace(/[\r\n]/g, ' ');

function choices(variants) {
  return variants.map((variant) => (variant.label ? `${variant.id}（${variant.label}）` : variant.id)).join('、');
}

export function variantsByTask(catalog) {
  const questions = catalog?.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error(CATALOG_ERROR);
  if (!questions.some((question) => question && typeof question === 'object' && !Array.isArray(question) && Object.hasOwn(question, 'promptVariants'))) {
    throw new Error(FIELD_ERROR);
  }
  const map = new Map();
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question) || typeof question.id !== 'string') throw new Error(CATALOG_ERROR);
    const id = taskId(question.id);
    if (!id || map.has(id)) throw new Error(CATALOG_ERROR);
    const raw = Object.hasOwn(question, 'promptVariants') && question.promptVariants != null ? question.promptVariants : [];
    if (!Array.isArray(raw)) throw new Error(CATALOG_ERROR);
    const variants = [];
    const seen = new Set();
    for (const variant of raw) {
      if (!variant || typeof variant !== 'object' || Array.isArray(variant) || typeof variant.id !== 'string') throw new Error(CATALOG_ERROR);
      const variantId = variant.id.normalize('NFC').trim();
      if (!variantId || seen.has(variantId)) throw new Error(CATALOG_ERROR);
      seen.add(variantId);
      const label = typeof variant.label === 'string' ? oneLine(variant.label.normalize('NFC').trim()) : '';
      variants.push({ id: variantId, label });
    }
    const title = typeof question.title === 'string' ? oneLine(question.title.normalize('NFC').trim()).slice(0, 80) : '';
    map.set(id, { title, variants });
  }
  return map;
}

// entry is the catalog row for this task, or undefined when the task is absent.
// Absent tasks and empty promptVariants lists do not add a requirement.
export function assertPromptVariant(task, rawValue, entry) {
  if (!entry || entry.variants.length === 0) return;
  const value = taskId(rawValue);
  const name = entry.title ? `${task}（${entry.title}）` : task;
  const guide = `请填写版本 id，不要填写标签。可用：${choices(entry.variants)}。`;
  if (!value) throw new Error(`题目 ${name} 缺少 promptVariant。${guide}`);
  if (!entry.variants.some((variant) => variant.id === value)) {
    throw new Error(`题目 ${name} 的 promptVariant「${oneLine(value)}」不是版本 id。${guide}`);
  }
}

export async function loadLiveVariants(request = apiJson) {
  let response;
  try { response = await request('GET', '/api/catalog'); }
  catch { throw new Error(CATALOG_ERROR); }
  const status = Number(response?.status);
  if (status !== 200) throw new Error(`${CATALOG_ERROR}${status ? `（${status}）` : ''}`);
  return variantsByTask(response.data);
}

export function assertPlanVariants(works, variants) {
  for (const work of works) {
    const task = taskId(work?.task);
    assertPromptVariant(task, work?.promptVariant, variants.get(task));
  }
}
