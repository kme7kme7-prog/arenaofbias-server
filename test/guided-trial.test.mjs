import { finishViewing } from './helpers/arena.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { ASPECTS } from '../server/aspects.mjs';

test('guided pairs are staff-only trials that ask one aspect question and stay off every board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guided-trial-'));
  const dist = join(root, 'dist');
  const tasks = [['tower', '建模'], ['page', '静态网页']].map(([id, category]) => ({ id, title: id, summary: 'Summary', prompt: 'Build',
    category, domains: ['建筑'], results: ['a', 'b'].map((model) => {
      const scene = `results/${id}/${model}/`;
      mkdirSync(join(dist, scene), { recursive: true });
      writeFileSync(join(dist, scene, 'index.html'), `<title>${id}</title>`);
      return { id: model, model, effort: 'High', scene, generationMode: 'single-turn', humanIntervention: 'none' };
    }) }));
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks }));
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    siteOrigins: [], admins: [], cdn: [], capture: false, secureCookies: false }, limits });
  const { arena, db } = platform;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const guided = (user, task) => arena.createMatch(user, task, null, undefined, false, null, null, true);
  try {
    const [member, admin, moderator] = [['member', 'user'], ['admin', 'admin'], ['moderator', 'moderator']].map(([id, role]) => ({ id, name: id, role }));
    for (const user of [member, admin, moderator]) db.prepare('INSERT INTO users (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.name, 'unused', 'unused', 1);

    // Ordinary pairs are unchanged and take no trial fields.
    const plain = await arena.createMatch(admin, 'tower');
    assert.deepEqual(['aspect' in plain, 'guided' in plain, plain.counted], [false, false, true]);
    finishViewing(db, plain.id);
    assert.throws(() => arena.vote(admin, plain.id, 'tie', { tieKind: 'good' }), { status: 400 });

    await assert.rejects(guided(member, 'tower'), { status: 403, code: 'guided-staff-only' });
    const page = await guided(admin, 'page');
    assert.deepEqual([page.guided, page.aspect, page.counted, page.countableFor], [true, null, false, { public: false, curated: false }]);

    const first = await guided(admin, 'tower');
    assert.ok(ASPECTS['建模'].some((aspect) => aspect.id === first.aspect.id && aspect.question === first.aspect.question));
    finishViewing(db, first.id);
    assert.throws(() => arena.vote(admin, first.id, 'a', { tieKind: 'good' }), { status: 400 });
    assert.throws(() => arena.vote(admin, first.id, 'a', { aspect: { id: 'other', choice: 'a' } }), { status: 400 });
    const result = arena.vote(admin, first.id, 'tie', { tieKind: 'bad', aspect: { id: first.aspect.id, choice: 'tie', tieKind: 'good' } });
    assert.deepEqual([result.counted, result.reason, result.tieKind, result.aspect], [false, 'trial', 'bad', { id: first.aspect.id, choice: 'tie', tieKind: 'good' }]);
    assert.ok(result.a && result.b, 'a trial ballot still reveals the pair');

    // The next trial pair asks a question with fewer answers; leaving it out skips only that question.
    const second = await guided(moderator, 'tower');
    assert.notEqual(second.aspect.id, first.aspect.id);
    finishViewing(db, second.id);
    assert.equal(arena.vote(moderator, second.id, 'b').reason, 'trial');
    const rows = db.prepare('SELECT user_id, choice, tie_kind, aspect_id, aspect_choice, aspect_tie_kind FROM guided_trial_votes ORDER BY created_at, rowid').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { user_id: 'admin', choice: 'tie', tie_kind: 'bad', aspect_id: first.aspect.id, aspect_choice: 'tie', aspect_tie_kind: 'good' },
      { user_id: 'moderator', choice: 'b', tie_kind: null, aspect_id: second.aspect.id, aspect_choice: null, aspect_tie_kind: null },
    ]);
    assert.equal(count('votes'), 0);
    assert.equal((await arena.leaderboard({ task: 'tower' })).totals.votes, 0);

    // The ordinary ballot still counts as before.
    assert.equal(arena.vote(admin, plain.id, 'a').counted, true);
    assert.deepEqual([count('votes'), count('guided_trial_votes')], [1, 2]);
  } finally {
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});
