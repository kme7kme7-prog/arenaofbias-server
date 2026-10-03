// Upload inspection: unpacks a ZIP, takes HTML or renders text, rejects unsafe archives,
// finds the entry page and checks what it references. Nothing from the upload is executed.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import * as zlib from 'node:zlib';
import { fail, formatBytes } from './http.mjs';
import { renderTextUpload } from './text.mjs';
import { THREE_MIRROR_PATH } from './config.mjs';

const JUNK = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const IGNORED = /(^|\/)(node_modules|\.git|\.svn|\.hg)(\/|$)/i;
const FORBIDDEN = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function decodeName(bytes, utf8) {
  if (utf8) return bytes.toString('utf8');
  // Archives made by Windows' built-in zip store names in the system code page (GBK on Chinese systems).
  for (const encoding of ['utf-8', 'gbk']) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { /* try the next one */ }
  }
  return bytes.toString('latin1');
}

function cleanPath(raw) {
  const name = raw.replace(/\\/g, '/');
  const isDir = name.endsWith('/');
  const parts = name.split('/');
  if (isDir) parts.pop();
  const unsafe = name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name) || name.length > 240
    || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>:"|?*]/.test(part) || WINDOWS_RESERVED.test(part));
  if (unsafe) fail(400, `压缩包含有不安全或无法保存的路径：${raw.slice(0, 80)}`);
  return { path: parts.join('/'), isDir };
}

export function readZip(buffer, limits) {
  const b = buffer;
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail(400, '文件不是有效的 ZIP 压缩包');
  if (b.readUInt16LE(eocd + 4) || b.readUInt16LE(eocd + 6)) fail(400, '不支持分卷 ZIP');
  const count = b.readUInt16LE(eocd + 10);
  const size = b.readUInt32LE(eocd + 12);
  const offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail(400, '不支持 ZIP64 格式，请减少文件数量后重新打包');
  if (offset + size > eocd) fail(400, 'ZIP 目录已损坏');

  const files = new Map();
  const seen = new Set();
  let total = 0;
  let ignored = 0;
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || b.readUInt32LE(p) !== 0x02014b50) fail(400, 'ZIP 目录已损坏');
    const madeBy = b.readUInt16LE(p + 4) >> 8;
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const packedSize = b.readUInt32LE(p + 20);
    const rawSize = b.readUInt32LE(p + 24);
    const nameLength = b.readUInt16LE(p + 28);
    const extraLength = b.readUInt16LE(p + 30);
    const commentLength = b.readUInt16LE(p + 32);
    const external = b.readUInt32LE(p + 38);
    const local = b.readUInt32LE(p + 42);
    const raw = decodeName(b.subarray(p + 46, p + 46 + nameLength), flags & 0x800);
    p += 46 + nameLength + extraLength + commentLength;

    const { path, isDir } = cleanPath(raw);
    if (isDir || JUNK.test(path)) continue;
    if (IGNORED.test(path)) { ignored++; continue; }
    if (FORBIDDEN.test(path)) fail(400, `请移除 ${path}：压缩包不能包含密钥文件`);
    if (madeBy === 3 && ((external >>> 16) & 0xf000) === 0xa000) fail(400, `不支持符号链接：${path}`);
    if (flags & 1) fail(400, '不支持加密的 ZIP');
    if (method !== 0 && method !== 8) fail(400, `不支持的压缩方式：${path}（请使用标准 ZIP）`);
    if (rawSize === 0xffffffff || packedSize === 0xffffffff || local === 0xffffffff) fail(400, '不支持 ZIP64 格式');
    const lower = path.toLowerCase();
    if (seen.has(lower)) fail(400, `压缩包内有重复的文件：${path}`);
    seen.add(lower);
    if (files.size >= limits.files) fail(413, `文件数量超过 ${limits.files} 个上限`);
    if (rawSize > limits.fileBytes) fail(413, `单个文件超过 ${formatBytes(limits.fileBytes)}：${path}`);
    total += rawSize;
    if (total > limits.unpackedBytes) fail(413, `解压后超过 ${formatBytes(limits.unpackedBytes)} 上限`);
    if (rawSize > 1024 * 1024 && rawSize > Math.max(packedSize, 1) * 400) fail(400, `压缩比例异常：${path}`);

    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) fail(400, 'ZIP 数据已损坏');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + packedSize > b.length) fail(400, 'ZIP 数据已损坏');
    const packed = b.subarray(start, start + packedSize);
    let data;
    try {
      data = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, { maxOutputLength: rawSize + 1 });
    } catch {
      fail(400, `无法解压：${path}`);
    }
    if (data.length !== rawSize || (zlib.crc32 && zlib.crc32(data) >>> 0 !== crc)) fail(400, `文件校验失败：${path}`);
    files.set(path, data);
  }
  if (!files.size) fail(400, '压缩包里没有文件');
  // A file and a folder with the same name cannot both be written to disk.
  for (const path of files.keys()) {
    const parts = path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) fail(400, `压缩包内有同名的文件和文件夹：${parts.slice(0, i).join('/')}`);
    }
  }
  return { files, ignored };
}

// A folder zipped as a whole puts everything under one top-level directory; serve from inside it.
function stripWrapper(files) {
  for (let depth = 0; depth < 3; depth++) {
    const paths = [...files.keys()];
    if (paths.some((path) => !path.includes('/'))) break;
    const top = paths[0].split('/')[0];
    if (!paths.every((path) => path.startsWith(`${top}/`))) break;
    files = new Map([...files].map(([path, data]) => [path.slice(top.length + 1), data]));
  }
  return files;
}

function findEntry(files) {
  if (files.has('index.html')) return { root: '', entry: 'index.html' };
  for (const root of ['dist', 'build', 'out']) {
    if (files.has(`${root}/index.html`)) return { root, entry: 'index.html' };
  }
  const pages = [...files.keys()].filter((path) => !path.includes('/') && /\.html?$/i.test(path));
  if (pages.length === 1) return { root: '', entry: pages[0] };
  if (files.has('package.json')) fail(400, '这看起来是未构建的项目源码。请先运行构建（如 npm run build），把生成的 dist/ 一起打包后再上传。');
  fail(400, '找不到入口页面：压缩包根目录（或 dist/）需要有 index.html');
}

const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined)?.trim() ?? null;

// Resources the entry page loads: element sources, stylesheets and module specifiers.
function references(html) {
  const found = [];
  for (const [tag, name] of html.matchAll(/<(script|link|img|source|video|audio|iframe|embed|track)\b[^>]*>/gi)) {
    const kind = name.toLowerCase();
    if (kind === 'link') {
      const rel = (attribute(tag, 'rel') ?? '').toLowerCase();
      if (!/stylesheet|modulepreload|preload|icon|manifest/.test(rel)) continue;
      const href = attribute(tag, 'href');
      if (href) found.push({ url: href, critical: rel.includes('stylesheet') });
    } else {
      const src = attribute(tag, 'src');
      if (src) found.push({ url: src, critical: kind === 'script' });
      if (kind === 'video') { const poster = attribute(tag, 'poster'); if (poster) found.push({ url: poster, critical: false }); }
    }
  }
  for (const [, body] of html.matchAll(/<script\b[^>]*type\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const map = JSON.parse(body);
      for (const value of [...Object.values(map.imports ?? {}), ...Object.values(map.scopes ?? {}).flatMap(Object.values)]) {
        if (typeof value === 'string') found.push({ url: value, critical: true });
      }
    } catch { /* an invalid import map shows up during the trial load */ }
  }
  for (const [, body] of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const match of body.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bfetch\s*\(\s*)["'`]((?:https?:)?\/\/[^"'`\s]+)["'`]/g)) {
      found.push({ url: match[1], critical: true });
    }
  }
  return found;
}

const hostOf = (url) => { try { return new URL(url, 'https://local.invalid/').host; } catch { return ''; } };

export function inspectUpload(buffer, filename, { limits, cdn, template }) {
  if (!buffer.length) fail(400, '文件是空的');
  const textUpload = template === 'text' ? renderTextUpload(buffer, filename) : null;
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  const isHtml = !isZip && (/\.html?$/i.test(filename) || /^\s*(<!doctype html|<html|<head|<body|<meta|<script|<!--)/i.test(buffer.subarray(0, 512).toString('utf8').replace(/^﻿/, '')));
  if (!textUpload && !isZip && !isHtml) fail(400, '请上传 ZIP 压缩包或单个 HTML 文件');

  const archive = textUpload ? { files: textUpload.files, ignored: 0 } : isZip ? readZip(buffer, limits) : { files: new Map([['index.html', buffer]]), ignored: 0 };
  const files = stripWrapper(archive.files);
  const builtRoot = (template === 'vite' || (!template && files.has('package.json')))
    && ['dist', 'build', 'out'].find((dir) => files.has(`${dir}/index.html`));
  const { root, entry } = builtRoot ? { root: builtRoot, entry: 'index.html' } : findEntry(files);
  const served = new Map([...files].filter(([path]) => !root || path.startsWith(`${root}/`)).map(([path, data]) => [root ? path.slice(root.length + 1) : path, data]));
  const entryData = served.get(entry);
  const html = entryData.toString('utf8');
  if (!/<(html|head|body|script|canvas|div|main|svg|h1|p|style)\b/i.test(html)) fail(400, `${entry} 不是可以识别的网页入口`);

  const checks = [];
  const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
  checks.push({ id: 'format', state: 'ok', label: '文件格式', detail: textUpload ? `识别为 ${textUpload.isMarkdown ? 'Markdown' : '纯文本'} · 约 ${textUpload.characters.toLocaleString('en-US')} 字 · ${formatBytes(buffer.length)}` : isZip ? `ZIP · ${files.size} 个文件 · 解压后 ${formatBytes(bytes)}` : `单个 HTML · ${formatBytes(bytes)}` });
  if (archive.ignored) checks.push({ id: 'ignored', state: 'info', label: '依赖目录', detail: `已忽略 ${archive.ignored} 个依赖或版本库文件（node_modules、.git 等）` });
  checks.push({ id: 'entry', state: 'ok', label: '入口页面', detail: root ? `${root}/${entry}（以 ${root}/ 作为站点根目录）` : entry });

  const missingCritical = [];
  const missingOther = [];
  const external = new Set();
  const cdnHosts = new Set();
  let local = 0;
  for (const { url, critical } of references(html)) {
    if (!url || /^(data:|blob:|javascript:|mailto:|#|about:)/i.test(url) || /\{\{|<%|\$\{/.test(url)) continue;
    if (/^(https?:)?\/\//i.test(url)) {
      const host = hostOf(url);
      if (!host) continue;
      if (host === 'cdn.jsdelivr.net' && new URL(url, 'https://local.invalid/').pathname.startsWith('/gh/')) external.add('cdn.jsdelivr.net/gh');
      else if (host === 'registry.npmmirror.com' && !new URL(url, 'https://local.invalid/').pathname.startsWith(THREE_MIRROR_PATH)) external.add('registry.npmmirror.com（仅允许 Three.js 0.170.0）');
      else (cdn.includes(host) ? cdnHosts : external).add(host);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    let clean = url.split(/[?#]/)[0];
    try { clean = decodeURIComponent(clean); } catch { /* keep as written */ }
    if (!clean) continue;
    const target = posix.normalize(clean.startsWith('/') ? clean.slice(1) : posix.join(posix.dirname(entry), clean));
    local++;
    // A single HTML file carries nothing else, so a missing reference there is usually a stray
    // tag beside inlined code; the trial load shows whether the page still works.
    if (!served.has(target) && !served.has(posix.join(target, 'index.html'))) (critical && isZip ? missingCritical : missingOther).push(clean);
  }
  if (missingCritical.length) fail(400, `入口页面引用的脚本或样式不存在：${missingCritical.slice(0, 4).join('、')}`);
  checks.push(missingOther.length
    ? { id: 'local', state: 'warn', label: '本地资源', detail: `有 ${missingOther.length} 个引用的文件不存在：${missingOther.slice(0, 3).join('、')}` }
    : { id: 'local', state: 'ok', label: '本地资源', detail: local ? `入口引用的 ${local} 个本地文件都在` : '入口没有引用其他本地文件' });
  // A text page escapes everything the author wrote; its only external address is the platform's KaTeX.
  if (textUpload) {
    checks.push({ id: 'external', state: 'ok', label: '外部资源', detail: textUpload.math ? '公式由平台加载 KaTeX 显示，正文不引用外部地址' : '未引用外部地址，作品可以独立运行' });
  } else if (external.size) {
    checks.push({ id: 'external', state: 'warn', label: '外部资源', detail: `引用了 ${[...external].slice(0, 3).join('、')}，平台会拦截这些地址。请把依赖打包进作品。` });
  } else if (cdnHosts.size) {
    checks.push({ id: 'external', state: 'info', label: '外部资源', detail: `使用公共 CDN：${[...cdnHosts].join('、')}。这些依赖不在平台内，将来可能失效。` });
  } else {
    checks.push({ id: 'external', state: 'ok', label: '外部资源', detail: '未引用外部地址，作品可以独立运行' });
  }
  // A text upload is the work itself; a README only makes sense beside a page.
  const readme = [...files.keys()].find((path) => /^readme\.md$/i.test(path));
  if (!textUpload) checks.push({ id: 'readme', state: readme ? 'ok' : 'info', label: '说明文件', detail: readme ? '包含 README.md' : '未包含 README.md（选填）' });

  const digest = sha256([...files.keys()].sort().map((path) => `${path}\0${sha256(files.get(path))}`).join('\n'));
  return { files, root, entry, count: files.size, bytes, digest, entryDigest: sha256(entryData), checks, kind: textUpload ? 'text' : isZip ? 'zip' : 'html' };
}
