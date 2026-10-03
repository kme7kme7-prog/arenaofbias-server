// Reference images retain their compressed pixels while upload metadata is removed.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fail } from './http.mjs';
import { isStaff } from './roles.mjs';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const invalid = () => fail(400, '参考图文件无效，请上传 JPEG、PNG 或 WebP 图片');
const dimensions = (width, height) => { if (!width || !height) invalid(); return { width, height }; };

function cleanPng(input) {
  const parts = [pngSignature];
  let offset = 8, size = null, pixels = false;
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset), end = offset + 12 + length;
    if (end > input.length) invalid();
    const type = input.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) invalid();
      size = dimensions(input.readUInt32BE(offset + 8), input.readUInt32BE(offset + 12));
    } else if (!size || (!keep.has(type) && type[0] === type[0].toUpperCase())) invalid();
    if (type === 'IDAT') pixels = true;
    if (keep.has(type)) parts.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      if (length || !pixels) invalid();
      return { ...size, data: Buffer.concat(parts), ext: 'png' };
    }
  }
  invalid();
}

function cleanJpeg(input) {
  const parts = [input.subarray(0, 2)];
  let offset = 2, size = null, pixels = false;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < input.length) {
    const start = offset;
    if (input[offset++] !== 0xff) invalid();
    while (input[offset] === 0xff) offset++;
    if (offset >= input.length) invalid();
    const marker = input[offset++];
    if (marker === 0xd9) {
      if (!size || !pixels) invalid();
      parts.push(Buffer.from([0xff, 0xd9]));
      return { ...size, data: Buffer.concat(parts), ext: 'jpg' };
    }
    if (marker === 0x00 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) invalid();
    if (marker === 0x01) { parts.push(input.subarray(start, offset)); continue; }
    if (offset + 2 > input.length) invalid();
    const length = input.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > input.length) invalid();
    const payload = offset + 2;
    if (frames.has(marker)) {
      if (length < 8) invalid();
      size = dimensions(input.readUInt16BE(payload + 3), input.readUInt16BE(payload + 1));
    }
    const metadata = marker >= 0xe0 && marker <= 0xef || marker === 0xfe;
    // Adobe's fixed color-transform marker is needed to decode some CMYK JPEGs.
    const adobe = marker === 0xee && length === 14 && input.toString('ascii', payload, payload + 5) === 'Adobe';
    if (!metadata || adobe) parts.push(input.subarray(start, end));
    offset = end;
    if (marker === 0xda) {
      pixels = true;
      const scan = offset;
      while (offset < input.length) {
        if (input[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (input[next] === 0xff) next++;
        if (next >= input.length) invalid();
        if (input[next] === 0x00 || input[next] >= 0xd0 && input[next] <= 0xd7) offset = next + 1;
        else break;
      }
      parts.push(input.subarray(scan, offset));
    }
  }
  invalid();
}

function cleanWebp(input) {
  if (input.length < 20 || input.readUInt32LE(4) + 8 !== input.length) invalid();
  const parts = [], keep = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
  let offset = 12, size = null, pixels = false;
  while (offset + 8 <= input.length) {
    const type = input.toString('ascii', offset, offset + 4), length = input.readUInt32LE(offset + 4);
    const payload = offset + 8, end = payload + length + (length & 1);
    if (end > input.length) invalid();
    if (type === 'VP8X') {
      if (length !== 10 || offset !== 12) invalid();
      size = dimensions(input.readUIntLE(payload + 4, 3) + 1, input.readUIntLE(payload + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (length < 10 || !input.subarray(payload + 3, payload + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid();
      size ??= dimensions(input.readUInt16LE(payload + 6) & 0x3fff, input.readUInt16LE(payload + 8) & 0x3fff);
      pixels = true;
    } else if (type === 'VP8L') {
      if (length < 5 || input[payload] !== 0x2f) invalid();
      const bits = input.readUInt32LE(payload + 1);
      size ??= dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      pixels = true;
    } else if (type === 'ANMF') pixels = true;
    if (keep.has(type)) {
      const part = Buffer.from(input.subarray(offset, end));
      if (type === 'VP8X') part[8] &= ~(0x20 | 0x08 | 0x04); // ICC, EXIF and XMP flags.
      parts.push(part);
    }
    offset = end;
  }
  if (offset !== input.length || !size || !pixels) invalid();
  const body = Buffer.concat(parts), header = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  return { ...size, data: Buffer.concat([header, body]), ext: 'webp' };
}

function cleanImage(input) {
  if (!Buffer.isBuffer(input)) invalid();
  if (input.subarray(0, 8).equals(pngSignature)) return cleanPng(input);
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return cleanJpeg(input);
  if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') return cleanWebp(input);
  invalid();
}

export function createReferences({ db, config, limits = {} }) {
  const root = join(config.dataDir, 'references'), ttl = limits.draftTtl || 24 * 3600e3;
  mkdirSync(root, { recursive: true });
  let questions = null;
  const one = db.prepare('SELECT * FROM reference_uploads WHERE id = ?');
  const byQuestion = db.prepare('SELECT * FROM reference_uploads WHERE task_id = ? ORDER BY position, id');
  const insert = db.prepare(`INSERT INTO reference_uploads
    (id, owner_id, original_name, name, ext, width, height, bytes, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attach = db.prepare('UPDATE reference_uploads SET task_id = ?, name = ?, caption = ?, position = ? WHERE id = ?');
  const detach = db.prepare("UPDATE reference_uploads SET task_id = NULL, caption = '', position = 0, created_at = ? WHERE id = ?");
  const remove = db.prepare('DELETE FROM reference_uploads WHERE id = ?');
  const pathFor = (row) => join(root, `${row.id}.${row.ext}`);
  const dto = (row) => ({ id: row.id, name: row.name, src: `media/references/${row.id}.${row.ext}`,
    caption: row.caption, width: row.width, height: row.height });
  function deleteRow(row) { rmSync(pathFor(row), { force: true }); remove.run(row.id); }
  return {
    bindQuestions(value) { questions = value; },
    upload(user, name, buffer) {
      if (!user?.id) fail(401, '请先登录');
      if (!Buffer.isBuffer(buffer)) invalid();
      if (buffer.length > (limits.referenceBytes || 5 * 1024 * 1024)) fail(413, '每张参考图不能超过 5 MiB');
      const image = cleanImage(buffer), originalExt = typeof name === 'string' ? extname(name).toLowerCase() : '';
      if (!originalExt || (originalExt === '.jpeg' ? 'jpg' : originalExt.slice(1)) !== image.ext) fail(400, '参考图扩展名与实际图片格式不一致');
      const id = `r-${randomBytes(16).toString('hex')}`, row = { id, ext: image.ext };
      try {
        writeFileSync(pathFor(row), image.data, { flag: 'wx' });
        insert.run(id, user.id, name, name, image.ext, image.width, image.height, image.data.length,
          createHash('sha256').update(image.data).digest('hex'), Date.now());
      } catch (error) { rmSync(pathFor(row), { force: true }); throw error; }
      return { id, name, src: `media/references/${id}.${image.ext}`, width: image.width, height: image.height, bytes: image.data.length };
    },
    prepare(user, input, { taskId = null } = {}) {
      if (!Array.isArray(input)) fail(400, '参考图格式不正确');
      const max = limits.referenceCount || 8;
      if (input.length > max) fail(400, `每道题最多添加 ${max} 张参考图`);
      const ids = new Set(), names = new Set(), now = Date.now();
      return input.map((item) => {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') fail(400, '参考图格式不正确');
        const row = one.get(item.id), saved = row?.task_id != null && row.task_id === taskId;
        if (!row || !saved && (row.task_id != null || row.owner_id !== user?.id || row.created_at <= now - ttl)) fail(400, '参考图不存在、已过期或不属于你');
        if (typeof item.name !== 'string' || !/^\d{2}-[\p{L}\p{N}-]+\.(jpg|png|webp)$/u.test(item.name)) fail(400, '参考图名称须为两位编号、短名称和图片扩展名，如 01-构图.jpg');
        if (!item.name.endsWith(`.${row.ext}`)) fail(400, '参考图名称扩展名与图片格式不一致');
        if (ids.has(item.id) || names.has(item.name)) fail(400, '参考图编号或名称不能重复');
        const caption = item.caption ?? '';
        if (typeof caption !== 'string' || [...caption].length > 40) fail(400, '参考图说明最多 40 字');
        ids.add(item.id); names.add(item.name);
        return { ...dto(row), name: item.name, caption };
      });
    },
    forQuestion(taskId) { return byQuestion.all(taskId).map(dto); },
    save(taskId, refs) {
      const kept = new Set(refs.map((ref) => ref.id)), now = Date.now();
      for (const row of byQuestion.all(taskId)) if (!kept.has(row.id)) detach.run(now, row.id);
      refs.forEach((ref, position) => attach.run(taskId, ref.name, ref.caption, position, ref.id));
    },
    removeQuestion(taskId) { for (const row of byQuestion.all(taskId)) deleteRow(row); },
    cleanup(now = Date.now()) {
      const rows = db.prepare('SELECT * FROM reference_uploads WHERE task_id IS NULL AND created_at <= ?').all(now - ttl);
      for (const row of rows) deleteRow(row);
      return rows.length;
    },
    file(id, viewer = null) {
      const row = one.get(id);
      if (!row) fail(404, '参考图不存在');
      const publicImage = Boolean(row.task_id && questions?.get(row.task_id));
      const permitted = row.task_id ? questions?.get(row.task_id, viewer) :
        row.created_at > Date.now() - ttl && (row.owner_id === viewer?.id || isStaff(viewer));
      if (!permitted) fail(404, '参考图不存在');
      return { path: pathFor(row), type: mime[row.ext], name: row.name, public: publicImage };
    },
  };
}
