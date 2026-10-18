import { createHash, randomBytes } from 'node:crypto';
import { uniqueCookie, HttpError } from './http.mjs';
import { isStaff, levelOf } from './roles.mjs';
import { turnstileSiteKey, verifyTurnstile } from './turnstile.mjs';

export const MIN_VIEW_MS = 5000, MIN_SKIP_MS = 3000;
export function timing(match) {
  return { readyAt: match.ready_at == null ? null : new Date(match.ready_at).toISOString(),
    voteAllowedAt: match.ready_at == null ? null : new Date(match.ready_at + MIN_VIEW_MS).toISOString(),
    skipAllowedAt: match.ready_at == null ? null : new Date(match.ready_at + MIN_SKIP_MS).toISOString(), serverNow: new Date().toISOString() };
}
export function checkTiming(match, choice, now = Date.now()) {
  if (choice === 'skip' && match.ready_at == null) return;
  if (match.ready_at == null) throw new HttpError(409, '请等待两侧作品载入', 'match_not_ready');
  const delay = choice === 'skip' ? MIN_SKIP_MS : MIN_VIEW_MS;
  if (now < match.ready_at + delay) {
    const error = new HttpError(409, '请再观看一会儿', 'vote_too_early');
    error.retryAfter = Math.ceil((match.ready_at + delay - now) / 1000);
    error.details = timing(match);
    throw error;
  }
}
export function createArenaVoters({ db, config }) {
  const cookieName = config.secureCookies ? '__Host-aob_voter' : 'aob_voter';
  const queues = new Map();
  const state = key => db.prepare('SELECT * FROM arena_voter_state WHERE actor_key=?').get(key) ??
    { actor_key: key, guest_votes_remaining: 0, fast_streak: 0, challenge_required: 0, verified_at: null };
  const save = s => db.prepare(`INSERT INTO arena_voter_state VALUES (?,?,?,?,?,?)
    ON CONFLICT(actor_key) DO UPDATE SET guest_votes_remaining=excluded.guest_votes_remaining,
    fast_streak=excluded.fast_streak,challenge_required=excluded.challenge_required,verified_at=excluded.verified_at,updated_at=excluded.updated_at`)
    .run(s.actor_key, s.guest_votes_remaining, s.fast_streak, s.challenge_required, s.verified_at, Date.now());
  const challenge = (voter, s = state(voter.key)) => {
    const required = !voter.user ? s.guest_votes_remaining === 0 : !isStaff(voter.user) && Boolean(s.challenge_required);
    return { required, reason: required ? !voter.user ? s.verified_at ? 'guest_interval' : 'guest_entry' : 'rapid_choices' : null,
      siteKey: turnstileSiteKey(), action: 'arena', guestVotesRemaining: voter.user ? null : s.guest_votes_remaining };
  };
  const verify = async (voter, token, ip) => {
    const s = state(voter.key);
    if (!token) {
      const error = new HttpError(403, '请先完成人机验证', 'turnstile_required');
      error.details = { challenge: challenge(voter, s) };
      throw error;
    }
    const verdict = await verifyTurnstile(token, ip, { required: true, action: 'arena',
      hostnames: config.siteOrigins.map(origin => new URL(origin).hostname) });
    if (verdict !== 'ok') throw new HttpError(verdict === 'down' ? 503 : 400,
      verdict === 'down' ? '人机验证服务暂时不可用，请稍后重试' : '人机验证未通过，请重试',
      verdict === 'down' ? 'turnstile_unavailable' : 'turnstile_failed');
    s.verified_at = Date.now(); s.guest_votes_remaining = 5; s.fast_streak = 0; s.challenge_required = 0;
    save(s);
  };
  return {
    actor(ctx) {
      if (ctx.user) return { key: `u:${ctx.user.id}`, user: ctx.user, visitorHash: null };
      let value = uniqueCookie(ctx.req.headers.cookie, cookieName);
      if (!/^[a-f0-9]{64}$/.test(value ?? '')) {
        value = randomBytes(32).toString('hex');
        ctx.res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=${config.cookieSameSite || 'Lax'}; Max-Age=2592000${config.secureCookies ? '; Secure' : ''}`);
      }
      const visitorHash = createHash('sha256').update(value).digest('hex');
      return { key: `g:${visitorHash}`, visitorHash, user: null };
    },
    policy(voter) { return { level: levelOf(voter.user), minViewSeconds: 5, minSkipSeconds: 3,
      rapidWindowSeconds: 10, rapidStreakLimit: 3, challenge: challenge(voter) }; },
    challenge,
    lastVerifiedAt: voter => state(voter.key).verified_at,
    async serial(voter, run) {
      const previous = queues.get(voter.key) ?? Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      queues.set(voter.key, current);
      await previous;
      try { return await run(); }
      finally { release(); if (queues.get(voter.key) === current) queues.delete(voter.key); }
    },
    async beforeMatch(voter, token, ip) {
      if (!voter.user && state(voter.key).guest_votes_remaining === 0) await verify(voter, token, ip);
    },
    async beforeVote(voter, match, choice, token, ip, receivedAt = Date.now()) {
      if (choice === 'skip') return { verified: false };
      const received = match.choice_received_at ?? receivedAt;
      db.prepare('UPDATE matches SET choice_received_at=COALESCE(choice_received_at,?) WHERE id=? AND choice IS NULL').run(received, match.id);
      match.choice_received_at = received;
      if (isStaff(voter.user)) return { verified: false };
      const s = state(voter.key);
      const rapid = received - match.ready_at <= 10000;
      if (voter.user && rapid && s.fast_streak >= 2) { s.challenge_required = 1; save(s); }
      const required = voter.user ? Boolean(s.challenge_required) : s.guest_votes_remaining === 0;
      if (required) await verify(voter, token, ip);
      return { verified: required };
    },
    accept(voter, match, choice, { verified = false } = {}) {
      if (choice === 'skip' || isStaff(voter.user)) return;
      const s = state(voter.key);
      if (!voter.user) {
        if (s.guest_votes_remaining <= 0) throw new HttpError(403, '请完成人机验证', 'turnstile_required');
        s.guest_votes_remaining--;
      } else if (!verified) {
        if (s.challenge_required) throw new HttpError(403, '请完成人机验证', 'turnstile_required');
        s.fast_streak = (match.choice_received_at ?? Date.now()) - match.ready_at <= 10000 ? s.fast_streak + 1 : 0;
      }
      save(s);
    },
    cleanup() { db.prepare("DELETE FROM arena_voter_state WHERE actor_key LIKE 'g:%' AND updated_at<?").run(Date.now() - 30 * 86400e3); },
  };
}
