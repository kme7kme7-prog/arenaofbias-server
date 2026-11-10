// Local ceilings for the batch CLI. The numbers match the server pilot defaults
// (batchConfig with no BATCH_MAX_* override) and the ordinary upload caps.
// This tool does not read the server environment, so a deployment that changes
// BATCH_MAX_* can disagree with the CLI. docs/batch-upload.md says so.
export const LOCAL_LIMITS = {
  maxWorks: 10,
  maxCompressed: 100 * 1024 * 1024,
  maxExpanded: 300 * 1024 * 1024,
  maxWorkCompressed: 30 * 1024 * 1024,
  maxWorkExpanded: 150 * 1024 * 1024,
  maxFilesPerWork: 2000,
  maxFileBytes: 50 * 1024 * 1024,
  // manifest.json and plan.json are read and written in full. This is only a
  // memory bound for those two files, not the 100 / 300 MiB content quota.
  maxMetadataBytes: 16 * 1024 * 1024,
};

function fits(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function assertBatchTotals({ works, compressed, expanded }) {
  if (!Number.isSafeInteger(works) || works < 1) throw new Error('批次计划没有作品');
  if (works > LOCAL_LIMITS.maxWorks) throw new Error(`一批最多 ${LOCAL_LIMITS.maxWorks} 件作品`);
  if (!fits(compressed, LOCAL_LIMITS.maxCompressed)) throw new Error('这批作品的压缩体积超过上限');
  if (!fits(expanded, LOCAL_LIMITS.maxExpanded)) throw new Error('这批作品的解压体积超过上限');
}

export function assertWorkBudget({ compressed = 0, expanded = 0, files = 0, fileBytes = 0 } = {}) {
  if (!fits(compressed, LOCAL_LIMITS.maxWorkCompressed)
    || !fits(expanded, LOCAL_LIMITS.maxWorkExpanded)
    || !fits(files, LOCAL_LIMITS.maxFilesPerWork)) {
    throw new Error('单件作品超过上传上限');
  }
  if (!fits(fileBytes, LOCAL_LIMITS.maxFileBytes)) throw new Error('单个文件超过上限');
}
