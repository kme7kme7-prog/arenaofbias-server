import { effortKey, entityKey, modelKey } from './catalog.mjs';

// Relabel a saved vote side with the work's current admin-set attribution. Package
// works are matched by task and ID (admins correct them through display overrides);
// uploads also need the same bytes.
export function currentAttribution(identity, work) {
  if (!identity || !work || identity.id !== work.id || identity.taskId !== work.taskId) return null;
  if (!work.curated && (!identity.digest || identity.digest !== work.digest)) return null;
  const fields = ['modelId', 'modelName', 'vendor', 'effort'];
  if (fields.every((field) => (identity[field] ?? '') === (work[field] ?? ''))) return null;
  const next = { ...identity, ...Object.fromEntries(fields.map((field) => [field, work[field]])) };
  return { ...next, effortKey: effortKey(next.effort), modelKey: modelKey(next), configKey: entityKey(next) };
}

// Correct labels only for the same uploaded bytes. Package identities stay versioned.
export const uploadAttribution = (identity, work) => (work?.curated ? null : currentAttribution(identity, work));
