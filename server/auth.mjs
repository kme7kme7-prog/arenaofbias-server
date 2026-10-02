// Accounts and sessions. Passwords use scrypt; the session token lives only in an
// HttpOnly cookie and the database keeps its SHA-256.
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { AVATARS } from './config.mjs';
import { fail, HttpError, uniqueCookie } from './http.mjs';
import { transaction } from './db.mjs';

const COOKIE = 'sp_session';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const DUMMY_SALT = randomBytes(16).toString('hex');

export const newId = (bytes = 12) => randomBytes(bytes).toString('hex');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const nameKey = (name) => name.normalize('NFKC').trim().toLowerCase();

// The picked avatar, or a stable default: FNV-1a of the user id over the frozen first 16.
export function avatarOf(user) {
  if (AVATARS.includes(user.avatar)) return user.avatar;
  let hash = 0x811c9dc5;
  for (let i = 0; i < user.id.length; i++) hash = Math.imul(hash ^ user.id.charCodeAt(i), 0x01000193) >>> 0;
  return AVATARS[hash % 16];
}

export function createAuth(db, { admins, secureCookies, cookieSameSite = 'Lax', sessionTtl,
  sessionIdleTtl = 24 * 3600e3, adminSessionIdleTtl = 30 * 60e3 }) {
  if (!['Lax', 'Strict', 'None'].includes(cookieSameSite)) throw new Error('COOKIE_SAME_SITE must be Lax, Strict or None');
  if (cookieSameSite === 'None' && !secureCookies) throw new Error('COOKIE_SAME_SITE=None requires COOKIE_SECURE=1');
  const q = {
    userByKey: db.prepare('SELECT * FROM users WHERE name_key = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    listUsers: db.prepare('SELECT * FROM users ORDER BY created_at'),
    insertUser: db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insertVerifiedUser: db.prepare('INSERT INTO users (id, name, name_key, role, salt, hash, created_at, email, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    upgradeHash: db.prepare('UPDATE users SET salt = ?, hash = ?, hash_params = NULL WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setNickname: db.prepare('UPDATE users SET nickname = ? WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    setEmail: db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?'),
    resetPassword: db.prepare('UPDATE users SET salt = ?, hash = ?, hash_params = NULL WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT users.*, sessions.last_seen_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };
  const cookieName = secureCookies ? '__Host-sp_session' : COOKIE;
  const derive = (password, salt, length, options) => new Promise((resolve, reject) =>
    scrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key)));
  const hashPassword = async (password, salt) => (await derive(password, salt, 32, SCRYPT)).toString('hex');
  // Synchronous hashing is limited to password reset and CLI admin creation.
  const hashPasswordSync = (password, salt) => scryptSync(password, salt, 32, SCRYPT).toString('hex');
  const roleFor = (user) => (admins.includes(user.name_key) ? 'admin' : user.role);

  function syncRole(user) {
    const role = roleFor(user);
    if (role !== user.role) {
      q.setRole.run(role, user.id);
      user.role = role;
    }
    return user;
  }

  function validName(raw) {
    const name = String(raw ?? '').normalize('NFKC').trim();
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) fail(400, '用户名为 2–24 位文字、数字、下划线或连字符');
    return name;
  }
  function validPassword(raw) {
    const password = String(raw ?? '');
    if (password.length < 8 || password.length > 128) fail(400, '密码需要 8–128 位');
    return password;
  }

  return {
    public: (user) => (user ? { id: user.id, name: user.name, nickname: user.nickname || user.name, avatar: avatarOf(user), role: user.role } : null),
    isAdminName(rawName) {
      const key = nameKey(String(rawName ?? ''));
      const user = q.userByKey.get(key);
      return admins.includes(key) || user?.role === 'admin';
    },

    // Either field may be sent alone; a body with neither still asks for a nickname.
    updateProfile(user, body) {
      if (body.avatar !== undefined && !AVATARS.includes(body.avatar)) fail(400, '请从头像库中选择头像');
      let nickname = null;
      if (body.nickname !== undefined || body.avatar === undefined) {
        if (typeof body.nickname !== 'string') fail(400, '请填写昵称');
        nickname = body.nickname.normalize('NFKC').trim();
        if (!nickname || nickname.length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) fail(400, '昵称为 1–24 个字，不能包含换行或控制字符');
      }
      if (body.avatar !== undefined) q.setAvatar.run(body.avatar, user.id);
      if (nickname !== null) q.setNickname.run(nickname, user.id);
      return q.userById.get(user.id);
    },

    bindEmail(userId, email) {
      q.setEmail.run(email, Date.now(), userId);
      return q.userById.get(userId);
    },

    resetPassword(userId, password) {
      const valid = validPassword(password);
      const salt = randomBytes(16).toString('hex');
      q.resetPassword.run(salt, hashPasswordSync(valid, salt), userId);
      q.deleteUserSessions.run(userId);
    },

    async register(rawName, rawPassword, registration) {
      const name = validName(rawName);
      const password = validPassword(rawPassword);
      const key = nameKey(name);
      // Email registration proves the code before saying whether a name or address is taken.
      registration?.verifyCode();
      if (admins.includes(key) || q.userByKey.get(key)) fail(409, '这个用户名已被使用');
      if (registration && q.userByEmail.get(registration.email)) fail(409, '该邮箱已被其他账号绑定，请换一个。');
      const salt = randomBytes(16).toString('hex');
      const id = newId(8);
      const hash = await hashPassword(password, salt);
      if (q.userByKey.get(key)) fail(409, '这个用户名已被使用');
      if (registration) {
        if (q.userByEmail.get(registration.email)) fail(409, '该邮箱已被其他账号绑定，请换一个。');
        transaction(db, () => {
          registration.consumeCode();
          const now = Date.now();
          q.insertVerifiedUser.run(id, name, key, 'member', salt, hash, now, registration.email, now);
        });
      } else q.insertUser.run(id, name, key, 'member', salt, hash, Date.now());
      return q.userById.get(id);
    },

    createAdmin(rawName, rawPassword) {
      const name = validName(rawName);
      const password = validPassword(rawPassword);
      const key = nameKey(name);
      if (q.userByKey.get(key)) fail(409, '这个用户名已被使用');
      const salt = randomBytes(16).toString('hex');
      const id = newId(8);
      q.insertUser.run(id, name, key, 'admin', salt, hashPasswordSync(password, salt), Date.now());
      return q.userById.get(id);
    },

    async login(rawName, rawPassword) {
      const user = q.userByKey.get(nameKey(String(rawName ?? '')));
      const password = String(rawPassword ?? '').slice(0, 128);
      const currentUser = () => {
        const current = user && q.userById.get(user.id);
        if (!current || current.salt !== user.salt || current.hash !== user.hash || current.hash_params !== user.hash_params)
          fail(401, '用户名或密码不正确');
        return current;
      };
      // Hash even for unknown names so response time does not reveal which accounts exist.
      if (user?.hash_params) {
        // Malformed legacy params (bad JSON, missing/invalid scrypt fields) must not become a
        // 500: treat them exactly like a wrong password.
        try {
          const { N, r, p, keylen } = JSON.parse(user.hash_params);
          const actual = await derive(password, user.salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
          const stored = Buffer.from(user.hash, 'hex');
          if (actual.length !== stored.length || !timingSafeEqual(actual, stored)) fail(401, '用户名或密码不正确');
          const salt = randomBytes(16).toString('hex');
          const hash = await hashPassword(password, salt);
          currentUser();
          q.upgradeHash.run(salt, hash, user.id);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          fail(401, '用户名或密码不正确');
        }
      } else {
        const actual = await derive(password, user?.salt ?? DUMMY_SALT, 32, SCRYPT);
        if (!user || !timingSafeEqual(actual, Buffer.from(user.hash, 'hex'))) fail(401, '用户名或密码不正确');
        currentUser();
      }
      return syncRole(q.userById.get(user.id));
    },

    startSession(res, userId, req) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      const previous = uniqueCookie(req?.headers.cookie, cookieName);
      transaction(db, () => {
        if (previous) q.deleteSession.run(sha256(previous));
        q.purgeSessions.run(now);
        q.insertSession.run(sha256(token), userId, now, now + sessionTtl, now);
      });
      res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=${cookieSameSite}; Max-Age=${Math.floor(sessionTtl / 1000)}${secureCookies ? '; Secure' : ''}`);
    },

    endSession(req, res) {
      const token = uniqueCookie(req.headers.cookie, cookieName);
      if (token) q.deleteSession.run(sha256(token));
      res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=${cookieSameSite}; Max-Age=0${secureCookies ? '; Secure' : ''}`);
    },

    userFrom(req) {
      const token = uniqueCookie(req.headers.cookie, cookieName);
      if (!token) return null;
      const tokenHash = sha256(token);
      const now = Date.now();
      const user = q.session.get(tokenHash, now);
      if (!user) return null;
      const idleTtl = roleFor(user) === 'admin' ? adminSessionIdleTtl : sessionIdleTtl;
      if (now - user.last_seen_at >= idleTtl) {
        q.deleteSession.run(tokenHash);
        return null;
      }
      q.touchSession.run(now, tokenHash);
      delete user.last_seen_at;
      return syncRole(user);
    },

    promote(rawName, role = 'admin') {
      const user = q.userByKey.get(nameKey(String(rawName ?? '')));
      if (!user) return null;
      q.setRole.run(role, user.id);
      return { ...user, role };
    },

    // Admin web app: every account with its effective role, never the credentials.
    list() {
      return q.listUsers.all().map((user) => ({ id: user.id, name: user.name, role: roleFor(user), createdAt: new Date(user.created_at).toISOString() }));
    },

    setRole(actor, userId, role) {
      if (!['admin', 'member'].includes(role)) fail(400, '角色无效');
      const user = q.userById.get(String(userId ?? ''));
      if (!user) fail(404, '用户不存在');
      if (user.id === actor.id) fail(409, '不能修改自己的角色，避免把自己锁在管理端之外');
      if (admins.includes(user.name_key) && role !== 'admin') fail(409, '该账号由 ADMIN_USERNAMES 固定为管理员，请先修改服务器配置');
      q.setRole.run(role, user.id);
      return { id: user.id, name: user.name, role };
    },
  };
}
