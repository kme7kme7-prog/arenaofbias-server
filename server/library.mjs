// Every work the platform knows: data package files plus submitted uploads.
// Uploads move through unverified → verified | questioned; drafts hold a staged upload
// until its author has watched the trial load and submits it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { EFFORTS, EMOJIS } from './config.mjs';
import { transaction } from './db.mjs';
import { providerOf } from './catalog.mjs';
import { avatarOf } from './auth.mjs';
import { authorOf, isStaff, isSenior, roleOf } from './roles.mjs';
import { fail } from './http.mjs';
import { inspectUpload } from './inspect.mjs';
import { isTextTask, templatesOf } from './categories.mjs';
import { GENERATION_FIELDS, IGNORED_GENERATION_FIELDS, generationFrom, generationOf, generationAudit, generationAuditView } from './generation.mjs';
import { readWorkPreview } from './work-previews.mjs';

const token = (prefix) => `${prefix}${randomBytes(16).toString('hex')}`;
const workId = () => `up-${[...randomBytes(8)].map((byte) => (byte % 36).toString(36)).join('')}`;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const clip = (value, max) => String(value ?? '').normalize('NFKC').trim().slice(0, max);
const defaultTitle = (modelName, effort) => [modelName, effort].filter(Boolean).join(' · ').slice(0, 40);
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const pendingModeration = () => ({ status: 'pending', revision: token('r'), at: Date.now() });
const moderationText = (work) => JSON.stringify([work.title, work.summary, work.modelName, work.modelId ? '' : work.vendor, work.effort, work.note,
  work.harnessOther, work.providerOther, ...GENERATION_FIELDS.map((key) => work[key])]);
// Only a human's reason reaches the author; model text could carry what an injected upload asked for.
const authorModeration = ({ status, reason, source, at }) => ({ status,
  ...(status === 'rejected' ? { reason: source === 'human' ? reason : '自动内容审查未通过，请联系管理员' } : {}), at });

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

export function createLibrary({ db, catalog, config, limits, legacyRounds = new Set() }) {
  const contentAllowedEffective = (work) => Boolean(work && !work.curatedAs && catalog.task(work.taskId) &&
    (work.curated || ['legacy', 'approved'].includes(work.moderation?.status)));
  const contentAllowed = (work) => contentAllowedEffective(withDisplay(work));
  // Public surfaces additionally wait for a human decision on uploads (a review status or a
  // manual content approval): an automatic approval alone only reaches owner and admin previews.
  const publicContentEffective = (work) => Boolean(contentAllowedEffective(work) &&
    (!(work.curated || ['admin', 'moderator'].includes(work.authorRole)) || work.status !== 'unverified') &&
    (work.curated || work.status !== 'unverified' || work.moderation?.source === 'human'));
  const publicContent = (work) => publicContentEffective(withDisplay(work));
  const dirs = { drafts: join(config.dataDir, 'drafts'), works: join(config.dataDir, 'works'), media: join(config.dataDir, 'media') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const originOf = (key) => config.contentTemplate.replace('{token}', key);
  // Short-lived bearer previews are only issued in owner/admin responses. Public
  // work hosts never serve a held upload, even when its old URL is known.
  // Datapack ids repeat across tasks, so a key belongs to one task/id pair.
  const previews = new Map(), previewOf = new Map();
  function previewKey(work) {
    const now = Date.now(), id = `${work.taskId}/${work.id}`;
    const current = previewOf.get(id);
    if (current && previews.get(current)?.expiresAt > now) return current;
    for (const [key, value] of previews) if (value.expiresAt <= now) { previews.delete(key); previewOf.delete(`${value.task}/${value.id}`); }
    const key = token('p');
    previews.set(key, { id: work.id, task: work.taskId, expiresAt: now + 3600e3 });
    previewOf.set(id, key);
    return key;
  }

  const WORK = `SELECT works.*, owner.avatar AS owner_avatar, owner.id AS author_id, owner.role AS owner_role,
    COALESCE(NULLIF(owner.nickname, ''), owner.name) AS owner_name,
    COALESCE(NULLIF(reviewer.nickname, ''), reviewer.name, review_audit.actor_name) AS reviewer_name FROM works
    LEFT JOIN users owner ON owner.id = works.owner_id
    LEFT JOIN audit review_audit ON review_audit.id = (
      SELECT id FROM audit WHERE work_id = works.id AND action IN ('verified', 'questioned', 'unverified') ORDER BY id DESC LIMIT 1)
    LEFT JOIN users reviewer ON reviewer.id = review_audit.actor_id`;
  const liveWork = `works.deleted_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM questions WHERE questions.id = works.task_id AND questions.deleted_at IS NOT NULL)`;
  const changedAt = `MAX(COALESCE(works.reviewed_at, 0), CASE
    WHEN json_extract(works.moderation, '$.status') IN ('approved', 'rejected')
    THEN COALESCE(json_extract(works.moderation, '$.at'), 0) ELSE 0 END)`;
  const q = {
    draft: db.prepare('SELECT * FROM drafts WHERE id = ?'),
    draftByToken: db.prepare('SELECT * FROM drafts WHERE token = ? AND expires_at > ?'),
    draftsOf: db.prepare('SELECT id FROM drafts WHERE owner_id = ? ORDER BY created_at DESC'),
    latestDraft: db.prepare('SELECT * FROM drafts WHERE owner_id = ? AND task_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'),
    expiredDrafts: db.prepare('SELECT id FROM drafts WHERE expires_at <= ?'),
    insertDraft: db.prepare(`INSERT INTO drafts (id, owner_id, task_id, token, source_name, root, entry, file_count, bytes, digest, checks, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteDraft: db.prepare('DELETE FROM drafts WHERE id = ?'),
    work: db.prepare(`${WORK} WHERE works.id = ? AND ${liveWork}`),
    questionExists: db.prepare('SELECT 1 FROM questions WHERE id = ? AND deleted_at IS NULL'),
    // Re-homing an upload to another task moves its historical ballots, matches,
    // comments and reactions along, so nothing points at the old task afterwards.
    moveWorkTask: db.prepare('UPDATE works SET task_id = ?, updated_at = ? WHERE id = ?'),
    moveVotes: db.prepare('UPDATE votes SET task_id = ? WHERE task_id = ? AND (a_work = ? OR b_work = ?)'),
    moveMatches: db.prepare('UPDATE matches SET task_id = ? WHERE task_id = ? AND (a_work = ? OR b_work = ?)'),
    moveComments: db.prepare('UPDATE comments SET task_id = ? WHERE task_id = ? AND work_id = ?'),
    moveReactions: db.prepare('UPDATE reactions SET task_id = ? WHERE task_id = ? AND work_id = ?'),
    storedWork: db.prepare('SELECT id, cover FROM works WHERE id = ?'),
    workByKey: db.prepare(`${WORK} WHERE works.content_key = ? AND ${liveWork}`),
    workByDigest: db.prepare('SELECT id, title, task_id FROM works WHERE digest = ? AND deleted_at IS NULL LIMIT 1'),
    works: db.prepare(`${WORK} WHERE ${liveWork} ORDER BY works.created_at DESC`),
    worksOfTask: db.prepare(`${WORK} WHERE works.task_id = ? AND ${liveWork}`),
    worksOfOwner: db.prepare(`${WORK} WHERE works.owner_id = ? AND ${liveWork} ORDER BY works.created_at DESC`),
    pendingOf: db.prepare(`SELECT COUNT(*) AS n FROM works WHERE owner_id = ? AND status = 'unverified'
      AND ${liveWork} AND COALESCE(json_extract(works.moderation, '$.status'), '') != 'rejected'
      AND NOT EXISTS (SELECT 1 FROM questions WHERE questions.id = works.task_id
        AND json_extract(questions.moderation, '$.status') = 'rejected')`),
    trustOf: db.prepare(`SELECT
      COUNT(*) FILTER (WHERE status = 'verified' AND deleted_at IS NULL) AS verified,
      COUNT(*) FILTER (WHERE status = 'questioned' AND reviewed_at >= ?) +
        (SELECT COUNT(*) FROM audit JOIN works questioned ON questioned.id = audit.work_id
          WHERE questioned.owner_id = ? AND audit.action = 'questioned' AND audit.at >= ?) AS questioned
      FROM works WHERE owner_id = ?`),
    worksSeen: db.prepare('SELECT works_seen_at FROM users WHERE id = ?'),
    markWorksSeen: db.prepare('UPDATE users SET works_seen_at = ? WHERE id = ?'),
    updatesOf: db.prepare(`SELECT COUNT(*) AS n FROM works WHERE owner_id = ? AND deleted_at IS NULL AND ${changedAt} > ?`),
    recentReviews: db.prepare(`SELECT (reviewed_at - created_at) / 3600000.0 AS hours FROM works
      WHERE status = 'verified' AND deleted_at IS NULL AND reviewed_at >= ? ORDER BY hours`),
    insertWork: db.prepare(`INSERT INTO works (id, task_id, owner_id, title, summary, model_id, model_other, model_vendor, effort,
      harness_id, harness_other, provider_id, provider_other, note, content_key,
      source_name, root, entry, file_count, bytes, digest, checks, trial, cover, created_at, updated_at,
      generation_mode, human_intervention, moderation, prompt_variant, author_role, show_gallery, show_arena)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`),
    review: db.prepare(`UPDATE works SET status = ?, status_reason = ?, model_id = ?, model_other = ?, model_vendor = ?, effort = ?,
      harness_id = ?, harness_other = ?, provider_id = ?, provider_other = ?,
      generation_mode = ?, human_intervention = ?,
      show_gallery = ?, show_arena = ?, show_entertainment = ?, entertainment_route = ?, title = ?, summary = ?, note = ?, reviewed_at = ?,
      reviewed_gallery_at = COALESCE(?, reviewed_gallery_at), reviewed_arena_at = COALESCE(?, reviewed_arena_at), updated_at = ? WHERE id = ?`),
    remove: db.prepare('UPDATE works SET deleted_at = ?, updated_at = ? WHERE id = ?'),
    captures: db.prepare('UPDATE works SET captures = ? WHERE id = ?'),
    moderation: db.prepare('UPDATE works SET moderation = ? WHERE id = ? AND deleted_at IS NULL'),
    moderationResult: db.prepare('UPDATE works SET moderation = ? WHERE id = ? AND moderation = ? AND deleted_at IS NULL'),
    calibration: db.prepare('UPDATE works SET trial = ?, updated_at = ? WHERE id = ?'),
    arenaCalibration: db.prepare('UPDATE works SET calibration_arena = ?, updated_at = ? WHERE id = ?'),
    faceSettings: db.prepare(`UPDATE works SET show_gallery = ?, show_arena = ?, show_entertainment = ?,
      reviewed_gallery_at = COALESCE(?, reviewed_gallery_at), reviewed_arena_at = COALESCE(?, reviewed_arena_at), updated_at = ? WHERE id = ?`),
    meta: db.prepare(`UPDATE works SET title = ?, summary = ?, model_id = ?, model_other = ?, model_vendor = ?, effort = ?,
      harness_id = ?, harness_other = ?, provider_id = ?, provider_other = ?,
      generation_mode = ?, human_intervention = ?,
      prompt_variant = ?, note = ?, updated_at = ? WHERE id = ?`),
    votesOfWork: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE task_id = ? AND (a_work = ? OR b_work = ?)'),
    override: db.prepare(`SELECT work_overrides.*, COALESCE(NULLIF(reviewer.nickname, ''), reviewer.name) AS reviewer_name
      FROM work_overrides LEFT JOIN users reviewer ON reviewer.id = work_overrides.reviewer_id WHERE task_id = ? AND work_id = ?`),
    setOverride: db.prepare(`INSERT INTO work_overrides (task_id, work_id, show_gallery, show_arena, show_entertainment, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET
      show_gallery = excluded.show_gallery, show_arena = excluded.show_arena, show_entertainment = excluded.show_entertainment,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    setDisplay: db.prepare(`INSERT INTO work_overrides (task_id, work_id, display_json, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET
      display_json = excluded.display_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    reviewPack: db.prepare(`INSERT INTO work_overrides (task_id, work_id, status, reason, reviewer_id, reviewed_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET status = excluded.status,
      reason = excluded.reason, reviewer_id = excluded.reviewer_id, reviewed_at = excluded.reviewed_at,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    removePack: db.prepare(`INSERT INTO work_overrides (task_id, work_id, deleted_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, work_id) DO UPDATE SET deleted_at = excluded.deleted_at,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    setRoute: db.prepare('UPDATE works SET entertainment_route = ?, updated_at = ? WHERE id = ?'),
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

  function fromRow(row, archive = catalog) {
    const model = row.model_id ? archive.model(row.model_id) : null;
    return {
      taskId: row.task_id,
      id: row.id,
      curated: false,
      status: row.status,
      moderation: JSON.parse(row.moderation),
      moderationRaw: row.moderation,
      audience: row.show_gallery && row.show_arena ? 'both' : row.show_gallery ? 'show2' : row.show_arena ? 'show1' : 'hidden',
      showGallery: Boolean(row.show_gallery),
      showArena: Boolean(row.show_arena),
      showEntertainment: Boolean(row.show_entertainment),
      entertainmentRoute: row.entertainment_route ?? 0,
      curatedAs: row.curated_as ?? null,
      nominatedAt: row.nominated_at ?? null,
      calibrationArena: row.calibration_arena ? JSON.parse(row.calibration_arena) : null,
      reason: row.status_reason,
      title: row.title,
      summary: row.summary,
      modelId: row.model_id,
      modelName: row.model_id ? (model?.name ?? row.model_id) : row.model_other,
      vendor: row.model_id ? (model?.vendor ?? '') : row.model_vendor,
      effort: row.effort,
      tool: row.harness_id ? (archive.harness(row.harness_id)?.name ?? row.harness_id) : row.harness_other,
      harnessId: row.harness_id,
      harnessOther: row.harness_other,
      providerId: providerOf(row.provider_id, row.provider_other),
      providerOther: '',
      generationMode: row.generation_mode === 'agent' ? 'single-turn' : row.generation_mode,
      humanIntervention: row.human_intervention,
      promptVariant: row.prompt_variant,
      note: row.note,
      ownerId: row.owner_id,
      ownerName: row.owner_name ?? null,
      authorRole: roleOf(row.author_role ?? row.owner_role),
      ownerAvatar: row.author_id ? avatarOf({ id: row.author_id, avatar: row.owner_avatar }) : null,
      reviewerName: row.reviewer_name ?? null,
      reviewedAt: row.reviewed_at,
      reviewedGalleryAt: row.reviewed_gallery_at,
      reviewedArenaAt: row.reviewed_arena_at,
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

  function seenAt(userId) {
    return q.worksSeen.get(userId)?.works_seen_at ?? Date.now() - 7 * 24 * 3600e3;
  }

  function workChangedAt(work) {
    return Math.max(work.reviewedAt ?? 0,
      ['approved', 'rejected'].includes(work.moderation.status) ? work.moderation.at ?? 0 : 0);
  }

  function pendingLimit(user) {
    if (isStaff(user)) return null;
    const since = Date.now() - 90 * 24 * 3600e3;
    const credit = q.trustOf.get(since, user.id, since, user.id);
    return credit.verified >= limits.trustedMinVerified && credit.questioned === 0
      ? limits.trustedPendingPerUser : limits.pendingPerUser;
  }

  function audit(actor, action, work, detail = '') {
    q.audit.run(Date.now(), actor?.id ?? null, actor?.name ?? '系统', action, work?.taskId ?? null, work?.id ?? null, detail);
  }

  function upload(taskId, id, archive = catalog) {
    const row = q.work.get(id);
    return row && row.task_id === taskId ? fromRow(row, archive) : null;
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

  const flagsOf = (work, override = undefined) => {
    if (!work) return { show_gallery: false, show_arena: false, show_entertainment: false };
    if (work.curated) {
      const row = override === undefined ? q.override.get(work.taskId, work.id) : override;
      // 数据包作品视同已核验的投稿：默认三面都开，管理员可逐件关闭。旧 Show1 快照
      // 已有的轮次里同一作品早以投稿身份在娱乐名单中，这些题的娱乐面默认关闭。
      const entertainment = !legacyRounds.size || !legacyRounds.has(catalog.task(work.taskId)?.arenaId);
      return { show_gallery: Boolean(row?.show_gallery ?? 1), show_arena: Boolean(row?.show_arena ?? 1), show_entertainment: Boolean(row?.show_entertainment ?? entertainment) };
    }
    return { show_gallery: work.showGallery, show_arena: work.showArena, show_entertainment: Boolean(work.showEntertainment) };
  };
  const inInbox = (work) => Boolean(work && !work.curated && work.entertainmentRoute === 1);
  const publicCuratedContent = (work) => {
    const current = withDisplay(work);
    return Boolean(work?.curated && work.status === 'verified' && current?.status === 'verified' && current.dir &&
      (!work.moderation || ['legacy', 'approved'].includes(work.moderation.status)) &&
      publicContentEffective(current) && !inInbox(current) && current.showEntertainment);
  };
  const curatedKeys = {
    byWork: db.prepare('SELECT content_key FROM curated_content_keys WHERE task_id = ? AND work_id = ?'),
    byKey: db.prepare('SELECT task_id, work_id FROM curated_content_keys WHERE content_key = ?'),
    add: db.prepare('INSERT OR IGNORE INTO curated_content_keys (task_id, work_id, content_key) VALUES (?, ?, ?)'),
  };
  const visibleEffective = (work, site) => Boolean(work && !inInbox(work) && publicContentEffective(work) &&
    (site === 'show1' ? work.showArena : work.showGallery));
  const visibleTo = (work, site = 'show2') => visibleEffective(withDisplay(work), site);
  // Text tasks keep their earlier rules; other works must be single-turn without human intervention.
  const generationQualified = (work) => isTextTask(catalog.task(work.taskId)) ||
    generationOf(work).generationMode === 'single-turn' && work.humanIntervention === 'none';
  const eligibleEffective = (work) => Boolean(work && work.status === 'verified' && work.dir && !work.curatedAs &&
    visibleEffective(work, 'show1') && generationQualified(work));
  const isEligible = (work) => eligibleEffective(withDisplay(work));
  // The blind-pool rule read once for every client: in the pool, turned off by an admin, or why not.
  const arenaState = (work) => {
    if (eligibleEffective(work)) return { state: 'in_pool' };
    if (work.status !== 'verified' || !publicContentEffective(work)) return { state: 'waiting' };
    if (!work.showArena) return { state: 'off' };
    const { generationMode, humanIntervention } = generationOf(work);
    return { state: 'not_qualified', reason: generationMode === 'multi-turn' ? '多轮生成'
      : humanIntervention && humanIntervention !== 'none' ? '有人工介入' : '生成方式未填写' };
  };
  const isInteractive = (raw) => {
    const work = withDisplay(raw);
    return Boolean(work && work.status !== 'questioned' && (visibleEffective(work, 'show1') || visibleEffective(work, 'show2')));
  };

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
      providerId: providerOf(current.providerId, current.providerOther),
      providerOther: '',
    };
    const fieldText = (value, label) => {
      const text = String(value ?? '').normalize('NFKC').trim();
      if ([...text].length > 40) fail(400, `${label}不能超过 40 字`);
      return text;
    };
    for (const [prefix, lookup, label] of [['harness', 'harness', 'Harness']]) {
      const idField = `${prefix}Id`, otherField = `${prefix}Other`;
      const hasId = Object.hasOwn(body, idField), hasOther = Object.hasOwn(body, otherField);
      if (!hasId && !hasOther) continue;
      // An empty id means "not stated", the same as null.
      const id = hasId && body[idField] !== '' ? body[idField] : null;
      const other = hasOther ? fieldText(body[otherField], label) : '';
      if (hasId && id !== null && (typeof id !== 'string' || !catalog[lookup](id))) fail(400, `所选${label}不存在`);
      if (id && other) fail(400, `${label}不能同时填写登记项和其他`);
      if (id) { next[idField] = id; next[otherField] = ''; }
      else if (hasOther && other) { next[idField] = null; next[otherField] = other; }
      else { next[idField] = null; next[otherField] = ''; }
    }
    if (Object.hasOwn(body, 'providerId')) {
      const id = body.providerId === '' ? null : body.providerId;
      if (id !== null && (typeof id !== 'string' || !catalog.provider(id))) fail(400, '所选服务商不存在');
      next.providerId = id;
    }
    return next;
  }

  // Tasks with several prompt versions need each upload to name the one it answers.
  const promptVariantFrom = (taskId, body, current = '', required = false) => {
    const variants = catalog.task(taskId)?.promptVariants ?? [];
    const value = Object.hasOwn(body, 'promptVariant') ? String(body.promptVariant ?? '') : current;
    if (!variants.length) return '';
    if (value && !variants.some((variant) => variant.id === value)) fail(400, '提示词版本无效', 'invalid_prompt_variant');
    if (!value && required) fail(400, '请选择生成时使用的提示词版本', 'invalid_prompt_variant');
    return value;
  };
  const publicProvenance = (work) => ({
    ...generationOf(work),
    harness: work.harnessId ?? null,
    harnessName: work.harnessId ? (catalog.harness(work.harnessId)?.name ?? work.harnessId) : (work.harnessOther || null),
    provider: providerOf(work.providerId, work.providerOther),
  });

  const effortOf = (value) => {
    const effort = clip(value, 20);
    const known = EFFORTS.find((item) => item.toLowerCase() === effort.toLowerCase());
    return known ?? effort;
  };
  const DISPLAY_KEYS = ['title', 'summary', 'modelId', 'modelName', 'vendor', 'effort', 'harnessId', 'harnessOther', 'providerId', 'generationMode', 'humanIntervention', 'promptVariant', 'note'];
  function withDisplay(work) {
    if (!work?.curated) return work;
    const row = q.override.get(work.taskId, work.id);
    if (row?.deleted_at) return null;
    let patch = {};
    try { patch = JSON.parse(row?.display_json || '{}'); } catch { /* ignore malformed display data */ }
    const next = { ...work, status: row?.status ?? 'verified', reason: row?.reason ?? '',
      moderation: { status: 'approved', source: 'human' }, reviewedAt: row?.reviewed_at ?? null, reviewerName: row?.reviewer_name ?? null };
    for (const key of DISPLAY_KEYS) if (typeof patch[key] === 'string' || patch[key] === null) {
      if (key === 'modelId') next.displayModelId = patch[key];
      else next[key] = patch[key];
    }
    const flags = flagsOf(work, row ?? null);
    Object.assign(next, {
      showGallery: flags.show_gallery, showArena: flags.show_arena,
      showEntertainment: flags.show_entertainment,
      audience: flags.show_gallery ? (flags.show_arena ? 'both' : 'show2') : (flags.show_arena ? 'show1' : 'hidden'),
    });
    if (next.harnessId) next.tool = catalog.harness(next.harnessId)?.name ?? next.harnessId;
    else if (next.harnessOther) next.tool = next.harnessOther;
    else if (Object.hasOwn(patch, 'harnessId') || Object.hasOwn(patch, 'harnessOther')) next.tool = '';
    return next;
  }

  function requireStaff(actor, work, decision = true) {
    if (!isStaff(actor)) fail(403, '需要管理员权限');
    if (decision && !isSenior(actor) && work?.ownerId === actor.id) fail(403, '需由其他管理员处理自己发布的作品');
  }
  const displayIdentity = (work) => work.curated && Object.hasOwn(work, 'displayModelId')
    ? { ...work, modelId: work.displayModelId } : work;

  return {
    isEligible,
    isInteractive,
    visibleTo,
    flagsOf,
    originOf,
    audit,
    mediaDir: dirs.media,
    contentAllowed,
    publicContent,
    publicCuratedContent,
    curatedContentKey(work) {
      // Re-read the work: a stale object must not issue a public address after removal.
      const current = work && this.work(work.taskId, work.id);
      if (!publicCuratedContent(current)) return null;
      const existing = curatedKeys.byWork.get(current.taskId, current.id);
      if (existing) return existing.content_key;
      curatedKeys.add.run(current.taskId, current.id, token('c'));
      return curatedKeys.byWork.get(current.taskId, current.id)?.content_key ?? null;
    },
    curatedByKey(key) {
      const row = curatedKeys.byKey.get(key);
      const work = row && this.work(row.task_id, row.work_id);
      return publicCuratedContent(work) ? work : null;
    },
    canRead(work, viewer) {
      work = withDisplay(work);
      return Boolean(work && (publicContentEffective(work) || viewer && (viewer.id === work.ownerId || isStaff(viewer))));
    },
    previewOrigin(work) { return originOf(previewKey(work)); },
    previewByKey(key) {
      const value = previews.get(key);
      if (!value || value.expiresAt <= Date.now()) { previews.delete(key); return null; }
      // Package works preview from the datapack directory; uploads from their own dir.
      return this.work(value.task, value.id);
    },
    uploadById(id) {
      const row = q.work.get(id);
      return row ? fromRow(row) : null;
    },

    work(taskId, id, snapshot = null) {
      const archive = snapshot ?? catalog.snapshot();
      const curated = archive.work(taskId, id);
      return curated ? withDisplay(curated) : upload(taskId, id, archive);
    },
    byContentKey(key) {
      const row = q.workByKey.get(key);
      return row ? fromRow(row) : null;
    },
    // Package works plus verified uploads: the pool blind comparisons draw from.
    eligible(taskId, snapshot = null) {
      const archive = snapshot ?? catalog.snapshot();
      return [...archive.works(taskId).map(withDisplay), ...q.worksOfTask.all(taskId).map((row) => fromRow(row, archive))].filter(isEligible);
    },
    allWorks() {
      return [...catalog.snapshot().tasks().flatMap((task) => [...task.works.values()].map(withDisplay)), ...this.uploads()]
        .filter((work) => work && !work.curatedAs && catalog.task(work.taskId, { role: 'admin' }));
    },
    uploads() {
      return q.works.all().map((row) => fromRow(row)).filter((work) => !work.curatedAs);
    },
    published(site) {
      return q.works.all().map((row) => fromRow(row)).filter((work) => !work.curatedAs && work.status === 'verified' && visibleTo(work, site));
    },
    uploadsOf(userId) {
      return q.worksOfOwner.all(userId).map((row) => fromRow(row)).filter((work) => !work.curatedAs);
    },
    // Gallery's queue also includes arena-verified uploads awaiting a gallery decision.
    reviewQueue() {
      return this.allWorks().filter((work) => !work.curatedAs && work.status !== 'questioned' && (work.curated ? work.status === 'unverified' : !work.reviewedGalleryAt)
        && contentAllowed(work)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },
    authorWorks(user) {
      const seen = seenAt(user.id);
      const queue = new Map(this.reviewQueue().map((work, index) => [work.id, index]));
      return this.uploadsOf(user.id).map((work) => ({
        ...this.toPublic(work, user),
        ...(work.status === 'unverified' && queue.has(work.id) ? { queueAhead: queue.get(work.id) } : {}),
        ...(workChangedAt(work) > seen ? { changed: true } : {}),
      }));
    },
    reviewStats() {
      const samples = q.recentReviews.all(Date.now() - 30 * 24 * 3600e3).map((row) => row.hours);
      if (samples.length < 5) return { medianHours: null };
      const middle = Math.floor(samples.length / 2);
      return { medianHours: samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2 };
    },

    toPublic(work, viewer, { admin = false } = {}) {
      work = withDisplay(work);
      if (!work) return null;
      if (work.curated) {
        return { task: work.taskId, id: work.id, author: authorOf({ role: 'admin', name: null, avatar: null }, admin), mine: false,
          title: work.title, summary: work.summary, model: Object.hasOwn(work, 'displayModelId') ? work.displayModelId : work.modelId, modelName: work.modelName, vendor: work.vendor,
          effort: work.effort, tool: work.tool, ...publicProvenance(work),
          ...(work.promptVariant ? { promptVariant: work.promptVariant } : {}), note: work.note ?? '',
          status: work.status, reason: work.reason, addedAt: work.addedAt, reviewedAt: iso(work.reviewedAt),
          ...(admin ? { moderation: work.moderation, audience: work.audience, reviewer: work.reviewerName } : {}) };
      }
      const privileged = admin || viewer && (viewer.id === work.ownerId || isStaff(viewer));
      return {
        task: work.taskId,
        id: work.id,
        title: work.title,
        summary: work.summary,
        model: work.modelId,
        modelName: work.modelName,
        vendor: work.vendor,
        effort: work.effort,
        tool: work.tool,
        ...publicProvenance(work),
        ...(work.promptVariant ? { promptVariant: work.promptVariant } : {}),
        note: work.note,
        status: work.status,
        ...(privileged ? { moderation: admin ? work.moderation : authorModeration(work.moderation) } : {}),
        ...(privileged ? { audience: work.audience, arena: arenaState(work) } : {}),
        reason: work.reason,
        author: authorOf({ role: work.authorRole, name: work.ownerName, avatar: work.ownerAvatar }, admin),
        mine: Boolean(viewer && viewer.id === work.ownerId),
        addedAt: iso(work.createdAt),
        reviewedAt: iso(work.reviewedAt),
        scene: `${!publicContent(work) && privileged ? originOf(previewKey(work)) : originOf(work.contentKey)}/`,
        captures: Object.fromEntries(Object.entries(work.captures).map(([id, file]) => [id, `media/${work.id}/${file}`])),
        cover: work.cover ? `media/${work.id}/${work.cover}` : null,
        files: work.files,
        bytes: work.bytes,
        calibration: work.trial.calibration ?? null,
        ...(!work.curated && this.canRead(work, viewer) ? readWorkPreview(dirs.media, work) : null),
        ...(privileged ? { checks: work.checks, trial: work.trial, sourceName: work.sourceName, root: work.root, entry: work.entry, reviewer: work.reviewerName } : {}),
      };
    },

    // Effective per-face calibration for a work: admin overrides for package works,
    // trial columns for uploads. Read-only; writers validate the shape.
    calibrationOf(work, face) {
      if (!work || (face !== 'arena' && face !== 'gallery')) return null;
      if (work.curated) {
        if (!work.taskId || !work.id) return null;
        const row = q.override.get(work.taskId, work.id);
        const value = row ? row[face === 'arena' ? 'calibration_arena' : 'calibration_gallery'] : null;
        try { return value ? JSON.parse(value) : null; } catch { return null; }
      }
      return face === 'arena' ? (work.calibrationArena ?? null) : (work.trial?.calibration ?? null);
    },

    adminWork(work, viewer = null) {
      work = withDisplay(work);
      const flags = { show_gallery: work.showGallery, show_arena: work.showArena, show_entertainment: work.showEntertainment };
      const override = work.curated ? q.override.get(work.taskId, work.id) : null;
      return {
        ...this.toPublic(work, viewer, { admin: true }),
        ...(work.curated ? {} : {
          reviewed: { gallery: iso(work.reviewedGalleryAt), arena: iso(work.reviewedArenaAt) } }),
        ...flags, calibration_gallery: work.curated ? (override?.calibration_gallery ? JSON.parse(override.calibration_gallery) : null) : work.trial.calibration ?? null,
        calibration_arena: work.curated ? (override?.calibration_arena ? JSON.parse(override.calibration_arena) : null) : work.calibrationArena,
        has_calibration_gallery: Boolean(work.curated ? override?.calibration_gallery : work.trial.calibration),
        has_calibration_arena: Boolean(work.curated ? override?.calibration_arena : work.calibrationArena),
        arena_eligible: eligibleEffective(work),
        arena_generation_ok: generationQualified(work),
        entertainment_route: work.entertainmentRoute ?? 0,
        arena: arenaState(work),
      };
    },

    setFaceSettings(admin, taskId, id, body, withinTransaction = false) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在', 'not_found');
      requireStaff(admin, work);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some((key) => !['show_gallery', 'show_arena', 'show_entertainment'].includes(key)) ||
        Object.values(body).some((value) => typeof value !== 'boolean')) fail(400, '门面开关无效', 'invalid_face_settings');
      const current = flagsOf(work);
      const gallery = body.show_gallery ?? current.show_gallery;
      const arena = body.show_arena ?? current.show_arena;
      // Uploaded settings live on the row; package settings use the override table.
      const entertainment = body.show_entertainment ?? current.show_entertainment;
      const now = Date.now();
      const apply = () => {
        if (work.curated) q.setOverride.run(taskId, id, Number(gallery), Number(arena), Number(entertainment), admin.id, now);
        else q.faceSettings.run(Number(gallery), Number(arena), Number(entertainment),
          Object.hasOwn(body, 'show_gallery') ? now : null, Object.hasOwn(body, 'show_arena') ? now : null, now, id);
        audit(admin, 'face-settings', work, JSON.stringify({ show_gallery: gallery, show_arena: arena, show_entertainment: entertainment }));
      };
      if (withinTransaction) apply();
      else transaction(db, apply);
      return this.adminWork(this.work(taskId, id), admin);
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
      requireStaff(admin, work);
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
      if (!row || ((!contentAllowed(fromRow(row)) || row.status !== 'verified' || !row.show_gallery) && viewer?.id !== row.owner_id && !isStaff(viewer))) fail(404, '作品不存在');
      return JSON.parse(row.trial).calibration ?? null;
    },

    setCalibration(user, id, patch) {
      const row = q.work.get(id);
      if (!row) fail(404, '作品不存在');
      if (isStaff(user)) requireStaff(user, fromRow(row));
      else if (row.owner_id !== user.id) fail(403, '只能校准自己的作品');
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
      const task = taskId === '__new__' ? { acceptsUploads: true, templates: ['static', 'vite', 'text'] } : catalog.task(taskId, user);
      if (!task) fail(404, '题目不存在');
      if (!task.acceptsUploads) fail(409, '这道题暂不接受上传');
      purgeDrafts();
      const allowed = templatesOf(task);
      if (template && !allowed.includes(template)) fail(400, '该题不支持此提交格式');
      const selected = template ?? (allowed.length === 1 ? allowed[0] : /\.(txt|md|markdown)$/i.test(filename) && allowed.includes('text') ? 'text' : null);
      const inspected = inspectUpload(buffer, filename, { limits, cdn: config.cdn, template: selected });
      const format = selected ?? (inspected.files.has('package.json') && inspected.root ? 'vite' : 'static');
      if (!allowed.includes(format)) fail(400, '该题不支持此提交格式');
      if (format === 'vite' && (!inspected.files.has('package.json') || !inspected.root)) fail(400, 'Vite 项目请包含 package.json 和构建后的 dist/ 目录');
      inspected.checks.find((check) => check.id === 'format').template = format;
      const curatedTwin = catalog.duplicateOf(inspected.entryDigest);
      const uploadTwin = q.workByDigest.get(inspected.digest);
      if (curatedTwin) inspected.checks.push({ id: 'duplicate', state: 'warn', label: '重复检测', detail: `入口页面与已有作品「${curatedTwin.title}」（${curatedTwin.modelName}）完全相同，核验时会重点比对。` });
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
    // The author's newest unexpired draft for a task, so a reopened upload page can resume it.
    latestDraft(user, taskId) {
      const row = q.latestDraft.get(user.id, taskId, Date.now());
      return row ? publicDraft(row) : null;
    },

    discardDraft(user, id) {
      const row = q.draft.get(id);
      if (!row || row.owner_id !== user.id) fail(404, '试加载已结束');
      rmSync(join(dirs.drafts, id), { recursive: true, force: true });
      q.deleteDraft.run(id);
    },

    submit(user, body, { createQuestion = null } = {}) {
      const draft = q.draft.get(String(body.draftId ?? ''));
      if (!draft || draft.owner_id !== user.id || draft.expires_at <= Date.now()) fail(404, '试加载已过期，请重新选择文件');
      if (createQuestion ? draft.task_id !== '__new__' : draft.task_id === '__new__') fail(400, '新题目草稿只能用于发起题目');
      if (!createQuestion) {
        const task = catalog.task(draft.task_id, user);
        if (!task) fail(404, '题目不存在');
        if (!task.acceptsUploads) fail(409, '这道题暂不接受上传');
      }
      if (body.confirmed !== true) fail(400, '请先确认作品在试加载中运行正常');
      // Old clients submit only tool; store it in the one free-text Harness field.
      const source = provenance(!body.harnessId && !body.harnessOther && body.tool
        ? { ...body, harnessOther: clip(body.tool, 40) } : body);
      const generation = generationFrom(body);
      const effort = effortOf(body.effort);
      if (!effort) fail(400, '请选择或填写推理档位');
      if (!source.providerId) fail(400, '请选择服务商');
      const promptVariant = promptVariantFrom(draft.task_id, body, '', !isStaff(user));
      if (!isStaff(user) && !source.harnessId && !source.harnessOther) fail(400, '请选择或填写 Harness');
      const who = identity(body);
      const title = clip(body.title, 40) || defaultTitle(who.modelName, effort);
      if (!title) fail(400, '请填写作品标题');
      const cover = coverFrom(body.cover);
      // Admins stage inbox registrations as unverified works in bulk; the per-user
      // pending cap only exists to throttle regular submitters.
      const cap = pendingLimit(user);
      const pending = q.pendingOf.get(user.id).n;
      if (cap !== null && pending >= cap) fail(429, `你已有 ${pending} 件作品在等待核验（上限 ${cap} 件），核验完成或删除作品后名额会释放`);

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
      let taskId = draft.task_id;
      try {
        renameSync(staged, stored);
        moved = true;
        transaction(db, () => {
          const format = JSON.parse(draft.checks).find((check) => check.id === 'format')?.template
            ?? (draft.root && existsSync(join(stored, 'package.json')) ? 'vite' : 'static');
          if (createQuestion) {
            const question = createQuestion();
            if (!question.templates.includes(format)) fail(400, '该题不支持此提交格式');
            taskId = question.id;
          } else if (!templatesOf(catalog.task(taskId, user)).includes(format)) fail(400, '该题不支持此提交格式');
          q.insertWork.run(id, taskId, user.id, title, clip(body.summary, 200), who.modelId, who.modelId ? '' : who.modelName,
            who.modelId ? '' : who.vendor, effort, source.harnessId, source.harnessOther, source.providerId,
            source.providerOther, clip(body.note, 1000), token('w'), draft.source_name, draft.root, draft.entry, draft.file_count,
            draft.bytes, draft.digest, draft.checks, JSON.stringify(sanitizeTrial(body.trial)), coverName, now, now,
            ...GENERATION_FIELDS.map((key) => generation[key]), JSON.stringify(isStaff(user)
              ? { status: 'approved', source: 'human', reviewer: user.nickname || user.name, reason: '管理员发布', at: now }
              : config.moderation?.enabled ? pendingModeration() : { status: 'legacy' }), promptVariant, roleOf(user.role));
          q.deleteDraft.run(draft.id);
          q.audit.run(now, user.id, user.name, 'submit', taskId, id, `${who.modelName}${effortOf(body.effort) ? ` · ${effortOf(body.effort)}` : ''}`);
          if (cover) renameSync(pendingCover, join(media, coverName));
        });
      } catch (error) {
        if (moved) renameSync(stored, staged);
        if (cover) rmSync(media, { recursive: true, force: true });
        throw error;
      }
      return upload(taskId, id);
    },

    // Admins edit any upload; authors edit their own until it has been reviewed.
    setMeta(actor, taskId, id, body, { author = false, inTransaction = false } = {}) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在', 'not_found');
      const admin = !author;
      if (admin) requireStaff(actor, work, false);
      if (!admin && work.ownerId !== actor.id) fail(403, '只能修改自己上传的作品');
      if (!admin && work.status !== 'unverified') fail(409, '作品已核验，信息不能再修改；如有错误请删除后重新上传');
      if (!plainObject(body) || !Object.keys(body).length ||
        Object.keys(body).some((key) => !['title', 'summary', 'note', 'modelName', 'modelId', 'vendor', 'effort', 'promptVariant', 'task',
          'harnessId', 'harnessOther', 'harnessVersion', 'providerId', ...GENERATION_FIELDS, ...IGNORED_GENERATION_FIELDS].includes(key))) fail(400, '没有可修改的内容');
      if (Object.keys(body).every((key) => key === 'harnessVersion' || IGNORED_GENERATION_FIELDS.includes(key))) return admin ? this.adminWork(work, actor) : this.toPublic(work, actor);
      // Re-homing to another task is an admin correction; the target must be a live
      // question, and history moves along with the work.
      let moved = null;
      if (body.task !== undefined && String(body.task) !== taskId) {
        if (!admin) fail(403, '只有管理员可以调整归属题目');
        requireStaff(actor, work);
        if (work.curated) fail(400, '数据包作品不能调整归属题目');
        const target = String(body.task);
        if (!catalog.task(target) && !q.questionExists.get(target)) fail(400, '目标题目不存在', 'invalid_task');
        moved = { from: taskId, to: target };
      }
      const summary = body.summary === undefined ? work.summary : clip(body.summary, 200);
      const currentIdentity = displayIdentity(work);
      const who = body.modelId !== undefined || body.modelName !== undefined || body.vendor !== undefined
        ? identity({ ...currentIdentity, vendor: currentIdentity.modelId ? '' : work.vendor,
          ...(body.modelName !== undefined ? { modelId: null } : {}), ...body }) : currentIdentity;
      const effort = body.effort !== undefined ? effortOf(body.effort) : work.effort;
      const title = body.title === undefined ? work.title : clip(body.title, 40) || defaultTitle(who.modelName, effort);
      if (!title) fail(400, '请填写作品标题');
      const source = provenance(body, work);
      if (body.effort !== undefined && !effort) fail(400, '请选择或填写推理档位');
      if (Object.hasOwn(body, 'providerId') && !source.providerId) fail(400, '请选择服务商');
      if (!admin && !isStaff(actor) && !source.harnessId && !source.harnessOther) fail(400, '请选择或填写 Harness');
      const generation = generationFrom(body, work);
      const promptVariant = promptVariantFrom(taskId, body, work.promptVariant, !admin && !isStaff(actor));
      const note = body.note === undefined ? work.note : clip(body.note, 1000);
      const apply = () => {
        if (work.curated) {
          const patch = { title, summary, modelId: who.modelId, modelName: who.modelName, vendor: who.vendor, effort,
            harnessId: source.harnessId, harnessOther: source.harnessOther, providerId: source.providerId,
            ...generation, promptVariant, note: note ?? '' };
          q.setDisplay.run(taskId, id, JSON.stringify(patch), actor.id, Date.now());
          audit(actor, 'meta', work, `编辑信息${generationAudit(work, generation)}`);
          return;
        }
        if (moved) {
          q.moveWorkTask.run(moved.to, Date.now(), id);
          q.moveVotes.run(moved.to, moved.from, id, id);
          q.moveMatches.run(moved.to, moved.from, id, id);
          q.moveComments.run(moved.to, moved.from, id);
          q.moveReactions.run(moved.to, moved.from, id);
        }
        q.meta.run(title, summary, who.modelId, who.modelId ? '' : who.modelName, who.modelId ? '' : who.vendor, effort,
          source.harnessId, source.harnessOther, source.providerId, source.providerOther,
          ...GENERATION_FIELDS.map((key) => generation[key]), promptVariant, note, Date.now(), id);
        audit(actor, 'meta', work, `编辑信息${generationAudit(work, generation)}${moved ? `；归属题目 ${moved.from} → ${moved.to}` : ''}`);
        const next = upload(moved ? moved.to : taskId, id);
        if (author && !isStaff(actor) && config.moderation?.enabled && moderationText(work) !== moderationText(next)) q.moderation.run(JSON.stringify(pendingModeration()), id);
      };
      if (inTransaction) apply();
      else transaction(db, apply);
      return admin ? this.adminWork(this.work(moved ? moved.to : taskId, id), actor) : this.toPublic(this.work(moved ? moved.to : taskId, id), actor);
    },

    setCaptures(id, captures) {
      q.captures.run(JSON.stringify(captures), id);
    },

    finishModeration(work, result, actor = null) {
      const next = { ...result, at: Date.now() };
      return transaction(db, () => {
        const updated = q.moderationResult.run(JSON.stringify(next), work.id, work.moderationRaw).changes;
        if (updated) audit(actor, 'content-review', work, JSON.stringify(next));
        return Boolean(updated);
      });
    },
    reviewContent(admin, taskId, id, body) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在');
      requireStaff(admin, work);
      if (work.curated) fail(409, '数据包作品已完成内容审核，请使用作品核验');
      if (!['approved', 'rejected'].includes(body.status)) fail(400, '内容审查结果无效');
      const reason = clip(body.reason, 500) || (body.status === 'approved' ? '人工复核通过' : '');
      if (!reason) fail(400, '请填写人工审查理由');
      this.finishModeration(work, { status: body.status, reason, source: 'human', reviewer: admin.name }, admin);
      return upload(taskId, id);
    },
    retryModeration(admin, taskId, id) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在');
      requireStaff(admin, work);
      if (work.curated) fail(409, '数据包作品没有托管的上传文件，不能重新自动审核');
      if (!config.moderation?.enabled) fail(409, '自动内容审查未启用');
      transaction(db, () => {
        q.moderation.run(JSON.stringify(pendingModeration()), id);
        audit(admin, 'content-retry', work, '重新提交自动内容审查');
      });
      return upload(taskId, id);
    },

    // ---- review and removal -----------------------------------------------------------
    review(admin, taskId, id, body, { inTransaction = false } = {}) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在');
      requireStaff(admin, work);
      const status = String(body.status ?? '');
      if (!['verified', 'questioned', 'unverified'].includes(status)) fail(400, '审核结果无效');
      if (status === 'verified' && !['legacy', 'approved'].includes(work.moderation?.status)) fail(409, '请先完成内容审核');
      const reason = clip(body.reason, 500);
      if (status === 'questioned' && !reason) fail(400, '标记存疑时请写明原因，作者和访客都会看到');
      const currentIdentity = displayIdentity(work);
      const who = body.modelId !== undefined || body.modelName !== undefined || body.vendor !== undefined
        ? identity({ ...currentIdentity, vendor: currentIdentity.modelId ? '' : work.vendor,
          ...(body.modelName !== undefined ? { modelId: null } : {}), ...body }) : currentIdentity;
      const effort = body.effort !== undefined ? effortOf(body.effort) : work.effort;
      const source = provenance(body, work);
      const generation = generationFrom(body, work);
      if ((status === 'verified' || body.effort !== undefined) && !effort) fail(400, '请选择或填写推理档位');
      if ((status === 'verified' || Object.hasOwn(body, 'providerId')) && !source.providerId) fail(400, '请选择服务商');
      if (Object.hasOwn(body, 'entertainment') && typeof body.entertainment !== 'boolean') fail(400, '娱乐作品标记无效');
      if (body.entertainment === true && status !== 'verified') fail(400, '只有通过核验才能送进收件箱');
      const firstVerify = status === 'verified' && work.status !== 'verified';
      // First verification still opens both faces. entertainment follows that same default:
      // omitted → on; explicit false publishes all three and clears the inbox; explicit true
      // holds the work in the arena inbox with every switch off. A repeat omits it and keeps state.
      const inbox = status === 'verified' && body.entertainment === true;
      const publishAll = status === 'verified' && body.entertainment === false;
      if (firstVerify && !inbox && !publishAll && body.audience === undefined) {
        body = { ...body, show_gallery: body.show_gallery ?? true, show_arena: body.show_arena ?? true };
      }
      const audience = body.audience === undefined ? work.audience : String(body.audience);
      if (!['hidden', 'show1', 'show2', 'both'].includes(audience)) fail(400, '展示站点无效');
      for (const key of ['show_gallery', 'show_arena']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, '门面开关无效', 'invalid_face_settings');
      const fromAudience = { hidden: [false, false], show1: [false, true], show2: [true, false], both: [true, true] }[audience];
      let gallery = body.show_gallery ?? (body.audience === undefined ? work.showGallery : fromAudience[0]);
      let arena = body.show_arena ?? (body.audience === undefined ? work.showArena : fromAudience[1]);
      let entertainment = work.showEntertainment;
      let route = work.entertainmentRoute ?? 0;
      if (inbox) {
        gallery = false; arena = false; entertainment = false; route = 1;
      } else if (publishAll) {
        gallery = true; arena = true; entertainment = true; route = 0;
      } else if (firstVerify) {
        entertainment = true; route = 0;
      }
      const nextAudience = gallery && arena ? 'both' : gallery ? 'show2' : arena ? 'show1' : 'hidden';
      if (!inbox && work.audience === 'hidden' && status === 'verified' && nextAudience === 'hidden' && body.show_gallery === undefined && body.show_arena === undefined) fail(400, '请选择审核通过后展示的网站');
      if (nextAudience !== 'hidden' && status !== 'verified' && work.audience === 'hidden') fail(400, '隐藏作品须先审核通过才能发布');
      const title = body.title === undefined ? work.title : clip(body.title, 40) || defaultTitle(who.modelName, effort);
      if (!title) fail(400, '请填写作品标题');
      const summary = body.summary === undefined ? work.summary : clip(body.summary, 200);
      const now = Date.now();
      const labels = { verified: '通过验证', questioned: '标记存疑', unverified: '退回未验证' };
      const apply = () => {
        if (work.curated) {
          q.reviewPack.run(taskId, id, status, status === 'verified' ? '' : reason, admin.id, now, admin.id, now);
          const patch = { title, summary, modelId: who.modelId, modelName: who.modelName, vendor: who.vendor, effort,
            harnessId: source.harnessId, harnessOther: source.harnessOther, providerId: source.providerId,
            ...generation, promptVariant: work.promptVariant ?? '', note: work.note ?? '' };
          q.setDisplay.run(taskId, id, JSON.stringify(patch), admin.id, now);
          q.setOverride.run(taskId, id, Number(gallery), Number(arena), Number(entertainment), admin.id, now);
        } else q.review.run(status, status === 'verified' ? '' : reason, who.modelId, who.modelId ? '' : who.modelName, who.modelId ? '' : who.vendor, effort,
          source.harnessId, source.harnessOther, source.providerId, source.providerOther,
          ...GENERATION_FIELDS.map((key) => generation[key]), Number(gallery), Number(arena), Number(entertainment), route, title, summary,
          work.note, now,
          status === 'verified' && work.reviewedGalleryAt == null ? now : null,
          status === 'verified' && work.reviewedArenaAt == null ? now : null, now, id);
        const routeNote = inbox ? '送进收件箱' : publishAll ? '三面公开' : firstVerify ? '娱乐盲测随首次核验开启' : '';
        audit(admin, status, work, [labels[status], reason, routeNote].filter(Boolean).join('：') + generationAudit(work, generation));
      };
      if (inTransaction) apply();
      else transaction(db, apply);
      return this.work(taskId, id);
    },

    reviewWithMeta(admin, taskId, id, body) {
      return transaction(db, () => {
        if (body.meta && Object.keys(body.meta).length) this.setMeta(admin, taskId, id, body.meta, { inTransaction: true });
        return this.review(admin, taskId, id, body, { inTransaction: true });
      });
    },

    inboxWorks(viewer = null) {
      return this.uploads().filter((work) => work.entertainmentRoute === 1).map((work) => this.adminWork(work, viewer));
    },

    setDisplay(admin, taskId, id, body) {
      return this.setMeta(admin, taskId, id, body);
    },

    // Assigning a task moves the work out of the inbox. Metadata alone leaves it there.
    assignInbox(admin, items, { task = null, entertainment = false } = {}) {
      requireStaff(admin, null);
      if (!Array.isArray(items) || items.length < 1 || items.length > 200
        || items.some((item) => !plainObject(item) || typeof item.task !== 'string' || !item.task || typeof item.id !== 'string' || !item.id))
        fail(400, '作品列表无效（每次最多 200 件）', 'invalid_work_list');
      if (typeof entertainment !== 'boolean') fail(400, '娱乐盲测标记无效');
      if (task != null && !catalog.task(String(task)) && !q.questionExists.get(String(task))) fail(400, '目标题目不存在', 'invalid_task');
      const now = Date.now();
      return transaction(db, () => items.map(({ task: from, id }) => {
        const work = upload(from, id);
        if (!work || work.entertainmentRoute !== 1) fail(404, '收件箱里没有这件作品', 'not_found');
        requireStaff(admin, work);
        if (task != null && String(task) !== from) this.setMeta(admin, from, id, { task: String(task) }, { inTransaction: true });
        const home = task != null ? String(task) : from;
        if (task != null) q.setRoute.run(2, now, id);
        if (entertainment) this.setFaceSettings(admin, home, id, { show_entertainment: true }, true);
        audit(admin, task != null ? 'inbox-assign' : 'inbox-note', { taskId: home, id }, task != null ? `归属题目 ${from} → ${home}` : '补充信息');
        return this.adminWork(this.work(home, id), admin);
      }));
    },

    remove(user, taskId, id) {
      const work = this.work(taskId, id);
      if (!work) fail(404, '作品不存在');
      if (work.ownerId !== user.id && !isSenior(user)) fail(403, '只能删除自己上传的作品');
      const votes = q.votesOfWork.get(taskId, id, id).n;
      if (votes > 0) fail(409, `这件作品已有 ${votes} 票对局记录，删除会破坏历史。请用「标记存疑」让它下线`);
      const now = Date.now();
      transaction(db, () => {
        if (work.curated) q.removePack.run(taskId, id, now, user.id, now);
        else q.remove.run(now, now, id);
        audit(user, 'delete', work, user.id === work.ownerId ? '作者删除' : '管理员删除');
      });
      if (!work.curated) {
        rmSync(join(dirs.works, id), { recursive: true, force: true });
        rmSync(join(dirs.media, id), { recursive: true, force: true });
      }
    },

    // ---- reactions -------------------------------------------------------------------------
    react(user, taskId, id, emoji) {
      const work = this.work(taskId, id);
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
    pendingLimit,
    updatesCount: (userId) => q.updatesOf.get(userId, seenAt(userId)).n,
    markWorksSeen(userId) { q.markWorksSeen.run(Date.now(), userId); },
    auditLog(limit = 200) {
      return q.auditLog.all(limit).map((row) => ({ at: iso(row.at), actor: row.actor_name, action: row.action, task: row.task_id, work: row.work_id, detail: generationAuditView(row.detail) }));
    },
    hasDirectory: (id) => existsSync(join(dirs.works, id)),
  };
}
