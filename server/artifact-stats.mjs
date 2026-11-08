// A fixed length ruler, not a model's billing tokenizer. No I/O or dependencies.
import { extname } from 'node:path';

export const ARTIFACT_TOKENIZER = 'utf8-pretoken-4-v1';
const excludedDirectories = new Set(['node_modules', 'bower_components', 'vendor', 'vendors', 'third-party', 'third_party', 'thirdparty',
  'dist', 'build', 'out', 'target', 'coverage', '.git', '.cache', '.next', '.nuxt', '.output', '.svelte-kit', '.venv', 'venv', '__pycache__', '_captures']);
const extensions = new Set(['.txt', '.md', '.markdown', '.mdx', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.py', '.rb', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.sql', '.vue', '.svelte', '.glsl', '.wgsl', '.vert', '.frag']);
const locks = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock']);

export function shouldCountArtifactFile(path) {
  const parts = String(path).replaceAll('\\', '/').toLowerCase().split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || excludedDirectories.has(p))) return false;
  const name = parts.at(-1);
  return extensions.has(extname(name)) && !locks.has(name) && !name.endsWith('.lock')
    && !/\.(?:min|bundle)\.(?:js|mjs|css)$/.test(name)
    && !/^(?:three(?:\..+)?|react(?:-dom)?(?:\..+)?|vue(?:\..+)?|d3(?:\..+)?|chart(?:\..+)?|babylon(?:\..+)?)\.js$/.test(name);
}

export function countArtifactTokens(text) {
  // Split letter runs, 1–3 digits, punctuation and whitespace, then count 4-byte chunks.
  return [...text.matchAll(/\p{L}+|\p{N}{1,3}|[^\s\p{L}\p{N}]+|\s+/gu)]
    .reduce((sum, [piece]) => sum + Math.ceil(Buffer.byteLength(piece, 'utf8') / 4), 0);
}

export function artifactStats(files, { kind = 'code' } = {}) {
  if (!['code', 'text'].includes(kind)) throw new TypeError('kind must be code or text');
  const result = { files: 0, lines: 0, bytes: 0, ...(kind === 'text' ? { chars: 0 } : { tokens: 0, tokenizer: ARTIFACT_TOKENIZER, approximate: true }) };
  const seen = new Set();
  for (const file of files) {
    if (file.generated || file.vendor || !shouldCountArtifactFile(file.path)) continue;
    // Writing submissions contain the original text plus a generated HTML viewer.
    if (kind === 'text' && !/\.(?:txt|md|markdown)$/i.test(file.path)) continue;
    const path = file.path.replaceAll('\\', '/');
    if (seen.has(path)) throw new TypeError('Duplicate artifact path');
    seen.add(path);
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) throw new TypeError('File content must be text or bytes');
    const bytes = Buffer.from(file.content);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) continue;
    result.files++;
    result.bytes += bytes.length;
    const lines = text.replace(/\r\n?/g, '\n');
    result.lines += lines ? lines.split('\n').length - Number(lines.endsWith('\n')) : 0;
    if (kind === 'text') result.chars += [...text.replace(/\s/gu, '')].length;
    else result.tokens += countArtifactTokens(text);
  }
  return result;
}
