import { fail } from './http.mjs';

export const GENERATION_FIELDS = ['generationMode', 'humanIntervention'];
export const IGNORED_GENERATION_FIELDS = ['modelVersion', 'generatedOn', 'evidenceUrl'];
export const GENERATION_MODES = ['single-turn', 'multi-turn'];
export const HUMAN_INTERVENTIONS = ['none', 'prompt-guided', 'code-edited'];
export const generationOf = (work) => ({
  generationMode: work.generationMode === 'agent' ? 'single-turn' : work.generationMode ?? '',
  humanIntervention: work.humanIntervention ?? '',
});

// Missing keys preserve existing values; an empty string explicitly clears a field.
export function generationFrom(body, current = {}) {
  const next = generationOf(current);
  for (const key of GENERATION_FIELDS) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string') fail(400, '生成信息须为文本', 'invalid_generation');
    next[key] = body[key].trim();
  }
  if (Object.hasOwn(body, 'generationMode') && next.generationMode && !GENERATION_MODES.includes(next.generationMode)) fail(400, '生成方式无效', 'invalid_generation');
  if (next.humanIntervention && !HUMAN_INTERVENTIONS.includes(next.humanIntervention)) fail(400, '人工介入程度无效', 'invalid_generation');
  return next;
}

export function generationAudit(before, after) {
  const changes = Object.fromEntries(GENERATION_FIELDS.filter((key) => (before[key] ?? '') !== after[key])
    .map((key) => [key, { from: before[key] ?? '', to: after[key] }]));
  return Object.keys(changes).length ? `；生成信息 ${JSON.stringify(changes)}` : '';
}

// Keep stored audit evidence intact while hiding retired structured fields on reads.
export function generationAuditView(detail) {
  const marker = '；生成信息 ';
  const at = detail.lastIndexOf(marker);
  const json = at >= 0 ? detail.slice(at + marker.length) : detail;
  if (!json.startsWith('{')) return detail;
  try {
    const value = JSON.parse(json, (key, item) => IGNORED_GENERATION_FIELDS.includes(key) ? undefined : item);
    if (at < 0) return JSON.stringify(value);
    return detail.slice(0, at) + (Object.keys(value).length ? marker + JSON.stringify(value) : '');
  } catch { return detail; }
}
