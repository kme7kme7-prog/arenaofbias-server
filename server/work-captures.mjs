// Replacing one screenshot (dots captures:write). first and mobile only.
// A new file name is used so a reused first.jpg cannot keep serving the old bytes,
// and the capture service can later write first.jpg / mobile.jpg again without
// deleting this file. Only the matching key in works.captures changes. Moderation,
// cover, late shots and the work package are left alone.
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './db.mjs';
import { HttpError, fail } from './http.mjs';
import { COVER_LIMITS, sniffImage } from './work-covers.mjs';

export const CAPTURE_SLOTS = ['first', 'mobile'];

export function checkCapture(buffer, maxBytes) {
  if (!buffer.length) fail(400, '截图内容为空', 'invalid_image');
  if (buffer.length > maxBytes) fail(413, '截图太大', 'too_large');
  const image = sniffImage(buffer);
  if (!image || image.ext !== 'jpg') fail(415, '截图只支持 JPEG（按文件内容判断）', 'unsupported_type');
  const { minSide, maxSide, maxPixels } = COVER_LIMITS;
  if (image.width < minSide || image.height < minSide || image.width > maxSide || image.height > maxSide || image.width * image.height > maxPixels) {
    fail(422, `截图尺寸须在 ${minSide}–${maxSide} 像素之间`, 'bad_dimensions');
  }
  return image;
}

export function createCaptureStore({ db, library }) {
  const q = {
    raw: db.prepare('SELECT captures FROM works WHERE id = ? AND deleted_at IS NULL'),
    swap: db.prepare('UPDATE works SET captures = ? WHERE id = ? AND captures = ? AND deleted_at IS NULL'),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
  const dirOf = (work) => join(library.mediaDir, work.id);
  return {
    // The raw captures string is read before the write, then the update matches it.
    // A concurrent replace that committed first makes this one return 409.
    replace(work, slot, buffer, image, actor) {
      if (!CAPTURE_SLOTS.includes(slot)) fail(400, '截图位置只能是 first 或 mobile', 'invalid_slot');
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const row = q.raw.get(work.id);
      if (!row) fail(404, '作品不存在', 'not_found');
      const current = JSON.parse(row.captures || '{}');
      const previous = typeof current[slot] === 'string' && current[slot] ? current[slot] : null;
      const stamp = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      const name = `${slot}-${stamp}.jpg`;
      const next = { ...current, [slot]: name };
      mkdirSync(dirOf(work), { recursive: true });
      const pending = join(dirOf(work), `.${name}.tmp`);
      writeFileSync(pending, buffer);
      renameSync(pending, join(dirOf(work), name));
      try {
        return transaction(db, () => {
          if (!q.swap.run(JSON.stringify(next), work.id, row.captures).changes) {
            throw new HttpError(409, '截图刚刚被修改，请重新获取后再试', 'conflict');
          }
          const at = Date.now();
          q.audit.run(at, actor.id, actor.name, 'capture-replace', work.taskId, work.id,
            JSON.stringify({ slot, previous, next: name, bytes: buffer.length, type: image.mime, width: image.width, height: image.height }));
          return {
            slot, file: `media/${work.id}/${name}`,
            previous: previous ? `media/${work.id}/${previous}` : null,
          };
        });
      } catch (error) {
        rmSync(join(dirOf(work), name), { force: true });
        throw error;
      }
    },
  };
}
