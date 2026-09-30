import { fail } from './http.mjs';

export const GENERATION_FIELDS = ['modelVersion', 'generationMode', 'humanIntervention', 'generatedOn', 'evidenceUrl'];
export const GENERATION_MODES = ['single-turn', 'multi-turn', 'agent'];
export const HUMAN_INTERVENTIONS = ['none', 'prompt-guided', 'code-edited'];
export const generationOf = (work) => Object.fromEntries(GENERATION_FIELDS.map((key) => [key, work[key] ?? '']));

// Missing keys preserve existing values; an empty string explicitly clears a field.
export function generationFrom(body, current = {}) {
  const next = generationOf(current);
  for (const key of GENERATION_FIELDS) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string') fail(400, '生成信息须为文本', 'invalid_generation');
    next[key] = body[key].trim();
  }
  if (next.modelVersion.length > 60) fail(400, '模型版本不能超过 60 字', 'invalid_generation');
  if (next.generationMode && !GENERATION_MODES.includes(next.generationMode)) fail(400, '生成方式无效', 'invalid_generation');
  if (next.humanIntervention && !HUMAN_INTERVENTIONS.includes(next.humanIntervention)) fail(400, '人工介入程度无效', 'invalid_generation');
  if (next.generatedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(next.generatedOn) ||
    !Number.isFinite(Date.parse(next.generatedOn)) || new Date(next.generatedOn).toISOString().slice(0, 10) !== next.generatedOn))
    fail(400, '生成日期须为有效的 YYYY-MM-DD 日期', 'invalid_generation');
  if (next.evidenceUrl) {
    let url;
    try { url = new URL(next.evidenceUrl); } catch { /* handled below */ }
    if (next.evidenceUrl.length > 2000 || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      fail(400, '证据链接须为不含账号密码的 HTTP / HTTPS 地址', 'invalid_generation');
  }
  return next;
}

export function generationAudit(before, after) {
  const changes = Object.fromEntries(GENERATION_FIELDS.filter((key) => (before[key] ?? '') !== after[key])
    .map((key) => [key, { from: before[key] ?? '', to: after[key] }]));
  return Object.keys(changes).length ? `；生成信息 ${JSON.stringify(changes)}` : '';
}
