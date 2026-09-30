import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fail, resolveInside } from './http.mjs';
import { transaction } from './db.mjs';
import { generationOf } from './generation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function createCurator({ db, catalog, library, onTakeover = () => {} }) {
  const nominateRow = db.prepare('UPDATE works SET nominated_at = ?, nominated_by = ?, export_token_hash = ?, export_expires_at = ? WHERE id = ?');
  const clearRow = db.prepare('UPDATE works SET nominated_at = NULL, nominated_by = NULL, export_token_hash = NULL, export_expires_at = NULL WHERE id = ?');
  const byToken = db.prepare('SELECT task_id, id FROM works WHERE export_token_hash = ? AND export_expires_at > ? AND curated_as IS NULL AND deleted_at IS NULL');
  const takeoverRow = db.prepare('UPDATE works SET curated_as = ?, nominated_at = NULL, nominated_by = NULL, export_token_hash = NULL, export_expires_at = NULL WHERE id = ? AND task_id = ? AND digest = ? AND nominated_at IS NOT NULL AND curated_as IS NULL AND deleted_at IS NULL');
  const sourceFlags = db.prepare('SELECT task_id, digest, nominated_at, show_gallery, show_arena FROM works WHERE id = ? AND curated_as IS NULL AND deleted_at IS NULL');
  const inheritFlags = db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, updated_by, updated_at)
    VALUES (?, ?, ?, ?, '系统', ?) ON CONFLICT(task_id, work_id) DO NOTHING`);
  const audit = db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');

  function upload(task, id) {
    const work = library.work(task, id);
    if (!work || work.curated) fail(404, '作品不存在', 'not_found');
    return work;
  }

  function nominate(admin, task, id, origin) {
    const work = upload(task, id);
    if (work.curatedAs) fail(409, '作品已收录');
    if (work.status !== 'verified') fail(409, '请先审核通过');
    if (!library.contentAllowed(work)) fail(409, '请先通过内容审查');
    if (!catalog.snapshot().task(task)) fail(409, '题目不在当前数据包');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    transaction(db, () => {
      nominateRow.run(now, admin.id, hash(token), now + 14 * 86400e3, id);
      audit.run(now, admin.id, admin.name, 'nominate', task, id, '提名收录');
    });
    const exportUrl = `${origin}/api/curate/export/${token}`;
    return { exportUrl, command: `npm run intake:from-server -- ${exportUrl}` };
  }

  function withdraw(admin, task, id) {
    const work = upload(task, id);
    if (work.curatedAs) fail(409, '作品已收录');
    transaction(db, () => {
      clearRow.run(id);
      audit.run(Date.now(), admin.id, admin.name, 'withdraw-nomination', task, id, '撤回提名');
    });
    return { ok: true };
  }

  function exported(token) {
    const row = /^[a-f0-9]{64}$/.test(token) ? byToken.get(hash(token), Date.now()) : null;
    if (!row) fail(404, '导出不存在', 'not_found');
    const work = upload(row.task_id, row.id);
    if (work.status !== 'verified') fail(404, '导出不存在', 'not_found');
    if (!library.contentAllowed(work)) fail(404, '导出不存在', 'not_found');
    return work;
  }

  function files(work) {
    const found = [];
    function visit(dir) {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, item.name);
        if (item.isDirectory()) visit(file);
        else if (item.isFile()) {
          const path = relative(work.dir, file).split(sep).join('/');
          found.push({ path, size: statSync(file).size, sha256: hash(readFileSync(file)) });
        }
      }
    }
    visit(work.dir);
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  function metadata(token) {
    const work = exported(token);
    return {
      task: work.taskId, id: work.id, title: work.title, summary: work.summary,
      modelId: work.modelId, modelName: work.modelName, vendor: work.vendor,
      effort: work.effort, tool: work.tool, note: work.note,
      harnessId: work.harnessId, harnessOther: work.harnessOther, harnessVersion: work.harnessVersion,
      providerId: work.providerId, providerOther: work.providerOther,
      ...generationOf(work),
      createdAt: new Date(work.createdAt).toISOString(), root: work.root,
      entry: work.entry, digest: work.digest, files: files(work),
    };
  }

  function file(token, path) {
    const work = exported(token);
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) fail(404, '文件不存在', 'not_found');
    const found = resolveInside(work.dir, `/${path}`);
    if (!found || relative(work.dir, found.file).split(sep).join('/') !== path) fail(404, '文件不存在', 'not_found');
    return found;
  }

  function takeover(snapshot) {
    let changedAny = false;
    transaction(db, () => {
      for (const task of snapshot.tasks()) for (const work of task.works.values()) {
        if (!/^up-[a-z0-9]+$/.test(work.sourceUpload ?? '')) continue;
        const target = `${task.id}/${work.id}`;
        const flags = sourceFlags.get(work.sourceUpload);
        const reason = !flags ? '投稿不存在' : !flags.nominated_at ? '投稿未提名'
          : flags.task_id !== task.id ? '题目不一致'
            : !/^[a-f0-9]{64}$/.test(work.sourceDigest ?? '') || flags.digest !== work.sourceDigest ? '内容摘要不一致' : null;
        if (reason) {
          audit.run(Date.now(), null, '系统', 'curate-reject', task.id, work.sourceUpload, `${target}: ${reason}`);
          continue;
        }
        const changed = takeoverRow.run(target, work.sourceUpload, task.id, work.sourceDigest);
        if (changed.changes) {
          changedAny = true;
          inheritFlags.run(task.id, work.id, flags.show_gallery, flags.show_arena, Date.now());
          audit.run(Date.now(), null, '系统', 'curate', task.id, work.sourceUpload, `数据包接管 ${target}`);
        }
      }
    });
    if (changedAny) onTakeover();
  }

  return { nominate, withdraw, metadata, file, takeover };
}
