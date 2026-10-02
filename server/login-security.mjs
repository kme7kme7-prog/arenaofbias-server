// Failed password budgets cover both a source and a normalized account across IPs.
// Every account uses the same response and limits, including nonexistent names.
import { nameKey } from './auth.mjs';
import { HttpError } from './http.mjs';

const WINDOW = 15 * 60e3;
const MAX_FAILURES = 5;
const MAX_ACTIVE = 32;

export function createLoginSecurity(db, { isAdminName, now = Date.now }) {
  const accounts = new Map();
  const sources = new Map();
  const audit = db.prepare('INSERT INTO audit (at, actor_name, action, detail) VALUES (?, ?, ?, ?)');
  let lastSweep = 0;
  let active = 0;

  function limited(retryAfter) {
    const error = new HttpError(429, '登录尝试过多，请稍后再试', 'login_limited');
    error.retryAfter = retryAfter;
    throw error;
  }

  function state(map, key, at) {
    let value = map.get(key);
    if (!value) {
      value = { failures: [], blockedUntil: 0, active: 0, touchedAt: at };
      map.set(key, value);
    }
    value.failures = value.failures.filter((time) => time > at - WINDOW);
    value.touchedAt = at;
    return value;
  }

  function sweep(at) {
    if (at - lastSweep < 60e3) return;
    for (const map of [accounts, sources]) {
      for (const [key, value] of map) {
        if (!value.active && value.blockedUntil <= at && value.touchedAt <= at - WINDOW) map.delete(key);
      }
    }
    lastSweep = at;
  }

  return {
    begin(rawName, ip) {
      const at = now();
      sweep(at);
      if (active >= MAX_ACTIVE) limited(1);
      // Match auth.login's normalization, and bound retained attacker-controlled keys.
      const name = nameKey(String(rawName ?? '')).slice(0, 128);
      const account = state(accounts, name, at);
      const source = state(sources, ip, at);
      const blockedUntil = Math.max(account.blockedUntil, source.blockedUntil);
      const occupied = [account, source].some((value) => value.active + value.failures.length >= MAX_FAILURES);
      if (blockedUntil > at || occupied) {
        limited(blockedUntil > at ? Math.ceil((blockedUntil - at) / 1000) : 1);
      }
      account.active++;
      source.active++;
      active++;
      return { name, ip, account, source, finished: false };
    },

    failure(attempt) {
      const at = now();
      let blocked = false;
      for (const value of [attempt.account, attempt.source]) {
        value.failures = value.failures.filter((time) => time > at - WINDOW);
        value.failures.push(at);
        value.touchedAt = at;
        if (value.failures.length >= MAX_FAILURES && value.blockedUntil <= at) {
          value.blockedUntil = at + WINDOW;
          blocked = true;
        }
      }
      const admin = isAdminName(attempt.name);
      const detail = JSON.stringify({ name: attempt.name, ip: attempt.ip,
        failures: attempt.account.failures.length, blocked, until: blocked ? at + WINDOW : null });
      if (admin) audit.run(at, 'anonymous', 'admin-login-failed', detail);
      if (blocked) {
        audit.run(at, 'anonymous', 'login-blocked', detail);
        console.warn('[login-security] temporary login block', detail);
      }
    },

    success(attempt) {
      attempt.account.failures = [];
      attempt.account.blockedUntil = 0;
    },

    finish(attempt) {
      if (attempt.finished) return;
      attempt.finished = true;
      attempt.account.active--;
      attempt.source.active--;
      active--;
    },
  };
}
