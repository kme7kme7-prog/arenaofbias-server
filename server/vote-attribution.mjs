import { effortKey, entityKey, modelKey } from './catalog.mjs';

// Correct labels only for the same uploaded bytes. Package identities stay versioned.
export function uploadAttribution(identity, work) {
  if (!identity || !work || work.curated || identity.id !== work.id || identity.taskId !== work.taskId
    || !identity.digest || identity.digest !== work.digest) return null;
  const fields = ['modelId', 'modelName', 'vendor', 'effort'];
  if (fields.every((field) => (identity[field] ?? '') === (work[field] ?? ''))) return null;
  const next = { ...identity, ...Object.fromEntries(fields.map((field) => [field, work[field]])) };
  return { ...next, effortKey: effortKey(next.effort), modelKey: modelKey(next), configKey: entityKey(next) };
}
