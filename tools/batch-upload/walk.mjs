// Read only ordinary files inside an explicit allow-root. Symlinks and hard links are refused.
// Metadata reads and writes use the same checks. Writes go to a new file and replace the
// directory entry with rename, so an existing path is never opened with O_TRUNC.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LOCAL_LIMITS } from './limits.mjs';

const REFUSED = /(^|\/)(\.env(\.[^/]*)?|\.git|\.ssh|\.npmrc|\.pypirc|id_rsa|id_ed25519|[^/]+\.pem)$/i;
// Windows does not define O_NOFOLLOW. The lstat plus fstat identity check is the fallback.
const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

function refuse(message) {
  const error = new Error(message);
  error.code = 'local_refused';
  throw error;
}

export function realRoot(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) refuse('允许根不能是符号链接');
  if (!stat.isDirectory()) refuse('允许根必须是目录');
  return realpathSync(root);
}

export function assertInside(root, target) {
  const base = realRoot(root);
  const absolute = resolve(target);
  const rel = relative(base, absolute);
  if (rel.startsWith('..') || resolve(base, rel) !== absolute) refuse('路径超出允许的根目录');
  return { base, absolute, rel: rel.split(sep).join('/') };
}

// The batch directory itself must be a real directory inside the allow root.
export function openBatch(allowRoot, dir) {
  const located = assertInside(allowRoot, resolve(dir));
  const stat = lstatSync(located.absolute);
  if (stat.isSymbolicLink()) refuse('拒绝符号链接');
  if (!stat.isDirectory()) refuse('批次目录无效');
  const real = realpathSync(located.absolute);
  const rel = relative(located.base, real);
  if (rel.startsWith('..') || resolve(located.base, rel) !== real) refuse('路径超出允许的根目录');
  return { root: located.base, batchDir: real };
}

function contained(rootReal, absolute) {
  const real = realpathSync(absolute);
  const rel = relative(rootReal, real);
  if (!rel || rel.startsWith('..') || resolve(rootReal, rel) !== real) refuse('路径超出允许的根目录');
  return real;
}

function openChecked(absolute, maxBytes) {
  const before = lstatSync(absolute);
  if (before.isSymbolicLink()) refuse('拒绝符号链接');
  if (!before.isFile()) refuse('只接受普通文件');
  if (before.nlink > 1) refuse('拒绝硬链接');
  if (maxBytes != null && before.size > maxBytes) refuse('单个文件超过上限');
  let fd;
  try { fd = openSync(absolute, constants.O_RDONLY | NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') refuse('拒绝符号链接');
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) refuse('只接受普通文件');
    if (stat.ino !== before.ino || stat.dev !== before.dev) refuse('拒绝符号链接');
    if (maxBytes != null && stat.size > maxBytes) refuse('单个文件超过上限');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

const LOCAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function metadataPath(directory, name) {
  if (typeof name !== 'string' || !LOCAL_NAME.test(name) || name.includes('..')) refuse('路径无效');
  let dirStat;
  try { dirStat = lstatSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') {
      const missing = new Error('路径无效');
      missing.code = 'ENOENT';
      throw missing;
    }
    throw error;
  }
  if (dirStat.isSymbolicLink()) refuse('拒绝符号链接');
  if (!dirStat.isDirectory()) refuse('批次目录无效');
  const realDir = realpathSync(directory);
  const absolute = join(realDir, name);
  if (relative(realDir, absolute) !== name || dirname(absolute) !== realDir) refuse('路径无效');
  return { realDir, absolute };
}

// Read one named file directly inside a directory. A symlink, hard link, or
// non-file is refused before the contents are read. The byte cap is checked on
// lstat and again on the opened descriptor.
export function readLocalFile(directory, name, maxBytes = LOCAL_LIMITS.maxMetadataBytes) {
  const { realDir, absolute } = metadataPath(directory, name);
  let before;
  try { before = lstatSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (name === 'plan.json') {
        const missing = new Error('请先执行 plan');
        missing.code = 'local_refused';
        throw missing;
      }
      if (name === 'manifest.json') {
        const missing = new Error('manifest.json 无效');
        missing.code = 'local_refused';
        throw missing;
      }
      const missing = new Error('路径无效');
      missing.code = 'ENOENT';
      throw missing;
    }
    throw error;
  }
  if (before.isSymbolicLink()) refuse('拒绝符号链接');
  if (!before.isFile()) refuse('只接受普通文件');
  if (before.nlink > 1) refuse('拒绝硬链接');
  if (!Number.isSafeInteger(before.size) || before.size > maxBytes) refuse('文件超过本地大小上限');
  const real = contained(realDir, absolute);
  if (real !== absolute) refuse('路径超出允许的根目录');
  return openChecked(absolute, maxBytes);
}

function assertReplaceable(absolute) {
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) refuse('拒绝符号链接');
  if (!stat.isFile()) refuse('只接受普通文件');
  if (stat.nlink > 1) refuse('拒绝硬链接');
  const real = realpathSync(absolute);
  if (real !== absolute) refuse('路径超出允许的根目录');
}

// Create a new regular file and rename it over the destination. rename does not
// follow a symlink that appears at the destination. The destination is never
// opened for writing, so a FIFO or an unexpected file is not truncated in place.
export function writeAtomicFile(directory, name, contents) {
  if (name !== 'plan.json') refuse('路径无效');
  const { realDir, absolute } = metadataPath(directory, name);
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (body.length > LOCAL_LIMITS.maxMetadataBytes) refuse('文件超过本地大小上限');
  assertReplaceable(absolute);
  const tmpName = `.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const tmp = join(realDir, tmpName);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EEXIST' || error.code === 'EMLINK') refuse('拒绝符号链接');
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) refuse('只接受普通文件');
    writeFileSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed or refused */ }
    fd = null;
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
  try {
    assertReplaceable(absolute);
    renameSync(tmp, absolute);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw error;
  }
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY || 0);
    const dirFd = openSync(realDir, flags);
    try { fsyncSync(dirFd); } catch { /* durability is best-effort */ }
    finally { closeSync(dirFd); }
  } catch { /* some platforms cannot fsync a directory */ }
}

// Walk one relative directory. Hidden names and credential names abort the command.
// Nothing outside `root` is opened, including to look for secrets. File bytes are
// not read once stat.size is already over the caller's budget.
export function readTree(root, relativeDir, budget = {}) {
  const maxFileBytes = budget.maxFileBytes ?? LOCAL_LIMITS.maxFileBytes;
  const maxFiles = budget.maxFiles ?? LOCAL_LIMITS.maxFilesPerWork;
  const maxWorkBytes = budget.maxWorkBytes ?? LOCAL_LIMITS.maxWorkExpanded;
  const maxBatchBytes = budget.maxBatchBytes ?? LOCAL_LIMITS.maxExpanded;
  const { base, absolute } = assertInside(root, join(root, relativeDir));
  const top = lstatSync(absolute);
  if (top.isSymbolicLink()) refuse('拒绝符号链接');
  if (!top.isDirectory()) refuse('作品目录无效');
  const files = [];
  let total = 0;
  const pending = [''];
  while (pending.length) {
    const dir = pending.pop();
    const current = join(absolute, dir);
    for (const name of readdirSync(current)) {
      if (!name || name === '.' || name === '..') refuse('路径无效');
      const rel = dir ? `${dir}/${name}` : name;
      if (name.startsWith('.') || REFUSED.test(rel)) refuse(`拒绝读取 ${rel}`);
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) refuse(`拒绝符号链接 ${rel}`);
      if (stat.isDirectory()) {
        if (name === 'node_modules') refuse('拒绝读取 node_modules');
        pending.push(rel);
        continue;
      }
      if (!stat.isFile() || stat.isFIFO() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice()) {
        refuse(`拒绝非常规文件 ${rel}`);
      }
      if (stat.nlink > 1) refuse(`拒绝硬链接 ${rel}`);
      if (files.length >= maxFiles) refuse('单件作品超过上传上限');
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) refuse('文件大小无效');
      if (stat.size > maxFileBytes) refuse('单个文件超过上限');
      if (total + stat.size > maxWorkBytes) refuse('单件作品超过上传上限');
      if (total + stat.size > maxBatchBytes) refuse('这批作品的解压体积超过上限');
      const real = realpathSync(full);
      const within = relative(base, real);
      if (within.startsWith('..') || resolve(base, within) !== real) refuse('路径超出允许的根目录');
      const room = Math.min(maxFileBytes, maxWorkBytes - total, maxBatchBytes - total);
      const data = openChecked(full, room);
      total += data.length;
      if (data.length > maxFileBytes) refuse('单个文件超过上限');
      if (total > maxWorkBytes) refuse('单件作品超过上传上限');
      if (total > maxBatchBytes) refuse('这批作品的解压体积超过上限');
      files.push({
        path: rel.normalize('NFC').split(sep).join('/'),
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        data,
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
