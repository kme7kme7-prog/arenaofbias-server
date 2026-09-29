// Every work the platform knows: curated works from the build plus submitted uploads.
// Uploads move through unverified → verified | questioned; drafts hold a staged upload
// until its author has watched the trial load and submits it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { EFFORTS, EMOJIS } from './config.mjs';
import { transaction } from './db.mjs';
import { fail } from './http.mjs';
import { inspectUpload } from './inspect.mjs';

const token = (prefix) => `${prefix}${randomBytes(16).toString('hex')}`;
const workId = () => `up-${[...randomBytes(8)].map((byte) => (byte % 36).toString(36)).join('')}`;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const clip = (value, max) => String(value ?? '').normalize('NFKC').trim().slice(0, max);
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function validFraming(value) {
  if (!plainObject(value)) return false;
  const ranges = { width: [320, 3840], height: [240, 3840], zoom: [0.25, 4], offsetX: [-1, 1], offsetY: [-1, 1] };
  return Object.keys(value).length === 5 && Object.entries(ranges).every(([key, [min, max]]) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= min && value[key] <= max)
    && Number.isInteger(value.width) && Number.isInteger(value.height);
}

function validCamera(value) {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'position,target') return false;
  const vector = (item) => Array.isArray(item) && item.length === 3 && item.every((n) =>
    typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7);
  return vector(value.position) && vector(value.target);
}
const COVER_TYPES = [
  { ext: 'png', mime: 'image/png', test: (b) => b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

function writeTree(target, files) {
  const base = resolve(target);
  for (const [path, data] of files) {
    const file = resolve(base, path);
    if (!file.startsWith(base + sep)) fail(400, '文件路径不合法');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

export function createLibrary({ db, catalog, config, limits }) {
  const dirs = { drafts: join(config.dataDir, 'drafts'), works: join(config.dataDir, 'works'), media: join(config.dataDir, 'media') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const originOf = (key) => config.contentTemplate.replace('{token}', key);

  const WORK = `SELECT works.*, COALESCE(NULLIF(owner.nickname, ''), owner.name) AS owner_name,
    COALESCE(NULLIF(reviewer.nickname, ''), reviewer.name) AS reviewer_name FROM works
    LEFT JOIN users owner ON owner.id = works.owner_id LEFT JOIN users reviewer ON reviewer.id = works.reviewed_by`;
  const q = {
    draft: db.prepare('SELECT * FROM drafts WHERE id = ?'),
    draftByToken: db.prepare('SELECT * FROM drafts WHERE token = ? AND expires_at > ?'),
    draftsOf: db.prepare('SELECT id FROM drafts WHERE owner_id = ? ORDER BY created_at DESC'),
    expiredDrafts: db.prepare('SELECT id FROM drafts WHERE expires_at <= ?'),
    insertDraft: db.prepare(`INSERT INTO drafts (id, owner_id, task_id, token, source_name, root, entry, file_count, bytes, digest, checks, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteDraft: db.prepare('DELETE FROM drafts WHERE id = ?'),
    work: db.prepare(`${WORK} WHERE works.id = ? AND works.deleted_at IS NULL`),
    storedWork: db.prepare('SELECT id, cover FROM works WHERE id = ?'),
    workByKey: db.prepare(`${WORK} WHERE works.content_key = ? AND works.deleted_at IS NULL`),
    workByDigest: db.prepare('SELECT id, title, task_id FROM works WHERE digest = ? AND deleted_at IS NULL LIMIT 1'),
    works: db.prepare(`${WORK} WHERE works.deleted_at IS NULL ORDER BY works.created_at DESC`),
    worksOfTask: db.prepare(`${WORK} WHERE works.task_id = ? AND works.deleted_at IS NULL`),
    worksOfOwner: db.prepare(`${WORK} WHERE works.owner_id = ? AND works.deleted_at IS NULL ORDER BY works.created_at DESC`),
    pendingOf: db.prepare("SELECT COUNT(*) AS n FROM works WHERE owner_id = ? AND status = 'unverified' AND deleted_at IS NULL"),
    insertWork: db.prepare(`INSERT INTO works (id, task_id, owner_id, title, summary, model_id, model_name, vendor, effort, tool,
      harness_id, harness_other, harness_version, provider_id, provider_other, note, content_key,
      source_name, root, entry, file_count, bytes, digest, checks, trial, cover, created_at, updated_at, show_gallery, show_arena)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`),
    deleteWork: db.prepare('DELETE FROM works WHERE id = ?'),
    deleteSubmitAudit: db.prepare("DELETE FROM audit WHERE action = 'submit' AND work_id = ?"),
    restoreDraft: db.prepare(`INSERT INTO drafts (id, owner_id, task_id, token, source_name, root, entry, file_count, bytes, digest, checks, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    review: db.prepare(`UPDATE works SET status = ?, status_reason = ?, model_id = ?, model_name = ?, vendor = ?, effort = ?,
      harness_id = ?, harness_other = ?, harness_version = ?, provider_id = ?, provider_other = ?,
      audience = ?, show_gallery = ?, show_arena = ?, title = ?, summary = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`),
    remove: db.prepare('UPDATE works SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?'),
    captures: db.prepare('UPDATE works SET captures = ? WHERE id = ?'),
    calibration: db.prepare('UPDATE works SET trial = ?, updated_at = ? WHERE id = ?'),
    arenaCalibration: db.prepare('UPDATE works SET calibration_arena = ?, updated_at = ? WHERE id = ?'),
    faceSettings: db.prepare('UPDATE works SET show_gallery = ?, show_arena = ?, audience = ?, updated_at = ? WHERE id = ?'),
    meta: db.prepare(`UPDATE works SET title = ?, summary = ?, model_id = ?, model_name = ?, vendor = ?, effort = ?,
      harness_id = ?, harness_other = ?, harness_version = ?, provider_id = ?, provider_other = ?, updated_at = ? WHERE id = ?`),
    curatedAs: db.prepare('UPDATE works SET curated_as = ?, updated_at = ? WHERE id = ?'),
    votesOfWork: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE task_id = ? AND (a_work = ? OR b_work = ?)'),
    override: db.prepare('SELECT * FROM work_overrides WHERE task_id = ? AND work_id = ?'),
    setOverride: db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET
      show_gallery = excluded.show_gallery, show_arena = excluded.show_arena, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    setCuratedCalibration: db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, calibration_gallery, calibration_arena, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET
      calibration_gallery = excluded.calibration_gallery, calibration_arena = excluded.calibration_arena,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    reaction: db.prepare('SELECT 1 FROM reactions WHERE task_id = ? AND work_id = ? AND user_id = ? AND emoji = ?'),
    addReaction: db.prepare('INSERT INTO reactions (task_id, work_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)'),
    dropReaction: db.prepare('DELETE FROM reactions WHERE task_id = ? AND work_id = ? AND user_id = ? AND emoji = ?'),
    reactionCounts: db.prepare('SELECT task_id, work_id, emoji, COUNT(*) AS n FROM reactions GROUP BY task_id, work_id, emoji'),
    workReactions: db.prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE task_id = ? AND work_id = ? GROUP BY emoji'),
    myReactions: db.prepare('SELECT task_id, work_id, emoji FROM reactions WHERE user_id = ?'),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    auditLog: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
  };

  function fromRow(row) {
    return {
      taskId: row.task_id,
      id: row.id,
      curated: false,
      status: row.status,
      audience: row.audience,
      showGallery: Boolean(row.show_gallery),
      showArena: Boolean(row.show_arena),
      curatedAs: row.curated_as ?? null,
      nominatedAt: row.nominated_at ?? null,
      calibrationArena: row.calibration_arena ? JSON.parse(row.calibration_arena) : null,
      reason: row.status_reason,
      title: row.title,
      summary: row.summary,
      modelId: row.model_id,
      modelName: row.model_name,
      vendor: row.vendor,
      effort: row.effort,
      tool: row.tool,
      harnessId: row.harness_id,
      harnessOther: row.harness_other,
      harnessVersion: row.harness_version,
      providerId: row.provider_id,
      providerOther: row.provider_other,
      note: row.note,
      ownerId: row.owner_id,
      ownerName: row.owner_name ?? null,
      reviewerName: row.reviewer_name ?? null,
      reviewedAt: row.reviewed_at,
      contentKey: row.content_key,
      root: row.root,
      entry: row.entry,
      dir: join(dirs.works, row.id, row.root),
      files: row.file_count,
      bytes: row.bytes,
      digest: row.digest,
      sourceName: row.source_name,
      checks: JSON.parse(row.checks),
      trial: JSON.parse(row.trial),
      captures: JSON.parse(row.captures),
      cover: row.cover,
      createdAt: row.created_at,
    };
  }

  function audit(actor, action, work, detail = '') {
    q.audit.run(Date.now(), actor?.id ?? null, actor?.name ?? '系统', action, work?.taskId ?? null, work?.id ?? null, detail);
  }

  function upload(taskId, id) {
    const row = q.work.get(id);
    return row && row.task_id === taskId ? fromRow(row) : null;
  }

  function purgeDrafts() {
    for (const { id } of q.expiredDrafts.all(Date.now())) {
      rmSync(join(dirs.drafts, id), { recursive: true, force: true });
      q.deleteDraft.run(id);
    }
  }
  purgeDrafts();
  // Directories left behind by an interrupted upload.
  for (const name of readdirSync(dirs.drafts)) if (!q.draft.get(name)) rmSync(join(dirs.drafts, name), { recursive: true, force: true });
  const orphans = join(config.dataDir, 'orphans');
  for (const item of readdirSync(dirs.works, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const row = q.storedWork.get(item.name);
    if (!row) {
      mkdirSync(orphans, { recursive: true });
      const target = join(orphans, `${item.name}-${Date.now()}-${randomBytes(4).toString('hex')}`);
      renameSync(join(dirs.works, item.name), target);
      console.warn(`Moved orphan work directory ${item.name} to ${target}`);
    } else if (row.cover) {
      const pending = join(dirs.media, item.name, `${row.cover}.tmp`);
      const final = join(dirs.media, item.name, row.cover);
      if (existsSync(pending) && !existsSync(final)) {
        renameSync(pending, final);
        console.warn(`Completed pending cover for ${item.name}`);
      }
    }
  }

  const flagsOf = (work) => {
    if (!work) return { show_gallery: false, show_arena: false };
    if (work.curated) {
      const row = q.override.get(work.taskId, work.id);
      // 精选馆藏默认只在展览馆展示；进正式盲测池须在竞技场系统逐件审核通过。
      return { show_gallery: Boolean(row?.show_gallery ?? 1), show_arena: Boolean(row?.show_arena ?? 0) };
    }
    return { show_gallery: work.showGallery, show_arena: work.showArena };
  };
  const visibleTo = (work, site = 'show2') => Boolean(work && (site === 'show1' ? flagsOf(work).show_arena : flagsOf(work).show_gallery));
  const isEligible = (work) => Boolean(work && work.status === 'verified' && work.dir && !work.curatedAs && visibleTo(work, 'show1'));
  const isInteractive = (work) => Boolean(work && work.status !== 'questioned' &&
    (visibleTo(work, 'show1') || visibleTo(work, 'show2')));

  function reactionsOf(taskId, id) {
    return Object.fromEntries(q.workReactions.all(taskId, id).map((row) => [row.emoji, row.n]));
  }

  function publicDraft(row) {
    return {
      id: row.id,
      task: row.task_id,
      sourceName: row.source_name,
      root: row.root,
      entry: row.entry,
      files: row.file_count,
      bytes: row.bytes,
      checks: JSON.parse(row.checks),
      preview: `${originOf(row.token)}/`,
      expiresAt: iso(row.expires_at),
    };
  }

  function sanitizeTrial(trial) {
    const t = trial && typeof trial === 'object' ? trial : {};
    const n = (value, max = 1e7) => (Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : null);
    const strings = (value, count) => (Array.isArray(value) ? value.slice(0, count).map((item) => clip(item, 200)).filter(Boolean) : []);
    return {
      loaded: t.loaded === true,
      loadMs: n(t.loadMs),
      errors: n(t.errors, 1000) ?? 0,
      errorSamples: strings(t.errorSamples, 3),
      failedResources: strings(t.failedResources, 5),
      blocked: strings(t.blocked, 5),
      canvases: n(t.canvases, 100),
      media: n(t.media, 10000),
      words: n(t.words),
    };
  }

  function coverFrom(dataUrl) {
    if (!dataUrl) return null;
    const match = /^data:image\/[a-z+.-]+;base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl));
    if (!match) fail(400, '封面图片格式无效');
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > limits.coverBytes) fail(413, '封面图片不能超过 3 MB');
    const type = COVER_TYPES.find((candidate) => buffer.length > 12 && candidate.test(buffer));
    if (!type) fail(400, '封面只支持 PNG、JPEG 或 WebP');
    return { buffer, type };
  }

  function identity(body) {
    const modelId = body.modelId ? String(body.modelId) : null;
    if (modelId) {
      const model = catalog.model(modelId);
      if (!model) fail(400, '所选模型不存在');
      return { modelId, modelName: model.name, vendor: model.vendor };
    }
    const modelName = clip(body.modelName, 60);
    if (!modelName) fail(400, '请填写模型名称');
    return { modelId: null, modelName, vendor: clip(body.vendor, 40) };
  }

  function provenance(body, current = {}) {
    const next = {
      harnessId: current.harnessId ?? null, harnessOther: current.harnessOther ?? '',
      harnessVersion: current.harnessVersion ?? '', providerId: current.providerId ?? null,
      providerOther: current.providerOther ?? '',
    };
    const fieldText = (value, label) => {
      const text = String(value ?? '').normalize('NFKC').trim();
      if ([...text].length > 40) fail(400, `${label}不能超过 40 字`);
      return text;
    };
    for (const [prefix, lookup, label] of [['harness', 'harness', 'Harness'], ['provider', 'provider', '服务商']]) {
      const idField = `${prefix}Id`, otherField = `${prefix}Other`;
      const hasId = Object.hasOwn(body, idField), hasOther = Object.hasOwn(body, otherField);
      if (!hasId && !hasOther) continue;
      const id = hasId ? body[idField] : null;
      const other = hasOther ? fieldText(body[otherField], label) : '';
      if (hasId && id !== null && (typeof id !== 'string' || !catalog[lookup](id))) fail(400, `所选${label}不存在`);
      if (id && other) fail(400, `${label}不能同时填写登记项和其他`);
      if (id) { next[idField] = id; next[otherField] = ''; }
      else if (hasOther && other) { next[idField] = null; next[otherField] = other; }
      else { next[idField] = null; next[otherField] = ''; }
    }
    if (Object.hasOwn(body, 'harnessVersion')) next.harnessVersion = fieldText(body.harnessVersion, 'Harness 版本');
    if (!next.harnessId && !next.harnessOther) {
      if (next.harnessVersion && Object.hasOwn(body, 'harnessVersion')) fail(400, '填写 Harness 后才能填写版本');
      next.harnessVersion = '';
    }
    return next;
  }

  const publicProvenance = (work) => ({
    harness: work.harnessId ?? null,
    harnessName: work.harnessId ? (catalog.harness(work.harnessId)?.name ?? work.harnessId) : (work.harnessOther || null),
    harnessVersion: work.harnessVersion ?? '',
    provider: work.providerId ?? null,
    providerName: work.providerId ? (catalog.provider(work.providerId)?.name ?? work.providerId) : (work.providerOther || null),
  });

  const effortOf = (value) => {
    const effort = clip(value, 20);
    const known = EFFORTS.find((item) => item.toLowerCase() === effort.toLowerCase());
    return known ?? effort;
  };

  return {
    isEligible,
    isInteractive,
    visibleTo,
    flagsOf,
    originOf,
    audit,
    mediaDir: dirs.media,

    work(taskId, id, snapshot = null) {
      return (snapshot ?? catalog.snapshot()).work(taskId, id) ?? upload(taskId, id);
    },
    byContentKey(key) {
      const row = q.workByKey.get(key);
      return row ? fromRow(row) : null;
    },
    // Curated works plus verified uploads: the pool blind comparisons draw from.
    eligible(taskId, snapshot = null) {
      return [...(snapshot ?? catalog.snapshot()).works(taskId), ...q.worksOfTask.all(taskId).map(fromRow)].filter(isEligible);
    },
    uploads() {
      return q.works.all().map(fromRow);
    },
    published(site) {
      return q.works.all().map(fromRow).filter((work) => !work.curatedAs && work.status === 'verified' && visibleTo(work, site));
    },
    uploadsOf(userId) {
      return q.worksOfOwner.all(userId).map(fromRow);
    },

    toPublic(work, viewer) {
      if (work.curated) return { task: work.taskId, id: work.id, curated: true, title: work.title, model: work.modelId, modelName: work.modelName, vendor: work.vendor, effort: work.effort, tool: work.tool, ...publicProvenance(work), cover: work.cover, status: 'verified' };
      const privileged = viewer && (viewer.id === work.ownerId || viewer.role === 'admin');
      return {
        task: work.taskId,
        id: work.id,
        curated: false,
        title: work.title,
        summary: work.summary,
        model: work.modelId,
        modelName: work.modelName,
        vendor: work.vendor,
        effort: work.effort,
        tool: work.tool,
        ...publicProvenance(work),
        note: work.note,
        status: work.status,
        ...(privileged ? { audience: work.audience } : {}),
        reason: work.reason,
        owner: work.ownerName,
        mine: Boolean(viewer && viewer.id === work.ownerId),
        addedAt: iso(work.createdAt),
        reviewedAt: iso(work.reviewedAt),
        scene: `${originOf(work.contentKey)}/`,
        captures: Object.fromEntries(Object.entries(work.captures).map(([id, file]) => [id, `media/${work.id}/${file}`])),
        cover: work.cover ? `media/${work.id}/${work.cover}` : null,
        files: work.files,
        bytes: work.bytes,
        calibration: work.trial.calibration ?? null,
        ...(privileged ? { checks: work.checks, trial: work.trial, sourceName: work.sourceName, root: work.root, entry: work.entry, reviewer: work.reviewerName } : {}),
      };
    },

    adminWork(work) {
      const flags = flagsOf(work);
      const override = work.curated ? q.override.get(work.taskId, work.id) : null;
      return {
        ...this.toPublic(work, { role: 'admin' }), source: work.curated ? 'curated' : 'upload',
        ...(work.curated ? {} : { curatedAs: work.curatedAs ?? null, nominatedAt: iso(work.nominatedAt) }),
        ...flags, calibration_gallery: work.curated ? (override?.calibration_gallery ? JSON.parse(override.calibration_gallery) : null) : work.trial.calibration ?? null,
        calibration_arena: work.curated ? (override?.calibration_arena ? JSON.parse(override.calibration_arena) : null) : work.calibrationArena,
        has_calibration_gallery: Boolean(work.curated ? override?.calibration_gallery : work.trial.calibration),
        has_calibration_arena: Boolean(work.curated ? override?.calibration_arena : work.calibrationArena),
      };
    },

    setFaceSettings(admin, taskId, id, body, withinTransaction = false) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在', 'not_found');
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some((key) => !['show_gallery', 'show_arena'].includes(key)) ||
        Object.values(body).some((value) => typeof value !== 'boolean')) fail(400, '门面开关无效', 'invalid_face_settings');
      const current = flagsOf(work);
      const gallery = body.show_gallery ?? current.show_gallery;
      const arena = body.show_arena ?? current.show_arena;
      const apply = () => {
        if (work.curated) q.setOverride.run(taskId, id, Number(gallery), Number(arena), admin.id, Date.now());
        else q.faceSettings.run(Number(gallery), Number(arena), gallery && arena ? 'both' : gallery ? 'show2' : arena ? 'show1' : 'hidden', Date.now(), id);
        audit(admin, 'face-settings', work, JSON.stringify({ show_gallery: gallery, show_arena: arena }));
      };
      if (withinTransaction) apply();
      else transaction(db, apply);
      return this.adminWork(this.work(taskId, id));
    },

    batchSetFaceSettings(admin, items, settings) {
      if (!Array.isArray(items) || !items.length || items.length > 200 ||
        items.some((item) => !plainObject(item) || typeof item.task !== 'string' || !item.task || typeof item.id !== 'string' || !item.id))
        fail(400, '作品列表无效（每次最多 200 件）', 'invalid_work_list');
      return transaction(db, () => items.map(({ task, id }) => this.setFaceSettings(admin, task, id, settings, true)));
    },

    setFaceCalibration(admin, taskId, id, face, patch) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在', 'not_found');
      if (!['gallery', 'arena'].includes(face)) fail(400, '门面参数无效', 'invalid_face');
      if (patch !== null && (!plainObject(patch) || !Object.keys(patch).length ||
        Object.keys(patch).some((key) => !['framing', 'camera'].includes(key)) ||
        (Object.hasOwn(patch, 'framing') && patch.framing !== null && !validFraming(patch.framing)) ||
        (Object.hasOwn(patch, 'camera') && patch.camera !== null && !validCamera(patch.camera)))) fail(400, '校准数据无效', 'invalid_calibration');
      const previous = this.adminWork(work)[`calibration_${face}`] ?? {};
      const next = patch === null ? null : { ...previous, ...patch };
      if (next) for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
      const value = next && Object.keys(next).length ? next : null;
      transaction(db, () => {
        if (work.curated) {
          const old = q.override.get(taskId, id);
          const flags = flagsOf(work);
          q.setCuratedCalibration.run(taskId, id,
            Number(flags.show_gallery), Number(flags.show_arena),
            face === 'gallery' ? (value ? JSON.stringify(value) : null) : old?.calibration_gallery ?? null,
            face === 'arena' ? (value ? JSON.stringify(value) : null) : old?.calibration_arena ?? null,
            admin.id, Date.now());
        } else if (face === 'arena') q.arenaCalibration.run(value ? JSON.stringify(value) : null, Date.now(), id);
        else {
          const trial = { ...work.trial };
          if (value) trial.calibration = value; else delete trial.calibration;
          q.calibration.run(JSON.stringify(trial), Date.now(), id);
        }
        audit(admin, 'calibration', work, `${face}：${JSON.stringify(value)}`);
      });
      return value;
    },

    getCalibration(viewer, id) {
      const row = q.work.get(id);
      if (!row || ((row.status !== 'verified' || !row.show_gallery) && viewer?.id !== row.owner_id && viewer?.role !== 'admin')) fail(404, '作品不存在');
      return JSON.parse(row.trial).calibration ?? null;
    },

    setCalibration(user, id, patch) {
      const row = q.work.get(id);
      if (!row) fail(404, '作品不存在');
      if (row.owner_id !== user.id && user.role !== 'admin') fail(403, '只能校准自己的作品');
      if (patch !== null && (!plainObject(patch) || !Object.keys(patch).length ||
        Object.keys(patch).some((key) => !['framing', 'camera'].includes(key)) ||
        (Object.hasOwn(patch, 'framing') && patch.framing !== null && !validFraming(patch.framing)) ||
        (Object.hasOwn(patch, 'camera') && patch.camera !== null && !validCamera(patch.camera)))) fail(400, '校准数据无效');
      const trial = JSON.parse(row.trial);
      const calibration = { ...(trial.calibration ?? {}) };
      if (patch === null) delete trial.calibration;
      else {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete calibration[key];
          else calibration[key] = value;
        }
        if (Object.keys(calibration).length) trial.calibration = calibration;
        else delete trial.calibration;
      }
      q.calibration.run(JSON.stringify(trial), Date.now(), id);
      return trial.calibration ?? null;
    },

    // ---- drafts: stage → trial load → submit --------------------------------------------
    createDraft(user, taskId, filename, buffer, template = null) {
      const task = catalog.task(taskId);
      if (!task) fail(404, '题目不存在');
      if (!task.acceptsUploads) fail(409, '这道题的提示词原文尚未公开，暂不接受上传');
      purgeDrafts();
      const allowed = task.templates ?? ['static', 'vite'];
      if (template && !allowed.includes(template)) fail(400, '该题不支持此提交格式');
      const selected = template ?? (allowed.length === 1 ? allowed[0] : null);
      const inspected = inspectUpload(buffer, filename, { limits, cdn: config.cdn, template: selected });
      const format = selected ?? (inspected.files.has('package.json') && inspected.root ? 'vite' : 'static');
      if (!allowed.includes(format)) fail(400, '该题不支持此提交格式');
      if (format === 'vite' && (!inspected.files.has('package.json') || !inspected.root)) fail(400, 'Vite 项目请包含 package.json 和构建后的 dist/ 目录');
      const curatedTwin = catalog.duplicateOf(inspected.entryDigest);
      const uploadTwin = q.workByDigest.get(inspected.digest);
      if (curatedTwin) inspected.checks.push({ id: 'duplicate', state: 'warn', label: '重复检测', detail: `入口页面与馆藏作品「${curatedTwin.title}」（${curatedTwin.modelName}）完全相同，核验时会重点比对。` });
      else if (uploadTwin) inspected.checks.push({ id: 'duplicate', state: 'warn', label: '重复检测', detail: `与已上传的作品「${uploadTwin.title}」内容完全相同。` });
      else inspected.checks.push({ id: 'duplicate', state: 'ok', label: '重复检测', detail: '未发现与已有作品相同的内容' });

      // Keep only the newest drafts of each author.
      for (const { id } of q.draftsOf.all(user.id).slice(limits.draftsPerUser - 1)) {
        rmSync(join(dirs.drafts, id), { recursive: true, force: true });
        q.deleteDraft.run(id);
      }
      const id = randomBytes(10).toString('hex');
      writeTree(join(dirs.drafts, id), inspected.files);
      const now = Date.now();
      q.insertDraft.run(id, user.id, taskId, token('d'), clip(filename, 120) || 'upload', inspected.root, inspected.entry,
        inspected.count, inspected.bytes, inspected.digest, JSON.stringify(inspected.checks), now, now + limits.draftTtl);
      return publicDraft(q.draft.get(id));
    },

    draftByToken(key) {
      const row = q.draftByToken.get(key, Date.now());
      return row ? { ...row, dir: join(dirs.drafts, row.id, row.root) } : null;
    },
    draftTask(id) { return q.draft.get(id)?.task_id ?? null; },

    discardDraft(user, id) {
      const row = q.draft.get(id);
      if (!row || row.owner_id !== user.id) fail(404, '试加载已结束');
      rmSync(join(dirs.drafts, id), { recursive: true, force: true });
      q.deleteDraft.run(id);
    },

    submit(user, body) {
      const draft = q.draft.get(String(body.draftId ?? ''));
      if (!draft || draft.owner_id !== user.id || draft.expires_at <= Date.now()) fail(404, '试加载已过期，请重新选择文件');
      if (body.confirmed !== true) fail(400, '请先确认作品在试加载中运行正常');
      const title = clip(body.title, 40);
      if (!title) fail(400, '请填写作品标题');
      const source = provenance(body);
      const tool = clip(body.tool, 40) || (source.harnessId ? catalog.harness(source.harnessId).name : source.harnessOther);
      if (user.role !== 'admin' && !tool && !source.harnessId && !source.harnessOther) fail(400, '请选择或填写 Harness');
      const who = identity(body);
      const cover = coverFrom(body.cover);
      // Admins stage inbox registrations as unverified works in bulk; the per-user
      // pending cap only exists to throttle regular submitters.
      if (user.role !== 'admin' && q.pendingOf.get(user.id).n >= limits.pendingPerUser) fail(429, `你已有 ${limits.pendingPerUser} 件作品在等待核验，请等核验后再上传`);

      let id = workId();
      while (q.work.get(id)) id = workId();
      const now = Date.now();
      const staged = join(dirs.drafts, draft.id);
      const stored = join(dirs.works, id);
      const coverName = cover ? `cover.${cover.type.ext}` : null;
      const media = join(dirs.media, id);
      const pendingCover = coverName ? join(media, `${coverName}.tmp`) : null;
      if (cover) {
        mkdirSync(media, { recursive: true });
        try { writeFileSync(pendingCover, cover.buffer); }
        catch (error) { rmSync(media, { recursive: true, force: true }); throw error; }
      }
      let moved = false;
      let committed = false;
      try {
        renameSync(staged, stored);
        moved = true;
        transaction(db, () => {
          q.insertWork.run(id, draft.task_id, user.id, title, clip(body.summary, 200), who.modelId, who.modelName, who.vendor,
            effortOf(body.effort), tool, source.harnessId, source.harnessOther, source.harnessVersion, source.providerId,
            source.providerOther, clip(body.note, 1000), token('w'), draft.source_name, draft.root, draft.entry, draft.file_count,
            draft.bytes, draft.digest, draft.checks, JSON.stringify(sanitizeTrial(body.trial)), coverName, now, now);
          q.deleteDraft.run(draft.id);
          q.audit.run(now, user.id, user.name, 'submit', draft.task_id, id, `${who.modelName}${effortOf(body.effort) ? ` · ${effortOf(body.effort)}` : ''}`);
        });
        committed = true;
        if (cover) renameSync(pendingCover, join(media, coverName));
      } catch (error) {
        if (committed) transaction(db, () => {
          q.deleteSubmitAudit.run(id);
          q.deleteWork.run(id);
          q.restoreDraft.run(draft.id, draft.owner_id, draft.task_id, draft.token, draft.source_name, draft.root,
            draft.entry, draft.file_count, draft.bytes, draft.digest, draft.checks, draft.created_at, draft.expires_at);
        });
        if (moved) renameSync(stored, staged);
        if (cover) rmSync(media, { recursive: true, force: true });
        throw error;
      }
      return upload(draft.task_id, id);
    },

    markCurated(admin, work, curatedId) {
      q.curatedAs.run(curatedId, Date.now(), work.id);
      audit(admin, 'curate', work, `收录为馆藏 ${curatedId}`);
    },

    setMeta(admin, taskId, id, body) {
      const work = upload(taskId, id);
      if (!work) fail(404, '作品不存在', 'not_found');
      if (!plainObject(body) || !Object.keys(body).length ||
        Object.keys(body).some((key) => !['title', 'summary', 'modelName', 'modelId', 'effort',
          'harnessId', 'harnessOther', 'harnessVersion', 'providerId', 'providerOther'].includes(key))) fail(400, '没有可修改的内容');
      const title = body.title === undefined ? work.title : clip(body.title, 40);
      if (!title) fail(400, '请填写作品标题');
      const summary = body.summary === undefined ? work.summary : clip(body.summary, 200);
      const who = body.modelId !== undefined || body.modelName !== undefined ? identity(body) : work;
      const effort = body.effort !== undefined ? effortOf(body.effort) : work.effort;
      const source = provenance(body, work);
      q.meta.run(title, summary, who.modelId, who.modelName, who.vendor, effort,
        source.harnessId, source.harnessOther, source.harnessVersion, source.providerId, source.providerOther, Date.now(), id);
      audit(admin, 'meta', work, '编辑信息');
      return this.adminWork(upload(taskId, id));
    },

    setCaptures(id, captures) {
      q.captures.run(JSON.stringify(captures), id);
    },

    // ---- review and removal -----------------------------------------------------------
    review(admin, taskId, id, body) {
      const work = upload(taskId, id);
      if (!work) fail(404, '作品不存在');
      const status = String(body.status ?? '');
      if (!['verified', 'questioned', 'unverified'].includes(status)) fail(400, '审核结果无效');
      const reason = clip(body.reason, 500);
      if (status === 'questioned' && !reason) fail(400, '标记存疑时请写明原因，作者和访客都会看到');
      const who = body.modelId !== undefined || body.modelName !== undefined ? identity(body) : work;
      const effort = body.effort !== undefined ? effortOf(body.effort) : work.effort;
      const source = provenance(body, work);
      const audience = body.audience === undefined ? work.audience : String(body.audience);
      if (!['hidden', 'show1', 'show2', 'both'].includes(audience)) fail(400, '展示站点无效');
      for (const key of ['show_gallery', 'show_arena']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, '门面开关无效', 'invalid_face_settings');
      const fromAudience = { hidden: [false, false], show1: [false, true], show2: [true, false], both: [true, true] }[audience];
      const gallery = body.show_gallery ?? (body.audience === undefined ? work.showGallery : fromAudience[0]);
      const arena = body.show_arena ?? (body.audience === undefined ? work.showArena : fromAudience[1]);
      const nextAudience = gallery && arena ? 'both' : gallery ? 'show2' : arena ? 'show1' : 'hidden';
      if (work.audience === 'hidden' && status === 'verified' && nextAudience === 'hidden' && body.show_gallery === undefined && body.show_arena === undefined) fail(400, '请选择审核通过后展示的网站');
      if (nextAudience !== 'hidden' && status !== 'verified' && work.audience === 'hidden') fail(400, '隐藏作品须先审核通过才能发布');
      const title = body.title === undefined ? work.title : clip(body.title, 40);
      if (!title) fail(400, '请填写作品标题');
      const summary = body.summary === undefined ? work.summary : clip(body.summary, 200);
      const now = Date.now();
      q.review.run(status, status === 'verified' ? '' : reason, who.modelId, who.modelName, who.vendor, effort,
        source.harnessId, source.harnessOther, source.harnessVersion, source.providerId, source.providerOther,
        nextAudience, Number(gallery), Number(arena), title, summary, admin.id, now, now, id);
      const updated = upload(taskId, id);
      const labels = { verified: '通过验证', questioned: '标记存疑', unverified: '退回未验证' };
      audit(admin, status, updated, [labels[status], reason].filter(Boolean).join('：'));
      return updated;
    },

    remove(user, taskId, id) {
      if (catalog.work(taskId, id)) fail(409, '馆藏作品由仓库收录流程管理，需要在仓库中移除');
      const work = upload(taskId, id);
      if (!work) fail(404, '作品不存在');
      if (work.ownerId !== user.id && user.role !== 'admin') fail(403, '只能删除自己上传的作品');
      const votes = q.votesOfWork.get(taskId, id, id).n;
      if (votes > 0) fail(409, `这件作品已有 ${votes} 票对局记录，删除会破坏历史。请用「标记存疑」让它下线`);
      const now = Date.now();
      q.remove.run(now, user.id, now, id);
      rmSync(join(dirs.works, id), { recursive: true, force: true });
      rmSync(join(dirs.media, id), { recursive: true, force: true });
      audit(user, 'delete', work, user.id === work.ownerId ? '作者删除' : '管理员删除');
    },

    // ---- reactions -------------------------------------------------------------------------
    react(user, taskId, id, emoji) {
      const work = catalog.work(taskId, id) ?? upload(taskId, id);
      if (!work) fail(404, '作品不存在');
      if (!isInteractive(work)) fail(409, '存疑作品仅供参考，不能再互动');
      if (!EMOJIS.includes(emoji)) fail(400, '不支持这个表情');
      if (q.reaction.get(taskId, id, user.id, emoji)) q.dropReaction.run(taskId, id, user.id, emoji);
      else q.addReaction.run(taskId, id, user.id, emoji, Date.now());
      const mine = q.myReactions.all(user.id).filter((row) => row.task_id === taskId && row.work_id === id).map((row) => row.emoji);
      return { counts: reactionsOf(taskId, id), mine };
    },

    reactionSummary(user, site = 'show2') {
      const counts = {};
      const shown = (row) => visibleTo(catalog.work(row.task_id, row.work_id) ?? upload(row.task_id, row.work_id), site);
      for (const row of q.reactionCounts.all()) if (shown(row)) (counts[`${row.task_id}/${row.work_id}`] ??= {})[row.emoji] = row.n;
      const mine = {};
      if (user) for (const row of q.myReactions.all(user.id)) if (shown(row)) (mine[`${row.task_id}/${row.work_id}`] ??= []).push(row.emoji);
      return { counts, mine };
    },

    pendingCount: (userId) => q.pendingOf.get(userId).n,
    auditLog(limit = 200) {
      return q.auditLog.all(limit).map((row) => ({ at: iso(row.at), actor: row.actor_name, action: row.action, task: row.task_id, work: row.work_id, detail: row.detail }));
    },
    hasDirectory: (id) => existsSync(join(dirs.works, id)),
  };
}
