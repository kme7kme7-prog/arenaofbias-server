import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const FILES = { model: 'preview.sbox', poster: 'preview.webp', capture: 'preview.jpg' };

function fileInside(directory, name) {
  if (typeof name !== 'string' || !name) return null;
  const base = resolve(directory), file = resolve(base, name);
  return file.startsWith(`${base}${sep}`) ? file : null;
}

function sha256(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
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

    if (manifest.mode === 'model' && manifest.model === FILES.model && manifest.poster === FILES.poster) {
      const model = fileInside(directory, FILES.model), poster = fileInside(directory, FILES.poster);
      if (!matchesHash(model, manifest.modelSha) || !matchesHash(poster, manifest.posterSha)) return null;
      const version = `${sourceDigest.slice(0, 12)}-${manifest.modelSha.slice(0, 12)}-${manifest.posterSha.slice(0, 12)}`;
      return {
        previewMode: 'model',
        previewModel: mediaUrl(work.id, FILES.model, version),
        previewPoster: mediaUrl(work.id, FILES.poster, version),
      };
    }

    if (manifest.mode === 'screenshot' && manifest.capture === FILES.capture) {
      const capture = fileInside(directory, FILES.capture);
      if (!matchesHash(capture, manifest.captureSha)) return null;
      const version = `${sourceDigest.slice(0, 12)}-${manifest.captureSha.slice(0, 12)}`;
      return { previewMode: 'screenshot', previewCapture: mediaUrl(work.id, FILES.capture, version) };
    }
  } catch {
    return null;
  }
  return null;
}
