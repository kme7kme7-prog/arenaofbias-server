// Transfer only changed datapack files when downloading a full release is too slow.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const safe = (name) => typeof name === 'string' && name !== '' && !name.includes('\\') &&
  name.split('/').every((part) => part && part !== '.' && part !== '..');

export function inventory(root) {
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split(sep).join('/');
        files[name] = sha(readFileSync(path));
      } else throw new Error(`Unsupported datapack entry: ${path}`);
    }
  }
  visit(root);
  return files;
}

export function treeHash(files) {
  return sha(Buffer.from(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, digest]) => `${name}\0${digest}\n`).join('')));
}

export function createDelta(oldRoot, newRoot, archive) {
  const before = inventory(oldRoot), after = inventory(newRoot);
  const changed = {};
  for (const [name, digest] of Object.entries(after)) if (before[name] !== digest)
    changed[name] = readFileSync(join(newRoot, name)).toString('base64');
  const removed = Object.keys(before).filter((name) => !(name in after));
  const delta = { format: 1, base: treeHash(before), target: treeHash(after), files: after, changed, removed };
  writeFileSync(archive, gzipSync(JSON.stringify(delta)));
  return { changed: Object.keys(changed).length, removed: removed.length, base: delta.base, target: delta.target };
}

function readDelta(archive) {
  const delta = JSON.parse(gunzipSync(readFileSync(archive)));
  if (delta.format !== 1 || !/^[a-f0-9]{64}$/.test(delta.base) || !/^[a-f0-9]{64}$/.test(delta.target)) throw new Error('Invalid delta');
  if (!Object.keys(delta.files).every(safe) || !Object.keys(delta.changed).every(safe) || !delta.removed.every(safe)) throw new Error('Unsafe delta path');
  return delta;
}

export function verifyDelta(root, archive) {
  const delta = readDelta(archive);
  const files = inventory(root);
  if (treeHash(files) !== delta.target)
    throw new Error('Datapack tree checksum mismatch; activation refused');
  return delta.target;
}

export function applyDelta(oldRoot, archive, targetRoot) {
  const delta = readDelta(archive);
  if (existsSync(targetRoot)) throw new Error('Target release already exists');
  const sourceRoot = realpathSync(oldRoot);
  if (treeHash(inventory(sourceRoot)) !== delta.base) throw new Error('Base datapack checksum mismatch');
  const stage = join(dirname(targetRoot), `.${basename(targetRoot)}.delta-${process.pid}`);
  if (existsSync(stage)) throw new Error('Delta staging directory already exists');
  try {
    mkdirSync(dirname(targetRoot), { recursive: true });
    cpSync(sourceRoot, stage, { recursive: true, errorOnExist: true, force: false });
    for (const name of delta.removed) rmSync(join(stage, name));
    for (const [name, encoded] of Object.entries(delta.changed)) {
      const bytes = Buffer.from(encoded, 'base64');
      if (sha(bytes) !== delta.files[name]) throw new Error(`Changed file checksum mismatch: ${name}`);
      const path = join(stage, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    if (treeHash(inventory(stage)) !== delta.target) throw new Error('Datapack tree checksum mismatch; activation refused');
    renameSync(stage, targetRoot);
    return delta.target;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b, c] = process.argv.slice(2);
  if (command === 'create' && a && b && c) console.log(JSON.stringify(createDelta(resolve(a), resolve(b), resolve(c))));
  else if (command === 'apply' && a && b && c) console.log(applyDelta(resolve(a), resolve(b), resolve(c)));
  else if (command === 'verify' && a && b && !c) console.log(verifyDelta(resolve(a), resolve(b)));
  else throw new Error('Usage: datapack-delta.mjs create <old> <new> <delta.gz> | apply <old> <delta.gz> <target> | verify <target> <delta.gz>');
}
