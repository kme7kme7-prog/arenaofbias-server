// Replacing a work's cover outside submission (dots cover:write, admin rollback).
// Every cover gets a new file name, so old covers stay on disk, caches never serve a
// stale image under a reused name, and a rollback only points the work back at an
// older file. Screenshots are copied aside at each change. Capture and moderation
// never write `works.cover`, so a cover set here is not overwritten by a re-capture.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './db.mjs';
import { HttpError, fail } from './http.mjs';

export const COVER_LIMITS = { minSide: 64, maxSide: 4096, maxPixels: 16_777_216 };
export const COVER_FILE = /^cover(?:-[a-z0-9]{8,24})?\.(?:png|jpg|webp)$/;
const SHOTS = /^(?:first|mobile)(?:-late)?\.jpg$/;

// Type and pixel size from the bytes themselves; the declared Content-Type is ignored.
export function sniffImage(buffer) {
  const b = buffer;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR') {
    return { ext: 'png', mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null; // no frame header before the image data
      const length = b.readUInt16BE(at + 2);
      if (length < 2) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (at + 9 > b.length) return null;
        return { ext: 'jpg', mime: 'image/jpeg', width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
    return null;
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { ext: 'webp', mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
      return { ext: 'webp', mime: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') return { ext: 'webp', mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

export function checkCover(buffer, maxBytes) {
  if (!buffer.length) fail(400, '封面内容为空', 'invalid_image');
  if (buffer.length > maxBytes) fail(413, '封面图片太大', 'too_large');
  const image = sniffImage(buffer);
  if (!image) fail(415, '封面只支持 PNG、JPEG 或 WebP（按文件内容判断）', 'unsupported_type');
  const { minSide, maxSide, maxPixels } = COVER_LIMITS;
  if (image.width < minSide || image.height < minSide || image.width > maxSide || image.height > maxSide || image.width * image.height > maxPixels) {
    fail(422, `封面尺寸须在 ${minSide}–${maxSide} 像素之间`, 'bad_dimensions');
  }
  return image;
}

export function createCoverStore({ db, library }) {
  const q = {
    swap: db.prepare('UPDATE works SET cover = ? WHERE id = ? AND cover IS ? AND deleted_at IS NULL'),
    history: db.prepare(`INSERT INTO cover_history (at, work_id, task_id, action, previous, next, snapshot, actor_id, actor_name, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // Preview entries (preview-*) share the table; covers only see their own.
    list: db.prepare("SELECT * FROM cover_history WHERE work_id = ? AND action LIKE 'cover-%' ORDER BY id DESC LIMIT 100"),
    entry: db.prepare("SELECT * FROM cover_history WHERE id = ? AND work_id = ? AND action LIKE 'cover-%'"),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
  const dirOf = (work) => join(library.mediaDir, work.id);

  // Copies the current screenshots aside so a later re-capture cannot lose them.
  function snapshot(work, stamp) {
    const shots = (() => { try { return readdirSync(dirOf(work)).filter((name) => SHOTS.test(name)); } catch { return []; } })();
    if (!shots.length) return null;
    const target = join(dirOf(work), 'history', stamp);
    mkdirSync(target, { recursive: true });
    for (const name of shots) copyFileSync(join(dirOf(work), name), join(target, name));
    return `history/${stamp}`;
  }

  function point(work, from, to, action, actor, detail, snap = null) {
    return transaction(db, () => {
      if (!q.swap.run(to, work.id, from).changes) {
        const error = new HttpError(409, '封面刚刚被修改，请重新获取后再试', 'conflict');
        throw error;
      }
      const at = Date.now();
      const id = Number(q.history.run(at, work.id, work.taskId, action, from, to, snap, actor.id, actor.name, JSON.stringify(detail)).lastInsertRowid);
      q.audit.run(at, actor.id, actor.name, action, work.taskId, work.id, JSON.stringify({ historyId: id, previous: from, next: to, ...detail }));
      return id;
    });
  }

  return {
    // Writes the new file first; the row only changes if the cover is still what we read.
    replace(work, buffer, image, actor, source) {
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const stamp = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      const name = `cover-${stamp}.${image.ext}`;
      mkdirSync(dirOf(work), { recursive: true });
      const pending = join(dirOf(work), `.${name}.tmp`);
      writeFileSync(pending, buffer);
      renameSync(pending, join(dirOf(work), name));
      try {
        const snap = snapshot(work, stamp);
        const historyId = point(work, work.cover ?? null, name, 'cover-replace', actor,
          { source, bytes: buffer.length, type: image.mime, width: image.width, height: image.height }, snap);
        return { historyId, cover: `media/${work.id}/${name}`, previous: work.cover ? `media/${work.id}/${work.cover}` : null };
      } catch (error) {
        rmSync(join(dirOf(work), name), { force: true });
        throw error;
      }
    },
    history(work) {
      return q.list.all(work.id).map((row) => ({ id: row.id, at: new Date(row.at).toISOString(), action: row.action, previous: row.previous,
        next: row.next, snapshot: row.snapshot, actor: row.actor_name, detail: JSON.parse(row.detail) }));
    },
    // Points the work back at the cover it had before history entry `id` (default: the
    // latest change). The rollback is itself a history entry and can be undone the same way.
    rollback(work, id, actor) {
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const entry = id == null ? q.list.all(work.id)[0] : q.entry.get(Number(id), work.id);
      if (!entry) fail(404, '没有可回滚的封面记录', 'not_found');
      const target = entry.previous;
      if (target && (!COVER_FILE.test(target) || !existsSync(join(dirOf(work), target)))) fail(409, '旧封面文件已不存在', 'missing_file');
      const historyId = point(work, work.cover ?? null, target, 'cover-rollback', actor, { source: 'rollback', to: entry.id });
      return { historyId, cover: target ? `media/${work.id}/${target}` : null };
    },
  };
}
