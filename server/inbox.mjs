// Admin staging inbox: files wait here until an admin previews them and registers
// them as works. Registration reuses the platform's draft → submit → review pipeline,
// so every check (entry detection, duplicate digests, unsafe paths) runs unchanged.
//
// Entries live on disk under generated ASCII ids (`<id>.bin`, `<id>.d/`, `<id>.json`)
// with the original filename kept in the sidecar — never derived from user input, so
// odd filenames (unicode, brackets, long CJK names) cannot produce hostile or
// unusable paths. See also library.mjs, which stores works the same way.
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fail, resolveInside } from './http.mjs';
import { inspectUpload } from './inspect.mjs';

// Show1 convention: `「标题，模型名.html」` pre-fills the form; anything else keeps the
// basename as the title and leaves the model empty for the admin to fill.
export function parseWorkFilename(name) {
  const base = String(name ?? '').normalize('NFKC').trim();
  const braced = /^[「『](.+)[，,](.+)[」』]$/.exec(base);
  // The Show1 convention keeps the extension inside the brackets: 「标题，模型名.html」.
  const stripExt = (value) => value.trim().replace(/\.(html?|zip)$/i, '');
  if (braced) return { title: stripExt(braced[1]).slice(0, 40), model: stripExt(braced[2]).slice(0, 60) };
  return { title: base.replace(/\.(html?|zip)$/i, '').slice(0, 40), model: '' };
}

export function createInbox({ library, config, limits }) {
  const dir = join(config.dataDir, 'inbox');
  mkdirSync(dir, { recursive: true });

  const sidecars = () => readdirSync(dir).filter((name) => name.endsWith('.json') && !name.endsWith('.d.json'));
  const readEntry = (id) => {
    try { return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')); } catch { return null; }
  };
  const idOf = (name) => sidecars().find((file) => readEntry(file.slice(0, -5))?.name === name)?.slice(0, -5) ?? null;

  const safeName = (raw) => {
    const base = String(raw ?? '').normalize('NFKC').split(/[\\/]+/).pop().trim();
    if (!base || base.length > 120 || base.startsWith('.') || /[\0-\x1f]/.test(base)) fail(400, '文件名无效');
    // The Show1 convention 「标题，模型名.html」 keeps the extension inside the brackets.
    if (!/\.(html?|zip)$/i.test(base) && !/\.(html?|zip)[」』]$/i.test(base)) fail(400, '只支持 .html / .htm / .zip 文件');
    return base;
  };
  const destroy = (id) => {
    rmSync(join(dir, `${id}.bin`), { force: true });
    rmSync(join(dir, `${id}.d`), { recursive: true, force: true });
    rmSync(join(dir, `${id}.json`), { force: true });
  };

  return {
    // Staged files are served to the admin shell from /admin/inbox/<id>/... (app.mjs);
    // `file` is the raw upload, everything else comes from the extracted zip tree.
    resolve(relPath) {
      const [rawId, ...rest] = String(relPath ?? '').split('/').filter(Boolean);
      const id = /^[a-z0-9]{16}$/.test(rawId ?? '') ? rawId : null;
      if (!id || !readEntry(id)) return null;
      const target = rest.length === 1 && rest[0] === 'file' ? `${id}.bin` : [`${id}.d`, ...rest].join('/');
      const found = resolveInside(dir, `/${target}`);
      if (!found || !statSync(found.file, { throwIfNoEntry: false })?.isFile()) return null;
      // The stored upload has no telling extension; the browser needs a renderable type.
      if (rest.length === 1 && rest[0] === 'file') found.type = readEntry(id).kind === 'zip' ? 'application/zip' : 'text/html; charset=utf-8';
      return found;
    },

    list() {
      const entries = sidecars().map((file) => {
        const id = file.slice(0, -5);
        const meta = readEntry(id);
        if (!meta) return null;
        const preview = meta.kind === 'zip' && meta.entry
          ? `/admin/inbox/${id}/${meta.entry.split('/').map(encodeURIComponent).join('/')}`
          : `/admin/inbox/${id}/file`;
        return { id, name: meta.name, kind: meta.kind, size: statSync(join(dir, `${id}.bin`)).size, addedAt: meta.addedAt, suggest: parseWorkFilename(meta.name), preview };
      }).filter(Boolean);
      entries.sort((a, b) => a.addedAt - b.addedAt);
      return { entries };
    },

    upload(admin, rawName, buffer, overwrite = false) {
      const name = safeName(rawName);
      const existing = idOf(name);
      if (existing && !overwrite) fail(409, '收件箱里已有同名文件，可以在表单里选择覆盖', 'inbox_conflict');
      // Inspect before storing: a file that could never register is rejected on sight.
      const inspected = inspectUpload(buffer, name, { limits, cdn: config.cdn, template: null });
      const id = existing ?? randomBytes(8).toString('hex');
      destroy(id);
      writeFileSync(join(dir, `${id}.bin`), buffer);
      if (inspected.kind === 'zip') {
        const target = join(dir, `${id}.d`);
        mkdirSync(target, { recursive: true });
        try {
          for (const [path, data] of inspected.files) {
            if (path.startsWith('/') || path.includes('..') || /[\0-\x1f]/.test(path)) continue;
            const dest = join(target, path);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, data);
          }
        } catch {
          destroy(id);
          fail(400, '压缩包里包含系统无法存储的文件名');
        }
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        name, kind: inspected.kind, addedAt: Date.now(),
        entry: inspected.root ? `${inspected.root}/${inspected.entry}` : inspected.entry,
      }));
      library.audit(admin, 'inbox-upload', null, `${name} · ${(buffer.length / 1024).toFixed(0)} KB`);
      return { ok: true, name };
    },

    register(admin, body) {
      const id = /^[a-z0-9]{16}$/.test(String(body?.id ?? '')) ? body.id : null;
      const bin = id ? join(dir, `${id}.bin`) : null;
      if (!id || !existsSync(bin)) fail(404, '收件箱里没有这个文件，请重新上传');
      const meta = readEntry(id);
      const suggest = parseWorkFilename(meta.name);
      const draft = library.createDraft(admin, String(body.task ?? ''), meta.name, readFileSync(bin));
      let work;
      try {
        work = library.submit(admin, {
          draftId: draft.id, confirmed: true,
          title: String(body.title ?? '').trim() || suggest.title,
          summary: String(body.summary ?? '').trim(),
          modelName: String(body.modelName ?? '').trim() || suggest.model,
          modelId: body.modelId || undefined,
          effort: body.effort || undefined,
          tool: body.tool ?? '',
          ...Object.fromEntries(['harnessId', 'harnessOther', 'harnessVersion', 'providerId', 'providerOther',
            'modelVersion', 'generationMode', 'humanIntervention', 'generatedOn', 'evidenceUrl']
            .filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])),
        });
      } catch (error) {
        library.discardDraft(admin, draft.id);
        throw error;
      }
      if (body.publish) {
        work = library.review(admin, work.taskId, work.id, { status: 'verified',
          show_gallery: body.show_gallery === undefined ? true : Boolean(body.show_gallery),
          show_arena: Boolean(body.show_arena) });
      } else {
        // Per-face review: registration decides nothing about display. The work waits
        // with both faces off until each system's review turns its own face on.
        library.setFaceSettings(admin, work.taskId, work.id, { show_gallery: false, show_arena: false });
        work = library.work(work.taskId, work.id);
      }
      destroy(id);
      library.audit(admin, 'inbox-register', work, `${meta.name}${body.publish ? ' · 登记并发布' : ' · 登记为待核验'}`);
      return work;
    },

    remove(admin, id, silent = false) {
      if (!/^[a-z0-9]{16}$/.test(String(id ?? '')) || !existsSync(join(dir, `${id}.bin`))) fail(404, '收件箱里没有这个文件');
      destroy(id);
      if (!silent) library.audit(admin, 'inbox-remove', null, id);
      return { ok: true };
    },
  };
}
