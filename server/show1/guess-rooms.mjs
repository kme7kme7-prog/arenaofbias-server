// Friend-room state belongs to the server. A room code is an invitation, never a player credential.
import { randomBytes, randomInt } from 'node:crypto';
import { transaction } from '../db.mjs';
import { fail } from '../http.mjs';
import { ATTRIBUTE_KEYS, GUESS_MODELS, catalogRevision, judge, modelById, poolForDifficulty } from './guess-logic.mjs';

export const FRIEND_RULES = Object.freeze({ attempts: 8, roundMs: 120000, graceMs: 30000, wins: 2, intermissionMs: 6000 });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACTIVE = new Set(['waiting', 'starting', 'playing', 'round_over']);
const online = (player, now) => Boolean(player && !player.left && now - player.seenAt < 12000);
const publicModel = (m) => m ? Object.fromEntries(['id', 'name', 'vendor', 'released', 'openWeights', 'contextK', 'modalities', 'reasoning', 'priceOut', 'priceTier', 'difficulty', 'aliases', 'answerEligible', 'dailyEligible'].map(key => [key, m[key]])) : null;
const roomModel = (room, id) => room.catalog ? room.catalog.find(m => m.id === id) : modelById.get(id);
const unavailable = () => fail(404, '房间不可用，请检查房间码或让好友重新创建。', 'room_unavailable');
const validCode = (code) => typeof code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code);

export function createGuessRooms({ db, clock = Date.now }) {
  const listeners = new Set();
  const q = {
    get: db.prepare('SELECT state FROM guess_friend_rooms WHERE code = ?'),
    mine: db.prepare('SELECT state FROM guess_friend_rooms WHERE (host_id = ? OR guest_id = ?) AND expires_at > ? ORDER BY updated_at DESC'),
    active: db.prepare("SELECT state FROM guess_friend_rooms WHERE status IN ('waiting','starting','playing','round_over')"),
    count: db.prepare('SELECT COUNT(*) AS n FROM guess_friend_rooms'),
    activeCount: db.prepare("SELECT COUNT(*) AS n FROM guess_friend_rooms WHERE status IN ('waiting','starting','playing','round_over')"),
    save: db.prepare(`INSERT INTO guess_friend_rooms(code,host_id,guest_id,status,state,expires_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET guest_id=excluded.guest_id,status=excluded.status,state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at`),
    prune: db.prepare('DELETE FROM guess_friend_rooms WHERE expires_at <= ?'),
  };
  const load = code => { const row = q.get.get(code); return row ? JSON.parse(row.state) : null; };
  const emit = code => { for (const listener of listeners) listener(code); };
  const save = room => {
    room.version++;
    q.save.run(room.code, room.players[0].id, room.players[1]?.id ?? null, room.status, JSON.stringify(room), room.expiresAt, clock());
  };
  const seatOf = (room, id) => room.players.findIndex(p => p?.id === id && !p.left);
  const activeFor = id => q.mine.all(id, id, clock()).map(row => JSON.parse(row.state)).find(r => ACTIVE.has(r.status) && seatOf(r, id) >= 0);
  const member = (code, id) => {
    const room = validCode(code) && load(code);
    if (!room || room.expiresAt <= clock() || seatOf(room, id) < 0) unavailable();
    return room;
  };
  const player = user => ({ id: user.id, name: user.nickname || user.name, ready: false, score: 0, seenAt: clock(), guesses: [], lastGuessAt: 0, left: false });

  function view(room, id) {
    const self = seatOf(room, id);
    if (self < 0) unavailable();
    const complete = ['round_over', 'finished'].includes(room.status);
    return {
      code: room.code, version: room.version, status: room.status, self, difficulty: room.difficulty,
      catalogVersion: room.catalogVersion ?? null,
      round: room.round, roundEndsAt: room.roundEndsAt, nextAt: room.nextAt, expiresAt: room.expiresAt,
      serverNow: clock(), rules: FRIEND_RULES, result: room.result,
      answer: complete ? publicModel(roomModel(room, room.target)) : null,
      players: room.players.map((p, seat) => p ? {
        seat, name: p.name, ready: p.ready, score: p.score, connected: online(p, clock()),
        reconnectUntil: p.seenAt + FRIEND_RULES.graceMs, left: p.left,
        guesses: p.guesses.map(g => ({
          attributes: seat === self || complete ? g.feedback.attributes
            : Object.fromEntries(ATTRIBUTE_KEYS.map(key => [key, { state: g.feedback.attributes[key].state, arrow: null }])),
          won: g.feedback.won,
          ...(seat === self || complete ? { model: publicModel(roomModel(room, g.id)) } : {}),
        })),
      } : null),
    };
  }
  function finish(room, winner, reason) {
    room.status = 'finished';
    room.result = { winner, reason, matchWinner: winner };
    room.roundEndsAt = null;
    room.nextAt = null;
    room.expiresAt = clock() + 3600000;
  }
  function roundOver(room, winner, reason) {
    if (winner !== null) room.players[winner].score++;
    const matchWinner = room.players.findIndex(p => p.score >= FRIEND_RULES.wins);
    room.result = { winner, reason, matchWinner: matchWinner < 0 ? null : matchWinner };
    room.roundEndsAt = null;
    if (matchWinner >= 0) finish(room, matchWinner, reason);
    else {
      room.status = 'round_over';
      room.nextAt = clock() + FRIEND_RULES.intermissionMs;
    }
  }
  function prepareRound(room) {
    // Use the same difficulty/group weighting as practice, but an independent secret draw.
    if (!room.catalog) {
      room.catalog = structuredClone(GUESS_MODELS);
      room.catalogVersion = catalogRevision(room.catalog);
      room.rulesVersion = 2;
    }
    const pool = poolForDifficulty(room.catalog, room.difficulty);
    const unused = pool.filter(m => !room.previous.includes(m.id));
    const groups = new Map();
    for (const m of unused.length ? unused : pool) {
      const key = m.groupId ?? m.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    if (!groups.size) fail(503, '这一档暂时没有可用模型。');
    const group = [...groups.values()][randomInt(groups.size)];
    room.target = group[randomInt(group.length)].id;
    room.previous = [...room.previous, room.target].slice(-30);
    room.round++;
    room.status = 'starting';
    room.nextAt = clock() + 3000;
    room.roundEndsAt = null;
    room.result = null;
    room.requests = {};
    for (const p of room.players) { p.guesses = []; p.lastGuessAt = 0; p.ready = false; }
  }
  function advance(room) {
    if (!ACTIVE.has(room.status)) return;
    const now = clock();
    if (now >= room.expiresAt) { finish(room, null, 'expired'); return; }
    if (room.status === 'waiting') {
      if (now - room.players[0].seenAt >= FRIEND_RULES.graceMs) {
        room.status = 'closed'; room.expiresAt = now + 60000;
      } else if (room.players[1] && now - room.players[1].seenAt >= FRIEND_RULES.graceMs) {
        room.players[1] = null; room.players[0].ready = false;
      }
      return;
    }
    if (room.rulesVersion !== 2 || !roomModel(room, room.target)) { finish(room, null, 'catalog_changed'); return; }
    const gone = room.players.map(p => now - p.seenAt >= FRIEND_RULES.graceMs);
    if (gone.some(Boolean)) { finish(room, gone.every(Boolean) ? null : gone[0] ? 1 : 0, gone.every(Boolean) ? 'abandoned' : 'disconnect'); return; }
    if (room.status === 'starting' && now >= room.nextAt) {
      room.status = 'playing';
      room.roundEndsAt = room.nextAt + FRIEND_RULES.roundMs;
      room.nextAt = null;
    }
    if (room.status === 'playing' && now >= room.roundEndsAt) roundOver(room, null, 'timeout');
    if (room.status === 'round_over' && now >= room.nextAt && room.players.every(p => online(p, now))) prepareRound(room);
  }
  function settle(code) {
    let changed = false;
    transaction(db, () => {
      const room = load(code);
      if (!room) return;
      const before = JSON.stringify(room);
      advance(room);
      if (JSON.stringify(room) !== before) { save(room); changed = true; }
    });
    if (changed) emit(code);
  }
  function run(user, code, action) {
    settle(code);
    const room = transaction(db, () => {
      const state = member(code, user.id);
      action(state, seatOf(state, user.id));
      save(state);
      return state;
    });
    emit(code);
    return view(room, user.id);
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    tick() {
      for (const { state } of q.active.all()) settle(JSON.parse(state).code);
      q.prune.run(clock());
    },
    read(user, code) { return view(member(code, user.id), user.id); },
    sync(user, code) {
      return run(user, code, (room, seat) => { room.players[seat].seenAt = clock(); });
    },
    current(user) {
      const rooms = q.mine.all(user.id, user.id, clock()).map(row => JSON.parse(row.state));
      const room = rooms.find(r => ACTIVE.has(r.status) && seatOf(r, user.id) >= 0)
        ?? rooms.find(r => r.status === 'finished' && seatOf(r, user.id) >= 0);
      return room ? this.sync(user, room.code) : null;
    },
    create(user, difficulty) {
      if (![1, 2, 3, 4].includes(difficulty)) fail(400, '请选择有效难度。');
      this.tick();
      const room = transaction(db, () => {
        const existing = activeFor(user.id);
        if (existing) return existing; // A lost create response must not create another room.
        if (q.count.get().n >= 2000 || q.activeCount.get().n >= 200) fail(503, '房间暂时已满，请稍后再试。');
        let code;
        do { code = [...randomBytes(8)].map(n => ALPHABET[n & 31]).join(''); } while (q.get.get(code));
        const state = { code, version: 0, status: 'waiting', difficulty, players: [player(user), null],
          round: 0, target: null, previous: [], roundEndsAt: null, nextAt: null, result: null, requests: {}, expiresAt: clock() + 15 * 60000 };
        save(state);
        return state;
      });
      emit(room.code);
      return view(room, user.id);
    },
    join(user, code) {
      if (!validCode(code)) unavailable();
      settle(code);
      const room = transaction(db, () => {
        const state = load(code);
        if (!state || state.expiresAt <= clock()) unavailable();
        if (seatOf(state, user.id) >= 0) { state.players[seatOf(state, user.id)].seenAt = clock(); save(state); return state; }
        if (state.status !== 'waiting' || state.players[1]) unavailable();
        if (activeFor(user.id)) fail(409, '请先退出正在进行的好友房。', 'already_in_room');
        state.players[1] = player(user);
        state.players[0].ready = false;
        save(state);
        return state;
      });
      emit(code);
      return view(room, user.id);
    },
    ready(user, code, ready) {
      if (typeof ready !== 'boolean') fail(400, '准备状态无效。');
      return run(user, code, (room, seat) => {
        if (room.status !== 'waiting') fail(409, '对局已开始，请刷新房间状态。', 'stale_round');
        room.players[seat].seenAt = clock();
        room.players[seat].ready = ready;
        if (room.players.every(p => p?.ready && online(p, clock()))) {
          room.expiresAt = clock() + 3600000;
          prepareRound(room);
        }
      });
    },
    guess(user, code, body) {
      if (!Number.isInteger(body.round) || typeof body.guessId !== 'string' || body.guessId.length > 100
        || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId)) fail(400, '猜测请求格式无效。');
      return run(user, code, (room, seat) => {
        if (body.round !== room.round) fail(409, '已进入下一轮，请同步房间。', 'stale_round');
        const key = `${seat}:${body.requestId}`;
        if (room.requests[key]) {
          if (room.requests[key] !== body.guessId) fail(409, '这次请求已经处理过。', 'request_conflict');
          return;
        }
        if (room.status !== 'playing') fail(409, '这一轮已经结束或还未开始。', 'stale_round');
        const p = room.players[seat];
        if (p.guesses.length >= FRIEND_RULES.attempts) fail(409, '本轮机会已用完，请等待对方。', 'attempts_exhausted');
        const model = roomModel(room, body.guessId);
        if (!model) fail(400, '没有找到这个模型。');
        if (p.guesses.some(g => g.id === model.id)) fail(409, '这个模型已经猜过了。', 'duplicate_guess');
        if (clock() - p.lastGuessAt < 750) fail(429, '提交太快，请稍等一下。', 'guess_too_fast');
        const feedback = judge(model, roomModel(room, room.target));
        p.guesses.push({ id: model.id, feedback });
        p.lastGuessAt = clock();
        p.seenAt = clock();
        room.requests[key] = model.id;
        if (feedback.won) roundOver(room, seat, 'guessed');
        else if (room.players.every(p => p.guesses.length >= FRIEND_RULES.attempts)) roundOver(room, null, 'exhausted');
      });
    },
    leave(user, code) {
      // Unlike other commands, a player who leaves must no longer receive a private room view.
      settle(code);
      transaction(db, () => {
        const room = member(code, user.id);
        const seat = seatOf(room, user.id);
        if (room.status === 'waiting' && seat === 1) {
          room.players[1] = null; room.players[0].ready = false;
        } else {
          if (room.status === 'waiting') { room.status = 'closed'; room.expiresAt = clock() + 60000; }
          else if (ACTIVE.has(room.status)) finish(room, 1 - seat, 'left');
          room.players[seat].left = true;
        }
        save(room);
      });
      emit(code);
      return { ok: true };
    },
    catalog: user => {
      const room = user ? q.mine.all(user.id, user.id, clock()).map(row => JSON.parse(row.state))
        .find(r => seatOf(r, user.id) >= 0 && r.status !== 'closed') : null;
      const models = room?.catalog ?? GUESS_MODELS;
      return { models: models.map(publicModel), attributes: ATTRIBUTE_KEYS, catalogVersion: catalogRevision(models) };
    },
  };
}
