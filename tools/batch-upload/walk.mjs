// Read only ordinary files inside an explicit allow-root. Symlinks and hard links are refused.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REFUSED = /(^|\/)(\.env(\.[^/]*)?|\.git|\.ssh|\.npmrc|\.pypirc|id_rsa|id_ed25519|[^/]+\.pem)$/i;

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

function openChecked(absolute) {
  let fd;
  try { fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP') refuse('拒绝符号链接');
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse('只接受普通文件');
    if (stat.nlink > 1) refuse('拒绝硬链接');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

// Walk one relative directory. Hidden names and credential names abort the command.
// Nothing outside `root` is opened, including to look for secrets.
export function readTree(root, relativeDir) {
  const { base, absolute } = assertInside(root, join(root, relativeDir));
  const top = lstatSync(absolute);
  if (top.isSymbolicLink()) refuse('拒绝符号链接');
  if (!top.isDirectory()) refuse('作品目录无效');
  const files = [];
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
      const real = realpathSync(full);
      const within = relative(base, real);
      if (within.startsWith('..') || resolve(base, within) !== real) refuse('路径超出允许的根目录');
      const data = openChecked(full);
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
