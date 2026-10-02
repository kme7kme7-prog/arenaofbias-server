// Verified email for registration and existing accounts. Codes are one-use and only their hashes
// are stored. Reset requests always return the same public response.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { fail, rateLimit } from './http.mjs';
import { mailReady, sendVerificationEmail } from './mail.mjs';
import { verifyTurnstile } from './turnstile.mjs';
import { nameKey } from './auth.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (email) => email.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email);
const invalidCode = () => fail(400, '验证码不正确或已过期，请重新获取。');
const resetResponse = { sent: true, email: '' };

export function createEmailAuth(db, auth, { mailer = { ready: mailReady, send: sendVerificationEmail } } = {}) {
  const background = new Set();
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name_key = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    code: db.prepare('SELECT * FROM email_codes WHERE purpose = ? AND email_hash = ?'),
    save: db.prepare(`INSERT INTO email_codes (purpose, email_hash, code_hash, expires_at, attempts, last_sent_at)
      VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(purpose, email_hash) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = excluded.last_sent_at`),
    restore: db.prepare('UPDATE email_codes SET code_hash = ?, expires_at = ?, attempts = ?, last_sent_at = ? WHERE purpose = ? AND email_hash = ?'),
    delete: db.prepare('DELETE FROM email_codes WHERE purpose = ? AND email_hash = ?'),
    attempt: db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE purpose = ? AND email_hash = ?'),
  };
  const codeTtl = Number(process.env.MAIL_CODE_TTL_MS || 600000);
  const cooldown = Number(process.env.MAIL_COOLDOWN_MS || 60000);
  const maxAttempts = Number(process.env.MAIL_CODE_MAX_ATTEMPTS || 5);
  const ipLimit = rateLimit(15 * 60000, Number(process.env.MAIL_IP_MAX || 8), '发送太频繁，请稍后再试。');
  const emailLimit = rateLimit(15 * 60000, Number(process.env.MAIL_EMAIL_MAX || 3), '发送太频繁，请稍后再试。');

  async function gate(token, ip) {
    const verdict = await verifyTurnstile(token, ip);
    if (verdict === 'fail') fail(400, '人机验证未通过，请重试。');
    if (verdict === 'down') fail(503, '人机验证服务暂时不可用，请稍后重试。');
  }

  async function issue(purpose, email) {
    const emailHash = digest(email);
    const previous = q.code.get(purpose, emailHash);
    const now = Date.now();
    if (previous && now - previous.last_sent_at < cooldown) fail(429, '发送太频繁，请稍后再试。');
    const code = String(randomInt(1000000)).padStart(6, '0');
    q.save.run(purpose, emailHash, digest(`${purpose}:${emailHash}:${code}`), now + codeTtl, now);
    try {
      await mailer.send({ to: email, code, purpose });
    } catch (error) {
      if (previous) q.restore.run(previous.code_hash, previous.expires_at, previous.attempts, previous.last_sent_at, purpose, emailHash);
      else q.delete.run(purpose, emailHash);
      throw error;
    }
  }

  function match(purpose, email, code, consume = false) {
    const emailHash = digest(email);
    const row = q.code.get(purpose, emailHash);
    if (!row) return false;
    if (Date.now() >= row.expires_at || row.attempts >= maxAttempts) {
      q.delete.run(purpose, emailHash);
      return false;
    }
    const candidate = digest(`${purpose}:${emailHash}:${String(code ?? '')}`);
    const matched = typeof code === 'string' && /^\d{6}$/.test(code) &&
      timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.code_hash, 'hex'));
    if (!matched) {
      if (row.attempts + 1 >= maxAttempts) q.delete.run(purpose, emailHash);
      else q.attempt.run(purpose, emailHash);
      return false;
    }
    if (consume) q.delete.run(purpose, emailHash);
    return true;
  }

  return {
    async drain() { await Promise.all(background); },
    gate,
    async register(body) {
      if (!body.email || !body.code) fail(400, '请填写邮箱和验证码。');
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, '请填写正确的邮箱地址。');
      return auth.register(body.name ?? body.username, body.password, {
        email,
        verifyCode() { if (!match('register', email, body.code)) invalidCode(); },
        consumeCode() { q.delete.run('register', digest(email)); },
      });
    },
    async send(body, user, ip) {
      const purpose = body.purpose;
      if (!['register', 'bind', 'reset'].includes(purpose)) fail(400, '请求类型无效。');
      if (purpose === 'bind' && !user) fail(401, '请先登录后再绑定邮箱。');
      const email = purpose !== 'reset' ? normalizeEmail(body.email) : q.userByName.get(nameKey(String(body.username ?? '')))?.email;
      if (purpose !== 'reset' && !validEmail(email)) fail(400, '请填写正确的邮箱地址。');
      ipLimit(ip);
      emailLimit(digest(email || nameKey(String(body.username ?? ''))));
      await gate(body.turnstileToken, ip);
      // Ownership is checked only after the limits and the human check. A taken address
      // asking to register gets the ordinary response and a notice instead of a code.
      const owner = purpose !== 'reset' ? q.userByEmail.get(email) : null;
      if (owner && purpose === 'bind' && owner.id !== user.id) fail(409, '该邮箱已被其他账号绑定，请换一个。');
      if (!mailer.ready()) {
        if (purpose === 'reset') return resetResponse;
        fail(503, '邮件服务未配置，暂时无法发送验证码。');
      }
      if (!email) return resetResponse;
      if (owner && purpose === 'register') {
        try {
          await mailer.send({ to: email, code: null, purpose: 'registered' });
        } catch (error) {
          console.error('Email delivery failed:', error);
          fail(503, '验证码邮件发送失败，请稍后重试。');
        }
        return { sent: true, email };
      }
      if (purpose === 'reset') {
        const delivery = issue(purpose, email).catch((error) => {
          console.error('Reset email delivery failed:', error);
        });
        background.add(delivery);
        void delivery.finally(() => background.delete(delivery));
        return resetResponse;
      }
      try {
        await issue(purpose, email);
      } catch (error) {
        if (error.status) throw error;
        console.error('Email delivery failed:', error);
        fail(503, '验证码邮件发送失败，请稍后重试。');
      }
      return { sent: true, email };
    },
    verify(body, user) {
      const purpose = body.purpose;
      if (!['bind', 'reset'].includes(purpose)) fail(400, '请求类型无效。');
      if (purpose === 'bind' && !user) fail(401, '请先登录后再绑定邮箱。');
      const email = purpose === 'bind' ? normalizeEmail(body.email) : q.userByName.get(nameKey(String(body.username ?? '')))?.email;
      if (!email || !match(purpose, email, body.code)) invalidCode();
      return { ok: true };
    },
    bind(body, user) {
      if (!user) fail(401, '请先登录后再绑定邮箱。');
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, '请填写正确的邮箱地址。');
      const owner = q.userByEmail.get(email);
      if (owner && owner.id !== user.id) fail(409, '该邮箱已被其他账号绑定，请换一个。');
      if (!match('bind', email, body.code, true)) invalidCode();
      return auth.bindEmail(user.id, email);
    },
    reset(body) {
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128)
        fail(400, '密码需要 8–128 位');
      const user = q.userByName.get(nameKey(String(body.username ?? '')));
      if (!user?.email || !match('reset', user.email, body.code, true)) invalidCode();
      auth.resetPassword(user.id, body.password);
      return { reset: true };
    },
  };
}
