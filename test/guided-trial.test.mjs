import { finishViewing } from './helpers/arena.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { ASPECTS, trialStandings } from '../server/aspects.mjs';

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
    const secondResult = arena.vote(moderator, second.id, 'b');
    assert.equal(secondResult.reason, 'trial');
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

    // The staff dimension chart counts the trial pairs that carried an aspect question, per model or configuration.
    assert.throws(() => arena.guidedDimensions(member), { status: 403, code: 'guided-staff-only' });
    const dimension = ASPECTS['建模'].find((aspect) => aspect.id === first.aspect.id).dimension;
    const chart = arena.guidedDimensions(moderator);
    assert.deepEqual([chart.by, chart.categories, chart.totals.pairs, chart.totals.answered, chart.totals.voters], ['model', ['建模'], 2, 1, 2]);
    const entry = Object.fromEntries(chart.entries.map((row) => [row.model, row]));
    assert.deepEqual([entry[secondResult.b.model].overall, entry[secondResult.a.model].overall],
      [{ win: 1, tie: 1, loss: 0, n: 2 }, { win: 0, tie: 1, loss: 1, n: 2 }]);
    for (const row of chart.entries) {
      assert.deepEqual(row.dimensions[dimension], { win: 0, tie: 1, loss: 0, n: 1, aspects: { [first.aspect.id]: { win: 0, tie: 1, loss: 0, n: 1 } } });
      assert.equal(Object.values(row.dimensions).reduce((sum, cell) => sum + cell.n, 0), 1);
    }
    assert.deepEqual(arena.guidedDimensions(admin, 'config').entries.map((row) => row.effort), ['High', 'High']);

    // Restricted works stay out of a non-senior staff member's chart, as on the boards.
    platform.library.restricted.add('x:secret', 'Secret', 'test');
    const sample = db.prepare('SELECT a_identity, b_identity FROM guided_trial_votes LIMIT 1').get();
    const secret = JSON.stringify({ ...JSON.parse(sample.a_identity), modelId: null, modelName: 'Secret', modelKey: 'x:secret' });
    db.prepare('INSERT INTO guided_trial_votes (id, match_id, user_id, task_id, a_work, b_work, choice, aspect_id, aspect_choice, a_identity, b_identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('secret', 'secret-match', 'admin', 'tower', 'x', 'y', 'a', first.aspect.id, 'a', secret, sample.b_identity, Date.now());
    assert.equal(arena.guidedDimensions(moderator).totals.pairs, 2);
    assert.deepEqual(arena.guidedDimensions(admin).entries.find((row) => row.key === 'x:secret')?.dimensions[dimension].win, 1);
  } finally {
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dimension chart skips pairs without an aspect question and pairs within one entry', () => {
  const work = (modelKey) => ({ modelKey, modelName: modelKey });
  const ballots = [
    { a: work('m1'), b: work('m2'), choice: 'a', aspectId: 'lighting', aspectChoice: 'b', userId: 'u1', createdAt: 2000 },
    { a: work('m1'), b: work('m1'), choice: 'a', aspectId: 'lighting', aspectChoice: 'a', userId: 'u2', createdAt: 3000 },
    { a: work('m2'), b: work('m1'), choice: 'tie', aspectId: null, aspectChoice: null, userId: 'u2', createdAt: 1000 },
    { a: work('m2'), b: work('m3'), choice: 'b', aspectId: 'floating', aspectChoice: null, userId: 'u3', createdAt: 4000 },
  ];
  const chart = trialStandings(ballots, (identity) => identity.modelKey, (identity) => ({ modelName: identity.modelName, effort: '' }));
  assert.deepEqual(chart.dimensions.map((dimension) => dimension.id), ['aesthetic', 'craft', 'logic', 'diverge']);
  assert.deepEqual(chart.dimensions[0].aspects.map((aspect) => aspect.id), ['atmosphere', 'lighting', 'material']);
  assert.deepEqual(chart.totals, { pairs: 2, answered: 1, voters: 2, since: new Date(2000).toISOString(), until: new Date(4000).toISOString() });
  const entry = Object.fromEntries(chart.entries.map((row) => [row.key, row]));
  assert.deepEqual(chart.entries.map((row) => row.key), ['m2', 'm1', 'm3']);
  assert.deepEqual([entry.m1.overall, entry.m2.overall, entry.m3.overall],
    [{ win: 1, tie: 0, loss: 0, n: 1 }, { win: 0, tie: 0, loss: 2, n: 2 }, { win: 1, tie: 0, loss: 0, n: 1 }]);
  assert.deepEqual(entry.m1.dimensions.aesthetic, { win: 0, tie: 0, loss: 1, n: 1, aspects: { lighting: { win: 0, tie: 0, loss: 1, n: 1 } } });
  assert.deepEqual(entry.m2.dimensions.aesthetic.aspects, { lighting: { win: 1, tie: 0, loss: 0, n: 1 } });
  assert.equal(entry.m3.dimensions.craft.n, 0);
});
