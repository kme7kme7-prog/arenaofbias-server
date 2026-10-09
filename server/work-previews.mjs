import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const FILES = { model: 'preview.sbox', poster: 'preview.webp', capture: 'preview.jpg' };
const fileHashes = new Map();

function fileInside(directory, name) {
  if (typeof name !== 'string' || !name) return null;
  const base = resolve(directory), file = resolve(base, name);
  return file.startsWith(`${base}${sep}`) ? file : null;
}

function sha256(file) {
  try {
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    // Windows ctime is creation time. Recent POSIX writes can share one
    // timestamp tick, so cache only files that have been quiet for a second.
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = fileHashes.get(file);
    const cacheable = process.platform !== 'win32' && BigInt(Date.now()) * 1_000_000n - stat.ctimeNs >= 1_000_000_000n;
    if (cacheable && cached?.signature === signature) return cached.digest;
    if (!cacheable) fileHashes.delete(file);
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (cacheable) {
      fileHashes.set(file, { signature, digest });
      if (fileHashes.size > 4096) fileHashes.delete(fileHashes.keys().next().value);
    }
    return digest;
  } catch {
    return null;
  }
}

function matchesHash(file, expected) {
  return HASH.test(expected ?? '') && sha256(file) === expected;
}

function mediaUrl(id, name, version) {
  return `media/${id}/${name}?v=${version}`;
}

export function readWorkPreview(mediaDir, work) {
  if (!work || work.curated || !/^up-[a-z0-9]{8}$/.test(work.id ?? '')) return null;
  const entry = fileInside(work.dir, work.entry);
  if (!entry) return null;

  try {
    const directory = fileInside(mediaDir, work.id);
    if (!directory) return null;
    const manifestPath = fileInside(directory, 'preview.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const sourceDigest = sha256(entry);
    if (manifest.schemaVersion !== 1 || !HASH.test(manifest.sourceDigest ?? '') || manifest.sourceDigest !== sourceDigest) return null;
    const capture = manifest.capture === FILES.capture && matchesHash(fileInside(directory, FILES.capture), manifest.captureSha)
      ? { previewCapture: mediaUrl(work.id, FILES.capture, `${sourceDigest.slice(0, 12)}-${manifest.captureSha.slice(0, 12)}`) }
      : null;

    if (manifest.mode === 'model' && manifest.model === FILES.model && manifest.poster === FILES.poster) {
      const model = fileInside(directory, FILES.model), poster = fileInside(directory, FILES.poster);
      if (!matchesHash(model, manifest.modelSha) || !matchesHash(poster, manifest.posterSha)) return null;
      const version = `${sourceDigest.slice(0, 12)}-${manifest.modelSha.slice(0, 12)}-${manifest.posterSha.slice(0, 12)}`;
      return {
        previewMode: 'model',
        previewModel: mediaUrl(work.id, FILES.model, version),
        previewPoster: mediaUrl(work.id, FILES.poster, version),
        ...capture,
      };
    }

    if (manifest.mode === 'screenshot' && capture) {
      return { previewMode: 'screenshot', ...capture };
    }
  } catch {
    return null;
  }
  return null;
}
