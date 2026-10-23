// Explicit business operations for a separately provisioned dots administrator.
// There is no URL forwarding and no API for creating identities or granting scopes.
import { randomBytes } from 'node:crypto';
import { transaction } from './db.mjs';
import { createRouter, fail } from './http.mjs';
import { isSenior } from './roles.mjs';

export function createDotsAdminBindings({ db, auth }) {
  const token = db.prepare('SELECT id FROM moderation_tokens WHERE id = ? AND revoked_at IS NULL');
  const read = db.prepare('SELECT actor_id, revision, bound_at FROM moderation_token_admins WHERE token_id = ?');
  const save = db.prepare(`INSERT INTO moderation_token_admins (token_id, actor_id, revision, bound_at, bound_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET actor_id=excluded.actor_id, revision=excluded.revision, bound_at=excluded.bound_at, bound_by=excluded.bound_by`);
  const drop = db.prepare('DELETE FROM moderation_token_admins WHERE token_id = ?');
  const audit = (operator, action, detail) => db.prepare('INSERT INTO audit (at,actor_id,actor_name,action,detail) VALUES (?,?,?,?,?)')
    .run(Date.now(), null, operator, action, JSON.stringify(detail));
  const active = id => { if (!token.get(String(id))) fail(404, '令牌不存在或已吊销', 'not_found'); };
  return {
    describe(id) {
      const row = read.get(String(id));
      if (!row) return null;
      const actor = auth.byId(row.actor_id);
      return { actorId: row.actor_id, name: actor?.name ?? null, enabled: isSenior(actor), revision: row.revision, boundAt: row.bound_at };
    },
    authority(id) {
      const row = read.get(String(id));
      if (!row) fail(403, '令牌未绑定独立管理员', 'admin_binding_required');
      const actor = auth.byId(row.actor_id);
      if (!isSenior(actor)) fail(403, '绑定账号不再具有高级管理员权限', 'admin_actor_disabled');
      return { actor, revision: row.revision };
    },
    createAssistant(id, name = 'dots', operator = 'cli') {
      return transaction(db, () => {
        active(id);
        if (read.get(String(id))) fail(409, '令牌已绑定账号，请先核对或解绑', 'already_bound');
        // createAdmin rejects normalized name collisions. The random password is
        // never returned, logged, persisted in plaintext, or put on a command line.
        const actor = auth.createAdmin(name, randomBytes(48).toString('base64url'));
        save.run(String(id), actor.id, randomBytes(16).toString('hex'), Date.now(), operator);
        audit(operator, 'dots-admin-create', { tokenId: id, actorId: actor.id, name: actor.name });
        return this.describe(id);
      });
    },
    bind(id, actorId, operator = 'cli') {
      return transaction(db, () => {
        active(id);
        if (!isSenior(auth.byId(String(actorId)))) fail(403, '只能绑定现有高级管理员', 'admin_actor_disabled');
        save.run(String(id), String(actorId), randomBytes(16).toString('hex'), Date.now(), operator);
        audit(operator, 'dots-admin-bind', { tokenId: id, actorId });
        return this.describe(id);
      });
    },
    unbind(id, operator = 'cli') {
      return transaction(db, () => {
        const previous = read.get(String(id));
        drop.run(String(id));
        audit(operator, 'dots-admin-unbind', { tokenId: id, actorId: previous?.actor_id ?? null });
        return Boolean(previous);
      });
    },
  };
}

export function createDotsAdmin({ db, auth }) {
  const bindings = createDotsAdminBindings({ db, auth });
  const router = createRouter();
  const routes = [];
  const service = {
    bindings,
    on(method, path, handler, { status = 200 } = {}) {
      const scope = method === 'GET' ? 'admin:read' : 'admin:write';
      const noBody = method === 'GET' || path.endsWith('/moderation/retry') || path.endsWith('/:task/:id/preview')
        || method === 'DELETE' && !path.includes('/curated/') && !path.includes('/qualification/') && !path.endsWith('/:task/:id');
      const descriptor = { method, path, scope, successStatus: status, jsonBodyBytes: noBody ? 0 : path === '/api/dots/admin/guess/models' ? 8192 : 64 * 1024 };
      routes.push(descriptor);
      router.on(method, path, { scope, admin: true, status, action: `admin:${method}:${path.slice('/api/dots/admin'.length)}`,
        async run({ req, res, url, params, token, note, authorize, scopes }) {
          const actor = authorize();
          note.actorId = actor.id;
          if (noBody && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) fail(400, '此操作不接收请求正文', 'unexpected_body');
          const ctx = { req, res, url, params, receivedAt: Date.now(), user: actor, reauthorize: authorize,
            auditNote: value => { note.reason = String(value).slice(0, 500); }, scopes, dots: { tokenId: token.id, actorId: actor.id, bindingRevision: actor.bindingRevision }, auditFields: body => { note.reason = Object.keys(body).sort().join(',').slice(0, 500); } };
          return handler(ctx);
        } });
    },
    match: (method, path) => router.match(method, path),
  };
  service.on('GET', '/api/dots/admin/caps', ctx => {
    if (ctx.url.searchParams.size) fail(400, '能力查询参数无效', 'invalid_query');
    return { actor: { id: ctx.user.id, name: ctx.user.accountName, role: 'admin', level: 3 },
      scopes: ctx.scopes, routes, jsonBodyBytes: 64 * 1024, recapture: { supported: true, source: '/api/dots/admin/recaptures/source', create: '/api/dots/admin/recaptures', publish: false, message: '异步隔离任务；现有图片 GET 不触发重截图，产物默认私有' } };
  });
  return service;
}
