// Ordinary-moderator batch upload. The grant is a third credential, separate from
// the cookie session and from dots. It cannot review, publish, or delete.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { planDigest } from './batch-plan.mjs';
import { transaction } from './db.mjs';
import { HttpError, assertSameOrigin, fail, rateLimit, readBody, readJson } from './http.mjs';
import { inspectUpload } from './inspect.mjs';
import { isSenior } from './roles.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DUMMY = Buffer.alloc(32, 7);

function sameHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length || left.length % 2) return false;
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function failLater(status, message, code, seconds) {
  const error = new HttpError(status, message, code);
  error.retryAfter = seconds;
  throw error;
}

function failStorage() {
  throw new HttpError(507, '服务器磁盘空间不足，已拒绝写入', 'insufficient_storage');
}

function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (raw == null || !/^\d+$/.test(String(raw))) fail(411, '需要 Content-Length', 'length_required');
  return Number(raw);
}

function bearerValue(req) {
  const header = String(req.headers.authorization ?? '');
  if (!header) return '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : 'invalid';
}

function userCode() {
  const bytes = randomBytes(10);
  return [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join('');
}

export function createBatch({ db, config, limits, library, catalog, moderator, capturer, auth, settings, writeLimit }) {
  const stagingRoot = join(config.dataDir, 'batch-staging');
  mkdirSync(stagingRoot, { recursive: true });
  const q = {
    insertDevice: db.prepare(`INSERT INTO batch_devices (
      id, device_code_hash, user_code, batch_id, client_name, payload_digest, plan_json,
      declared_compressed, declared_expanded, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`),
    deviceByCode: db.prepare('SELECT * FROM batch_devices WHERE device_code_hash = ?'),
    deviceByUserCode: db.prepare('SELECT * FROM batch_devices WHERE user_code = ?'),
    deviceById: db.prepare('SELECT * FROM batch_devices WHERE id = ?'),
    pendingDevice: db.prepare(`SELECT * FROM batch_devices WHERE batch_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`),
    blockingDevice: db.prepare(`SELECT id, status, expires_at FROM batch_devices
      WHERE batch_id = ? AND status IN ('pending', 'approved', 'consumed') AND (status != 'pending' OR expires_at > ?) LIMIT 1`),
    approveDevice: db.prepare(`UPDATE batch_devices SET status = 'approved', user_id = ?, approved_at = ?, role_security_version = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?`),
    consumeDevice: db.prepare(`UPDATE batch_devices SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`),
    expireDevices: db.prepare(`UPDATE batch_devices SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`),
    insertGrant: db.prepare(`INSERT INTO batch_grants (
      id, token_hash, user_id, batch_id, device_id, payload_digest, allowed_tasks, role_security_version,
      quotas_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    grantByHash: db.prepare('SELECT * FROM batch_grants WHERE token_hash = ?'),
    grantById: db.prepare('SELECT * FROM batch_grants WHERE id = ?'),
    grantForBatch: db.prepare('SELECT * FROM batch_grants WHERE batch_id = ? ORDER BY created_at DESC LIMIT 1'),
    revokeGrant: db.prepare(`UPDATE batch_grants SET revoked_at = ? WHERE batch_id = ? AND revoked_at IS NULL`),
    insertWork: db.prepare(`INSERT INTO batch_works (
      user_id, batch_id, work_key, payload_digest, status, work_id, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    workRow: db.prepare('SELECT * FROM batch_works WHERE user_id = ? AND batch_id = ? AND work_key = ?'),
    workRows: db.prepare('SELECT * FROM batch_works WHERE user_id = ? AND batch_id = ? ORDER BY work_key'),
    activeCount: db.prepare(`SELECT COUNT(*) AS n FROM batch_works WHERE user_id = ? AND batch_id = ? AND status IN ('reserved', 'staged', 'committed')`),
    markWork: db.prepare(`UPDATE batch_works SET status = ?, work_id = ?, updated_at = ? WHERE user_id = ? AND batch_id = ? AND work_key = ? AND status != 'committed'`),
    cancelOpen: db.prepare(`UPDATE batch_works SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND batch_id = ? AND status IN ('reserved', 'staged', 'failed')`),
    insertReservation: db.prepare(`INSERT INTO batch_reservations (
      id, user_id, batch_id, work_key, compressed_bytes, expanded_bytes, staging_bytes, screenshot_bytes, inodes, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`),
    held: db.prepare(`SELECT COALESCE(SUM(compressed_bytes + expanded_bytes + staging_bytes + screenshot_bytes), 0) AS bytes,
      COALESCE(SUM(inodes), 0) AS inodes FROM batch_reservations WHERE state = 'held'`),
    batchUsed: db.prepare(`SELECT COALESCE(SUM(compressed_bytes), 0) AS compressed, COALESCE(SUM(expanded_bytes), 0) AS expanded,
      COALESCE(SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END), 0) AS holding
      FROM batch_reservations WHERE user_id = ? AND batch_id = ? AND state != 'released'`),
    setReservation: db.prepare(`UPDATE batch_reservations SET state = ? WHERE id = ? AND state = 'held'`),
    releaseBatch: db.prepare(`UPDATE batch_reservations SET state = 'released' WHERE user_id = ? AND batch_id = ? AND state = 'held'`),
    stale: db.prepare(`SELECT batch_reservations.*, batch_grants.expires_at AS grant_expires, batch_grants.revoked_at
      FROM batch_reservations LEFT JOIN batch_grants
        ON batch_grants.user_id = batch_reservations.user_id AND batch_grants.batch_id = batch_reservations.batch_id
      WHERE batch_reservations.state = 'held'`),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
  const deviceLimit = rateLimit(10 * 60e3, 10, '登记太频繁，请稍后再试', 'batch_rate');
  const pollLimit = rateLimit(60e3, 40, '轮询太频繁，请稍后再试', 'batch_rate');
  const uploadLimit = rateLimit(10 * 60e3, Math.max(1, settings.worksPerWindow || 6), '这批上传太频繁，请稍后再试', 'batch_rate');

  function note(user, action, fields = {}) {
    const detail = JSON.stringify({
      batchId: fields.batchId ?? null,
      workKey: fields.workKey ?? null,
      digest: fields.digest ? String(fields.digest).slice(0, 12) : null,
      result: fields.result ?? null,
    });
    q.audit.run(Date.now(), user?.id ?? null, user?.name ?? '', action, fields.taskId ?? null, fields.workId ?? null, detail);
  }

  function requireEnabled() {
    if (!settings.enabled) fail(403, '批量投稿未开启', 'batch_forbidden');
  }

  function quotasFor(grant) {
    const snap = JSON.parse(grant.quotas_json);
    return {
      maxWorks: Math.min(snap.maxWorks, settings.maxWorks),
      maxCompressed: Math.min(snap.maxCompressed, settings.maxCompressed),
      maxExpanded: Math.min(snap.maxExpanded, settings.maxExpanded),
    };
  }

  function assertModerator(user, version) {
    if (!user || user.role !== 'moderator') fail(403, '批量投稿只授予普通管理员，角色变化后需要重新确认', 'batch_forbidden');
    if (!user.email) fail(403, '请先绑定邮箱', 'email_required');
    if ((user.role_security_version ?? 0) !== version) fail(403, '角色已变化，旧的批量授权已失效', 'batch_forbidden');
  }

  function freshGrant(grantId) {
    const grant = q.grantById.get(grantId);
    if (!grant) fail(401, '批量授权无效', 'unauthorized');
    if (grant.revoked_at) fail(403, '批量授权已吊销', 'batch_forbidden');
    if (grant.expires_at <= Date.now()) fail(403, '批量授权已过期', 'batch_forbidden');
    const user = auth.byId(grant.user_id);
    assertModerator(user, grant.role_security_version);
    const device = q.deviceById.get(grant.device_id);
    let parsed;
    try { parsed = planDigest(JSON.parse(device.plan_json)); }
    catch { fail(409, '已批准的摘要与计划不一致', 'digest_mismatch'); }
    if (parsed.digest !== grant.payload_digest || parsed.digest !== device.payload_digest) {
      fail(409, '已批准的摘要与计划不一致', 'digest_mismatch');
    }
    return { grant, user, plan: parsed.plan };
  }

  function grantFromToken(token) {
    if (!token || token === 'invalid') fail(401, '缺少批量授权', 'unauthorized');
    if (token.startsWith('aobd_')) fail(403, '审核令牌不能用于批量投稿', 'batch_forbidden');
    if (!token.startsWith('aobb_')) fail(401, '批量授权无效', 'unauthorized');
    const hash = sha256(token);
    const row = q.grantByHash.get(hash);
    const expected = row ? Buffer.from(row.token_hash, 'hex') : DUMMY;
    const given = Buffer.from(hash, 'hex');
    if (!row || expected.length !== given.length || !timingSafeEqual(expected, given)) fail(401, '批量授权无效', 'unauthorized');
    return freshGrant(row.id);
  }

  function assertQueues() {
    const moderationDepth = Number(moderator.depth ?? 0);
    const captureDepth = Number(capturer.depth ?? 0);
    if (moderationDepth >= settings.moderationQueueMax) failLater(429, '内容审查队列已满，请稍后再试', 'moderation_busy', 30);
    if (captureDepth >= settings.captureQueueMax) failLater(503, '截图队列已满，请稍后再试', 'capture_busy', 30);
  }

  function diskFree() {
    try {
      const stat = typeof settings.statfs === 'function' ? settings.statfs(config.dataDir) : statfsSync(config.dataDir);
      const bsize = Number(stat.bsize ?? stat.bytes ?? 0);
      const bytes = stat.bytes != null && stat.bsize == null ? Number(stat.bytes) : Number(stat.bavail) * Number(stat.bsize);
      const capacity = stat.capacity != null && stat.bsize == null ? Number(stat.capacity) : Number(stat.blocks) * Number(stat.bsize);
      const inodes = Number(stat.inodes ?? stat.ffree);
      if (![bytes, capacity, inodes].every((value) => Number.isFinite(value) && value >= 0)) return null;
      return { bytes, capacity, inodes, bsize };
    } catch { return null; }
  }

  function reserve(user, grant, work) {
    const expanded = work.files.reduce((sum, file) => sum + file.size, 0);
    const need = {
      compressed: work.compressedBytes,
      expanded,
      staging: expanded,
      screenshot: settings.screenshotReserve,
      inodes: work.files.length + 4,
    };
    const bytes = need.compressed + need.expanded + need.staging + need.screenshot;
    const quotas = quotasFor(grant);
    const id = randomBytes(16).toString('hex');
    transaction(db, () => {
      const active = q.activeCount.get(user.id, grant.batch_id).n;
      const existing = q.workRow.get(user.id, grant.batch_id, work.key);
      if (!existing && active >= quotas.maxWorks) fail(413, `一批最多 ${quotas.maxWorks} 件作品`);
      const used = q.batchUsed.get(user.id, grant.batch_id);
      if (Number(used.compressed) + need.compressed > quotas.maxCompressed) fail(413, '这批作品的压缩体积超过上限');
      if (Number(used.expanded) + need.expanded > quotas.maxExpanded) fail(413, '这批作品的解压体积超过上限');
      const free = diskFree();
      if (!free) failStorage();
      const floor = Math.max(settings.diskFloorBytes, Math.floor(free.capacity * settings.diskFloorRatio));
      const held = q.held.get();
      if (free.bytes - Number(held.bytes) - bytes < floor) failStorage();
      if (free.inodes - Number(held.inodes) - need.inodes < settings.inodeFloor) failStorage();
      const now = Date.now();
      if (!existing) q.insertWork.run(user.id, grant.batch_id, work.key, grant.payload_digest, 'reserved', null, work.task, now, now);
      else if (existing.payload_digest !== grant.payload_digest) fail(409, '同一作品键已绑定另一份摘要', 'digest_mismatch');
      else if (existing.status === 'committed') fail(409, '这件作品已经提交', 'digest_mismatch');
      else q.markWork.run('reserved', null, now, user.id, grant.batch_id, work.key);
      q.insertReservation.run(id, user.id, grant.batch_id, work.key, need.compressed, need.expanded, need.staging, need.screenshot, need.inodes, now);
    });
    return id;
  }

  function release(id) {
    if (id) q.setReservation.run('released', id);
  }

  function stagingPath(userId, batchId, workKey) {
    return join(stagingRoot, userId, batchId, workKey);
  }

  function writeStaging(directory, files) {
    const root = resolve(directory);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    for (const [path, data] of files) {
      const file = resolve(root, path);
      if (file !== root && !file.startsWith(root + sep)) fail(400, '文件路径不合法');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
  }

  function actualFiles(inspected) {
    return [...inspected.files].map(([path, data]) => ({
      path: path.normalize('NFC'),
      size: data.length,
      sha256: sha256(data),
    })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  function filesMatch(expected, actual) {
    if (expected.length !== actual.length) return false;
    return expected.every((file, index) => file.path === actual[index].path && file.size === actual[index].size && file.sha256 === actual[index].sha256);
  }

  function taskAllowed(taskId, user) {
    const task = catalog.task(taskId, user);
    if (!task) fail(404, '题目不存在');
    if (!task.acceptsUploads) fail(409, '这道题暂不接受上传');
    return task;
  }

  async function register(ctx) {
    requireEnabled();
    if (ctx.req.headers.authorization) fail(403, '登记批次不接受令牌', 'batch_forbidden');
    const length = declaredLength(ctx.req);
    if (length > settings.deviceBodyBytes) fail(413, '批次登记只能包含计划摘要，不能包含作品正文');
    deviceLimit(ctx.ip);
    const body = await readJson(ctx.req, settings.deviceBodyBytes);
    let canonical;
    let digest;
    try {
      ({ plan: canonical, digest } = planDigest(body));
    } catch (error) {
      fail(400, error.message || '批次计划无效');
    }
    if (!sameHex(String(body.payloadDigest ?? '').toLowerCase(), digest)) fail(400, '计划摘要与服务器计算的不一致');
    let compressed = 0;
    let expanded = 0;
    for (const work of canonical.works) {
      taskAllowed(work.task, null);
      compressed += work.compressedBytes;
      const unpacked = work.files.reduce((sum, file) => sum + file.size, 0);
      expanded += unpacked;
      if (work.compressedBytes > limits.uploadBytes || unpacked > limits.unpackedBytes || work.files.length > limits.files) {
        fail(413, '单件作品超过上传上限');
      }
      if (work.files.some((file) => file.size > limits.fileBytes)) fail(413, '单个文件超过上限');
    }
    if (canonical.works.length > settings.maxWorks) fail(413, `一批最多 ${settings.maxWorks} 件作品`);
    if (compressed > settings.maxCompressed) fail(413, '这批作品的压缩体积超过上限');
    if (expanded > settings.maxExpanded) fail(413, '这批作品的解压体积超过上限');
    for (const work of canonical.works) {
      if (!work.modelId && !work.modelName) fail(400, '请填写模型');
      if (!work.effort) fail(400, '请选择或填写推理档位');
      if (!work.providerId) fail(400, '请选择服务商');
      if (!work.harnessId && !work.harnessOther) fail(400, '请选择或填写 Harness');
    }
    const now = Date.now();
    if (q.blockingDevice.get(canonical.batch, now)) fail(409, '这个批次编号已经登记', 'batch_exists');
    const id = randomBytes(16).toString('hex');
    const secret = `aobc_${randomBytes(32).toString('base64url')}`;
    let code = userCode();
    for (let attempt = 0; attempt < 5 && q.deviceByUserCode.get(code); attempt += 1) code = userCode();
    q.insertDevice.run(id, sha256(secret), code, canonical.batch, canonical.clientName, digest, JSON.stringify(canonical), compressed, expanded, now, now + settings.deviceTtlMs);
    note(null, 'batch-register', { batchId: canonical.batch, digest, result: 'pending' });
    return {
      device_code: secret,
      user_code: code,
      verification_url: `/admin/batch.html#c=${code}`,
      interval: 3,
      expiresAt: new Date(now + settings.deviceTtlMs).toISOString(),
      batchId: canonical.batch,
      payloadDigest: digest,
    };
  }

  function view(ctx, userCodeValue) {
    const user = ctx.user ?? fail(401, '请先登录');
    if (user.role !== 'moderator' && !isSenior(user)) fail(403, '只有普通管理员可以查看待确认批次', 'batch_forbidden');
    const device = q.deviceByUserCode.get(String(userCodeValue ?? ''));
    if (!device || device.expires_at <= Date.now() || !['pending', 'approved'].includes(device.status)) fail(404, '没有待确认的批次');
    const plan = JSON.parse(device.plan_json);
    return {
      batchId: device.batch_id,
      payloadDigest: device.payload_digest,
      clientName: device.client_name,
      expiresAt: new Date(device.expires_at).toISOString(),
      status: device.status,
      declaredCompressed: device.declared_compressed,
      declaredExpanded: device.declared_expanded,
      works: plan.works.map((work) => ({
        key: work.key, task: work.task, title: work.title, effort: work.effort, compressedBytes: work.compressedBytes,
        files: work.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      })),
    };
  }

  async function approve(ctx) {
    requireEnabled();
    if (ctx.req.headers.authorization) fail(403, '确认批次不接受令牌', 'batch_forbidden');
    assertSameOrigin(ctx.req, config);
    const user = ctx.user ?? fail(401, '请先登录');
    if (user.role !== 'moderator') fail(403, '只有普通管理员可以确认批量投稿', 'batch_forbidden');
    if (!user.email) fail(403, '请先绑定邮箱', 'email_required');
    const length = declaredLength(ctx.req);
    if (length > 4096) fail(413, '确认请求过大');
    const body = await readJson(ctx.req, 4096);
    const batchId = String(ctx.params.id ?? '');
    if (!KEY.test(batchId)) fail(400, '批次编号无效');
    const device = q.pendingDevice.get(batchId, Date.now());
    if (!device) fail(404, '没有待确认的批次');
    if (String(body.userCode ?? '') !== device.user_code) fail(400, '确认码不匹配');
    if (!sameHex(String(body.payloadDigest ?? '').toLowerCase(), device.payload_digest)) fail(400, '请提交页面上的完整摘要');
    for (const work of JSON.parse(device.plan_json).works) taskAllowed(work.task, user);
    const changed = q.approveDevice.run(user.id, Date.now(), user.role_security_version ?? 0, device.id, Date.now()).changes;
    if (!changed) fail(409, '这批计划已经确认或已过期', 'batch_exists');
    note(user, 'batch-approve', { batchId, digest: device.payload_digest, result: 'approved' });
    return { ok: true, batchId, payloadDigest: device.payload_digest, status: 'approved' };
  }

  async function poll(ctx) {
    requireEnabled();
    if (ctx.req.headers.authorization) fail(403, '轮询不接受上传令牌', 'batch_forbidden');
    const length = declaredLength(ctx.req);
    if (length > 4096) fail(413, '轮询请求过大');
    pollLimit(ctx.ip);
    const body = await readJson(ctx.req, 4096);
    const code = String(body.device_code ?? '');
    if (!code.startsWith('aobc_')) fail(401, '设备码无效', 'unauthorized');
    const device = q.deviceByCode.get(sha256(code));
    const expected = device ? Buffer.from(device.device_code_hash, 'hex') : DUMMY;
    const given = Buffer.from(sha256(code), 'hex');
    if (!device || expected.length !== given.length || !timingSafeEqual(expected, given)) fail(401, '设备码无效', 'unauthorized');
    if (device.expires_at <= Date.now() && device.status !== 'approved' && device.status !== 'consumed') {
      fail(403, '设备确认已过期', 'batch_forbidden');
    }
    if (device.status === 'pending') return { pending: true, interval: 3 };
    if (device.status !== 'approved' || device.consumed_at) fail(401, '设备码已失效', 'unauthorized');
    const user = auth.byId(device.user_id);
    assertModerator(user, device.role_security_version ?? 0);
    const token = `aobb_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const expires = now + Math.min(settings.grantTtlMs, 24 * 60 * 60 * 1000);
    const plan = JSON.parse(device.plan_json);
    const allowed = [...new Set(plan.works.map((work) => work.task))];
    const issued = transaction(db, () => {
      const current = q.deviceById.get(device.id);
      if (!current || current.status !== 'approved' || current.consumed_at) return false;
      if (!q.consumeDevice.run(now, device.id).changes) return false;
      q.insertGrant.run(randomBytes(16).toString('hex'), sha256(token), user.id, device.batch_id, device.id, device.payload_digest,
        JSON.stringify(allowed), device.role_security_version ?? 0,
        JSON.stringify({ maxWorks: settings.maxWorks, maxCompressed: settings.maxCompressed, maxExpanded: settings.maxExpanded }),
        now, expires);
      return true;
    });
    if (!issued) fail(401, '设备码已失效', 'unauthorized');
    note(user, 'batch-grant', { batchId: device.batch_id, digest: device.payload_digest, result: 'issued' });
    return {
      pending: false,
      token,
      tokenType: 'batch-grant',
      batchId: device.batch_id,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  function ownerOf(batchId) {
    const grant = q.grantForBatch.get(batchId);
    if (grant) return grant;
    return null;
  }

  async function upload(ctx) {
    requireEnabled();
    const length = declaredLength(ctx.req);
    if (length > limits.uploadBytes) fail(413, '单件作品超过上传上限');
    const token = bearerValue(ctx.req);
    if (ctx.user) fail(403, '不能同时使用登录会话和批量授权', 'batch_forbidden');
    const loaded = grantFromToken(token);
    const { grant, user, plan } = loaded;
    writeLimit?.(user.id);
    uploadLimit(user.id);
    const batchId = String(ctx.params.id ?? '');
    const workKey = String(ctx.params.key ?? '');
    if (batchId !== grant.batch_id) fail(403, '批量授权不能用于其他批次', 'batch_forbidden');
    if (!KEY.test(workKey)) fail(400, '作品键无效');
    if (String(ctx.req.headers['idempotency-key'] ?? '') !== workKey) fail(400, 'Idempotency-Key 必须等于作品键');
    const work = plan.works.find((item) => item.key === workKey);
    if (!work) fail(404, '这件作品不在已批准的计划里');
    const allowed = JSON.parse(grant.allowed_tasks);
    const requested = ctx.url.searchParams.get('task');
    if (requested && !allowed.includes(requested)) fail(403, '题目不在这次授权里', 'batch_forbidden');
    if (requested && requested !== work.task) fail(409, '题目与已批准的摘要不一致', 'digest_mismatch');
    if (!allowed.includes(work.task)) fail(403, '题目不在这次授权里', 'batch_forbidden');
    if (length !== work.compressedBytes) fail(409, '上传体积与已批准的摘要不一致', 'digest_mismatch');
    taskAllowed(work.task, user);
    const existing = q.workRow.get(user.id, batchId, workKey);
    if (existing && existing.payload_digest !== grant.payload_digest) fail(409, '同一作品键已绑定另一份摘要', 'digest_mismatch');

    const finishReplay = async () => {
      const buffer = await readBody(ctx.req, work.compressedBytes);
      const inspected = inspectUpload(buffer, buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50 ? 'work.zip' : 'index.html', {
        limits, cdn: config.cdn ?? [], policy: 'batch', inflateBudgetMs: settings.inflateBudgetMs, exclusive: true,
      });
      if (!filesMatch(work.files, actualFiles(inspected))) fail(409, '作品内容与已批准的摘要不一致', 'digest_mismatch');
      return inspected;
    };

    if (existing?.status === 'committed') {
      await finishReplay();
      const row = library.work(existing.task_id, existing.work_id, null, user);
      note(user, 'batch-upload', { batchId, workKey, digest: grant.payload_digest, result: 'replay', workId: existing.work_id, taskId: existing.task_id });
      return { status: 200, body: { workId: existing.work_id, status: 'unverified', moderation: row?.moderation?.status ?? 'pending', replay: true } };
    }

    assertQueues();
    const reservation = reserve(user, grant, work);
    const directory = stagingPath(user.id, batchId, workKey);
    let committed = false;
    try {
      const inspected = await finishReplay();
      writeStaging(directory, inspected.files);
      q.markWork.run('staged', null, Date.now(), user.id, batchId, workKey);
      if (typeof settings.beforeCommit === 'function') await settings.beforeCommit({ userId: user.id, batchId, workKey, staging: directory });
      const checked = freshGrant(grant.id);
      assertQueues();
      if (q.workRow.get(user.id, batchId, workKey)?.status === 'cancelled') fail(409, '这件暂存已取消', 'batch_cancelled');
      const submitted = library.submitMemberPipeline(checked.user, {
        taskId: work.task,
        filename: 'batch',
        inspected,
        title: work.title,
        summary: work.summary,
        modelId: work.modelId,
        modelName: work.modelName,
        vendor: work.vendor,
        effort: work.effort,
        providerId: work.providerId,
        harnessId: work.harnessId,
        harnessOther: work.harnessOther,
        generationMode: work.generationMode,
        humanIntervention: work.humanIntervention,
        promptVariant: work.promptVariant,
        note: work.note,
        auditDetail: JSON.stringify({ batchId, workKey, digest: grant.payload_digest.slice(0, 12) }),
        onCommit: (workId) => {
          if (!q.markWork.run('committed', workId, Date.now(), user.id, batchId, workKey).changes) fail(409, '这件暂存已取消', 'batch_cancelled');
          if (!q.setReservation.run('converted', reservation).changes) fail(409, '磁盘预留已失效', 'batch_cancelled');
        },
      }, () => { freshGrant(grant.id); });
      committed = true;
      rmSync(directory, { recursive: true, force: true });
      if (submitted.moderation?.status === 'pending') moderator.enqueue(submitted);
      note(user, 'batch-upload', { batchId, workKey, digest: grant.payload_digest, result: 'committed', workId: submitted.id, taskId: work.task });
      return { status: 201, body: { workId: submitted.id, status: 'unverified', moderation: 'pending' } };
    } catch (error) {
      if (!committed) {
        rmSync(directory, { recursive: true, force: true });
        release(reservation);
        const current = q.workRow.get(user.id, batchId, workKey);
        if (current && current.status !== 'committed') q.markWork.run('failed', null, Date.now(), user.id, batchId, workKey);
      }
      throw error;
    }
  }

  function ownedBatch(ctx, batchId) {
    const token = bearerValue(ctx.req);
    if (token && ctx.user) fail(403, '不能同时使用登录会话和批量授权', 'batch_forbidden');
    if (token) {
      const { grant, user } = grantFromToken(token);
      if (grant.batch_id !== batchId) fail(403, '批量授权不能用于其他批次', 'batch_forbidden');
      return { grant, user, via: 'grant' };
    }
    const user = ctx.user ?? fail(401, '请先登录');
    const grant = ownerOf(batchId);
    if (!grant) fail(404, '批次不存在');
    if (grant.user_id !== user.id && !isSenior(user)) fail(404, '批次不存在');
    return { grant, user, via: 'cookie' };
  }

  function status(ctx) {
    const batchId = String(ctx.params.id ?? '');
    if (!KEY.test(batchId)) fail(404, '批次不存在');
    const { grant } = ownedBatch(ctx, batchId);
    const viewer = auth.byId(grant.user_id);
    const plan = JSON.parse(q.deviceById.get(grant.device_id).plan_json);
    const rows = new Map(q.workRows.all(grant.user_id, batchId).map((row) => [row.work_key, row]));
    return {
      batchId,
      payloadDigest: grant.payload_digest,
      expiresAt: new Date(grant.expires_at).toISOString(),
      revoked: Boolean(grant.revoked_at),
      works: plan.works.map((work) => {
        const row = rows.get(work.key);
        const stored = row?.work_id ? library.work(work.task, row.work_id, null, viewer) : null;
        return {
          key: work.key,
          task: work.task,
          title: work.title,
          state: row?.status ?? 'planned',
          workId: row?.status === 'committed' ? row.work_id : null,
          status: stored?.status ?? null,
          moderation: stored?.moderation?.status ?? null,
        };
      }),
    };
  }

  function revoke(ctx) {
    if (ctx.req.headers.authorization) fail(403, '吊销只能由已登录的人确认', 'batch_forbidden');
    assertSameOrigin(ctx.req, config);
    const user = ctx.user ?? fail(401, '请先登录');
    const batchId = String(ctx.params.id ?? '');
    const grant = q.grantForBatch.get(batchId);
    if (!grant) fail(404, '批次不存在');
    if (grant.user_id !== user.id && !isSenior(user)) fail(404, '批次不存在');
    q.revokeGrant.run(Date.now(), batchId);
    note(user, 'batch-revoke', { batchId, digest: grant.payload_digest, result: 'revoked' });
    return { ok: true, batchId, revoked: true };
  }

  function cancel(ctx) {
    const batchId = String(ctx.params.id ?? '');
    if (!KEY.test(batchId)) fail(404, '批次不存在');
    const token = bearerValue(ctx.req);
    if (token && ctx.user) fail(403, '不能同时使用登录会话和批量授权', 'batch_forbidden');
    let user;
    let grant;
    if (token) {
      ({ user, grant } = grantFromToken(token));
      if (grant.batch_id !== batchId) fail(403, '批量授权不能用于其他批次', 'batch_forbidden');
    } else {
      assertSameOrigin(ctx.req, config);
      user = ctx.user ?? fail(401, '请先登录');
      grant = q.grantForBatch.get(batchId);
      if (!grant || (grant.user_id !== user.id && !isSenior(user))) fail(404, '批次不存在');
    }
    const open = q.workRows.all(grant.user_id, batchId).filter((row) => row.status !== 'committed');
    for (const row of open) rmSync(stagingPath(grant.user_id, batchId, row.work_key), { recursive: true, force: true });
    q.releaseBatch.run(grant.user_id, batchId);
    q.cancelOpen.run(Date.now(), grant.user_id, batchId);
    note(user, 'batch-cancel', { batchId, digest: grant.payload_digest, result: 'cancelled' });
    return {
      ok: true,
      batchId,
      cancelled: open.map((row) => row.work_key),
      kept: q.workRows.all(grant.user_id, batchId).filter((row) => row.status === 'committed').map((row) => row.work_key),
    };
  }

  function sweep() {
    const now = Date.now();
    q.expireDevices.run(now);
    for (const row of q.stale.all()) {
      const abandoned = row.revoked_at || (row.grant_expires && row.grant_expires <= now) || now - row.created_at > 30 * 60e3;
      if (!abandoned) continue;
      rmSync(stagingPath(row.user_id, row.batch_id, row.work_key), { recursive: true, force: true });
      q.setReservation.run('released', row.id);
      const current = q.workRow.get(row.user_id, row.batch_id, row.work_key);
      if (current && current.status !== 'committed') q.markWork.run('failed', null, now, row.user_id, row.batch_id, row.work_key);
    }
  }

  sweep();
  const timer = setInterval(sweep, 60e3);
  timer.unref?.();
  return {
    register, view, approve, poll, upload, status, revoke, cancel, sweep,
    close() { clearInterval(timer); },
  };
}
