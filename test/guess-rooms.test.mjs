import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, MIGRATIONS } from '../server/db.mjs';
import { createGuessRooms, FRIEND_RULES } from '../server/show1/guess-rooms.mjs';
import { GUESS_MODELS } from '../server/show1/guess-logic.mjs';

function fixture(t) {
  const db = openDatabase(':memory:');
  let now = 1800000000000;
  const clock = () => now;
  const users = ['alice', 'bob', 'charlie'].map(id => ({ id, name: id, nickname: `${id} nickname` }));
  for (const u of users) db.prepare("INSERT INTO users(id,name,name_key,role,salt,hash,created_at) VALUES (?,?,?,'user','','',?)").run(u.id, u.name, u.name, now);
  const rooms = createGuessRooms({ db, clock });
  const [a, b, c] = users;
  const raw = code => JSON.parse(db.prepare('SELECT state FROM guess_friend_rooms WHERE code = ?').get(code).state);
  const advance = ms => { now += ms; rooms.tick(); };
  const start = () => {
    const { code } = rooms.create(a, 3);
    rooms.join(b, code);
    rooms.ready(a, code, true);
    const countdown = rooms.ready(b, code, true);
    assert.equal(countdown.status, 'starting');
    assert.equal(countdown.answer, null);
    advance(3000);
    return code;
  };
  const guess = (user, code, id, requestId = `request_${Math.random().toString(36).slice(2)}_test`) => rooms.guess(user, code, { round: raw(code).round, guessId: id, requestId });
  t.after(() => db.close());
  return { db, clock, rooms, a, b, c, raw, advance, start, guess };
}
const status = expected => error => error.status === expected;

test('room catalogue and feedback survive source edits and service reconstruction', t => {
  const { db, clock, rooms, a, b, start, raw } = fixture(t);
  const code = start();
  const state = raw(code);
  const target = GUESS_MODELS.find(m => m.id === state.target);
  const saved = structuredClone(target);
  target.contextK = 1;
  target.priceTier = 5;
  target.difficulty = 4;
  target.answerEligible = false;
  target.dailyEligible = false;
  t.after(() => Object.assign(target, saved));
  const restored = createGuessRooms({ db, clock });
  const snapshot = restored.catalog(a).models.find(m => m.id === target.id);
  assert.equal(snapshot.contextK, saved.contextK);
  assert.equal(snapshot.priceTier, saved.priceTier);
  assert.equal(snapshot.difficulty, saved.difficulty);
  assert.equal(snapshot.answerEligible, saved.answerEligible);
  assert.equal(snapshot.dailyEligible, saved.dailyEligible);
  const view = restored.guess(a, code, { round: state.round, guessId: target.id, requestId:'frozen_catalog_test_request' });
  assert.equal(view.players[0].score, 1);
  assert.equal(view.answer.contextK, saved.contextK);
  assert.equal(view.players[0].guesses[0].model.contextK, saved.contextK);
  assert.equal(rooms.read(b, code).answer.priceTier, saved.priceTier);
});

test('friend migration is append-only and idempotent', t => {
  const { db } = fixture(t);
  MIGRATIONS.at(-1)(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('room code is an invitation, private data requires membership and one active room per account', t => {
  const { rooms, a, b, c } = fixture(t);
  const room = rooms.create(a, 2);
  assert.match(room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(rooms.create(a, 4).code, room.code);
  assert.throws(() => rooms.read(b, room.code), status(404));
  assert.throws(() => rooms.ready(b, room.code, true), status(404));
  const joined = rooms.join(b, room.code);
  assert.equal(joined.self, 1);
  assert.equal(rooms.join(b, room.code).self, 1);
  assert.equal(rooms.create(b, 1).code, room.code);
  assert.throws(() => rooms.join(c, room.code), status(404));
  const other = rooms.create(c, 1);
  assert.throws(() => rooms.join(b, other.code), status(409));
  assert.equal(rooms.read(a, room.code).players[1].name, b.nickname);
});

test('server hides answers and opponent names until round completion, checks duplicate and stale guesses', t => {
  const { rooms, a, b, c, start, raw, guess, advance } = fixture(t);
  const code = start();
  const wrong = GUESS_MODELS.find(m => m.id !== raw(code).target);
  const result = guess(a, code, wrong.id, 'stable_request_id_01');
  assert.equal(result.players[0].guesses[0].model.id, wrong.id);
  const peer = rooms.read(b, code);
  const hidden = peer.players[0].guesses[0];
  assert.deepEqual(Object.keys(hidden).sort(), ['attributes', 'won']);
  assert.ok(Object.values(hidden.attributes).every(clue => clue.arrow === null));
  assert.equal(peer.answer, null);
  assert.ok(!JSON.stringify(peer).includes(raw(code).target));
  assert.ok(!JSON.stringify(peer).includes(a.id + '"'));
  assert.equal(guess(a, code, wrong.id, 'stable_request_id_01').players[0].guesses.length, 1);
  assert.throws(() => guess(a, code, raw(code).target, 'stable_request_id_01'), status(409));
  assert.throws(() => guess(a, code, wrong.id), status(409));
  assert.throws(() => guess(c, code, wrong.id), status(404));
  assert.throws(() => guess(a, code, raw(code).target), status(429));
  assert.throws(() => rooms.guess(a, code, { round: 999, guessId: wrong.id, requestId: 'stale_request_id_01' }), status(409));
  advance(800);
  const won = guess(a, code, raw(code).target, 'winning_request_id_01');
  assert.equal(won.status, 'round_over');
  assert.equal(won.players[0].score, 1);
  assert.equal(guess(a, code, raw(code).target, 'winning_request_id_01').players[0].score, 1);
  assert.throws(() => guess(b, code, raw(code).target), status(409));
  assert.equal(rooms.read(b, code).answer.id, raw(code).target);
  assert.equal(rooms.read(b, code).players[0].guesses[0].model.id, wrong.id);
});

test('two wins finish a match; intermission starts a new hidden target and old-round requests are rejected', t => {
  const { rooms, a, b, start, raw, guess, advance } = fixture(t);
  const code = start();
  const first = raw(code).target;
  guess(a, code, first);
  advance(FRIEND_RULES.intermissionMs);
  assert.equal(rooms.read(a, code).status, 'starting');
  assert.equal(rooms.read(a, code).answer, null);
  assert.notEqual(raw(code).target, first);
  advance(3000);
  assert.throws(() => rooms.guess(b, code, { round: 1, guessId: first, requestId: 'stale_previous_round_01' }), status(409));
  const won = guess(a, code, raw(code).target);
  assert.equal(won.status, 'finished');
  assert.equal(won.result.matchWinner, 0);
  assert.equal(won.players[0].score, 2);
});

test('eight guesses are enforced independently of client; exhausting both sides draws', t => {
  const { a, b, start, raw, guess, advance } = fixture(t);
  const code = start();
  const wrong = GUESS_MODELS.filter(m => m.id !== raw(code).target).slice(0, 9);
  for (const m of wrong.slice(0, 8)) { guess(a, code, m.id); advance(800); }
  assert.throws(() => guess(a, code, wrong[8].id), status(409));
  let result;
  for (const m of wrong.slice(0, 8)) { result = guess(b, code, m.id); advance(800); }
  assert.equal(result.status, 'round_over');
  assert.equal(result.result.reason, 'exhausted');
  assert.deepEqual(result.players.map(p => p.score), [0, 0]);
});

test('deadline is absolute and a late guess cannot win', t => {
  const { rooms, clock, a, b, start, raw, guess, advance } = fixture(t);
  const code = start();
  const end = rooms.read(a, code).roundEndsAt;
  while (clock() < end - 10000) { advance(5000); rooms.sync(a, code); rooms.sync(b, code); }
  advance(end - clock());
  assert.throws(() => guess(a, code, raw(code).target), status(409));
  assert.equal(rooms.read(a, code).result.reason, 'timeout');
});

test('new service instance restores exact progress and deadline; disconnected player forfeits after grace', t => {
  const { db, clock, rooms, a, b, start, raw, guess, advance } = fixture(t);
  const code = start();
  guess(a, code, GUESS_MODELS.find(m => m.id !== raw(code).target).id);
  const before = rooms.read(a, code);
  const restarted = createGuessRooms({ db, clock });
  advance(10000);
  const restored = restarted.current(a);
  assert.equal(restored.code, code);
  assert.deepEqual(restored.players[0].guesses, before.players[0].guesses);
  assert.equal(restored.roundEndsAt, before.roundEndsAt);
  advance(15000); restarted.sync(a, code);
  advance(2000);
  const ended = restarted.read(a, code);
  assert.equal(ended.status, 'finished');
  assert.equal(ended.result.reason, 'disconnect');
  assert.equal(ended.result.matchWinner, 0);
  assert.equal(restarted.current(b).status, 'finished');
});

test('leaving waiting room releases seat; leaving active match forfeits and revokes read access', t => {
  const { rooms, a, b, c, advance } = fixture(t);
  const { code } = rooms.create(a, 1);
  rooms.join(b, code);
  rooms.leave(b, code);
  assert.throws(() => rooms.read(b, code), status(404));
  rooms.join(c, code);
  rooms.ready(a, code, true); rooms.ready(c, code, true); advance(3000);
  rooms.leave(c, code);
  assert.throws(() => rooms.read(c, code), status(404));
  assert.equal(rooms.read(a, code).result.matchWinner, 0);
  assert.equal(rooms.current(c), null);
});

test('both disconnected end without a winner; rooms eventually expire and do not alter solo statistics', t => {
  const { db, rooms, a, start, advance } = fixture(t);
  const code = start();
  advance(30000);
  const ended = rooms.read(a, code);
  assert.equal(ended.status, 'finished');
  assert.equal(ended.result.matchWinner, null);
  assert.equal(ended.result.reason, 'abandoned');
  advance(3600001);
  assert.throws(() => rooms.read(a, code), status(404));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_friend_rooms').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guess_results').get().n, 0);
});
