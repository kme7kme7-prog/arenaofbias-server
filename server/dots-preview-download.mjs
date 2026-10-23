// Read only the current, validated dots upload preview. Callers supply the
// works:read token fence; no client path, historic version or datapack is served.
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail, streamFile } from './http.mjs';
import { readWorkPreview } from './work-previews.mjs';

const MODEL = /^preview-[a-z0-9]{8,24}\.sbox$/;
const VERSION = /^preview-[a-z0-9]{8,24}\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const missing = () => fail(404, '当前上传预览不存在或已更新', 'not_found');

export function createDotsPreviewDownload({ library, previews }) {
  function current(params) {
    const work = library.work(params.task, params.id);
    if (!work || work.curated || !library.uploadById(work.id) || !/^up-[a-z0-9]{8}$/.test(work.id)) missing();
    const now = previews.current(work);
    const manifest = now.manifest;
    if (now.kind !== 'dots' || !VERSION.test(now.version ?? '') || manifest?.mode !== 'model'
      || !MODEL.test(manifest.model ?? '') || !HASH.test(manifest.modelSha ?? '')) missing();
    let file, signature, size;
    try {
      const root = realpathSync(library.mediaDir);
      const directory = join(root, work.id);
      // Generated media files are regular files. Reject aliases, including a
      // work directory or manifest symlink that points at another work.
      if (realpathSync(directory) !== directory || realpathSync(join(directory, 'preview.json')) !== join(directory, 'preview.json')) missing();
      file = join(directory, manifest.model);
      if (realpathSync(file) !== file) missing();
      const info = statSync(file, { bigint: true });
      if (!info.isFile()) missing();
      size = Number(info.size);
      signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch { missing(); }
    // Reuse the Gallery reader's source digest, schema and model/poster hash
    // checks: a preview for an older source is not the current upload preview.
    const visible = readWorkPreview(library.mediaDir, work);
    if (visible?.previewMode !== 'model' || visible.previewModel.split('?')[0] !== `media/${work.id}/${manifest.model}`) missing();
    return { file, size, signature, version: now.version, model: manifest.model, sha256: manifest.modelSha };
  }
  return {
    async handle({ req, res, params, checkAccess }) {
      checkAccess();
      if (new URL(req.url, 'http://localhost').searchParams.size) fail(400, '预览下载不接受查询参数', 'invalid_query');
      const found = current(params);
      return streamFile(req, res, found, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${found.model}"`,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'X-Preview-Version': found.version,
        'X-Preview-SHA256': found.sha256,
      }, { beforeSend() {
        checkAccess();
        const again = current(params);
        if (again.file !== found.file || again.signature !== found.signature || again.version !== found.version || again.sha256 !== found.sha256) missing();
      } });
    },
  };
}
