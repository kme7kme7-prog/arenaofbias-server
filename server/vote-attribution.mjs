import { effortKey, entityKey, modelKey, providerOf } from './catalog.mjs';

// Only identical content follows current attribution, for packages and uploads alike.
function currentAttribution(identity, work, digest = work?.digest) {
  if (!identity || !work || identity.id !== work.id || !identity.digest || identity.digest !== digest) return null;
  const next = { ...identity, modelId: work.modelId, modelName: work.modelName,
    vendor: work.vendor, effort: work.effort, harnessId: work.harnessId ?? null,
    providerId: providerOf(work.providerId, work.providerOther) };
  return { ...next, effortKey: effortKey(next.effort), modelKey: modelKey(next), configKey: entityKey(next) };
}

// Pre-marker manual corrections are identified by their audit, excluding reasons
// used by both generations of automatic work edits and vote submission.
export function manualCorrections(db) {
  const result = new Map();
  for (const row of db.prepare("SELECT detail FROM audit WHERE action = 'vote-identity-correction' ORDER BY id").all()) {
    const detail = JSON.parse(row.detail);
    if (['管理员更正作品的模型归属或档位', '管理员更正同一上传作品的模型归属或档位',
      '按作品已更正的模型归属或档位计票'].includes(detail.reason)) continue;
    if (detail.voteId && detail.side && detail.next) result.set(`${detail.voteId}/${detail.side}`, detail.next);
  }
  return result;
}

export function voteAttribution(row, side, identity, correction, work, snapshot, manual) {
  if (correction) {
    const explicit = correction.manual === true ? correction : manual.get(`${row.id}/${side}`);
    if (explicit) return explicit;
  }
  const digest = work?.curated ? snapshot?.entryDigest(work) : work?.digest;
  return currentAttribution(identity, work, digest) ?? identity;
}
