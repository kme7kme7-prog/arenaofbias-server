// Single source of truth lives with the CLI so the standalone zip can import it.
// The server and the tests use this re-export; do not copy the canonicalizer.
export {
  DROPPED_FIELDS,
  canonicalPlan,
  normalizeBatchId,
  normalizeWorkKey,
  planDigest,
} from '../tools/batch-upload/plan.mjs';
