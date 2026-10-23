import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
import { createQuestions } from '../server/questions.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { catalogConflict, seesRestricted } from '../server/restricted.mjs';
import { voteAfterViewing } from './helpers/arena.mjs';
import { verifiedUser } from './helpers/email.mjs';

const CODE = 'Mix';
const KEY = 'x:mix';
const page = (title) => Buffer.from(`<!doctype html><html><body><h1>${title}</h1></body></html>`);

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'restricted-model-'));
  const dist = join(root, 'dist');
  const result = (id, model) => ({ id, title: id, model, effort: 'High', scene: `results/one/${id}/`,
    generationMode: 'single-turn', humanIntervention: 'none' });
  const data = { title: 'Synthetic', models: [{ id: 'a', name: 'Alpha', vendor: 'A' }, { id: 'b', name: 'Beta', vendor: 'B' }],
    tasks: [{ id: 'one', title: 'One', summary: 'S', prompt: 'P', category: '静态网页', templates: ['static'], domains: [],
      results: [result('pa', 'a'), result('pb', 'b')] }] };
  for (const item of data.tasks[0].results) {
    mkdirSync(join(dist, item.scene), { recursive: true });
    writeFileSync(join(dist, item.scene, 'index.html'), page(item.id));
  }
  writeFileSync(join(dist, 'data.json'), JSON.stringify(data));
  const config = { dist, dataDir: join(root, 'data'), contentTemplate: 'http://{token}.localhost', siteOrigins: [], admins: [], cdn: [],
    capture: false, secureCookies: false, moderation: { enabled: false }, readLimits: { api: 10000, catalog: 10000 }, leaderboardWarmup: false };
  const platform = createPlatform({ config, limits });
  const site = createServer(platform.handleSite).listen(0, '127.0.0.1');
  await new Promise((resolve) => site.once('listening', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const { auth } = platform;
  const member = await verifiedUser(auth, 'member');
  await auth.register('helper', 'correct horse');
  const moderator = auth.bindEmail(auth.promote('helper', 'moderator').id, 'helper@example.test');
  const senior = auth.bindEmail(auth.createAdmin('root', 'correct horse').id, 'root@example.test');
  const cookies = {};
  for (const [name, user] of Object.entries({ member, moderator, senior })) {
    auth.startSession({ setHeader: (_name, value) => { cookies[name] = value.split(';')[0]; } }, user.id);
  }
  const call = async (path, who) => {
    const response = await fetch(base + path, { headers: who ? { cookie: cookies[who] } : {} });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: text ? JSON.parse(text) : null };
  };
  try { await run({ platform, call, member, moderator, senior, config, root, base, cookies }); }
  finally {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
    await platform.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// One public ballot (Alpha vs Beta) and one senior ballot pinned on the restricted model.
async function seed({ platform, member, senior }) {
  platform.library.restricted.add(KEY, CODE, 'test');
  const work = platform.library.importRestricted(senior, { taskId: 'one', code: CODE, effort: 'high', filename: 'gray.html', buffer: page('gray') });
  const publicMatch = await platform.arena.createMatch(member, 'one');
  assert.ok(voteAfterViewing(platform, member, publicMatch.id, 'a').counted);
  const pinned = await platform.arena.createMatch(senior, 'one', null, undefined, false, KEY);
  const result = voteAfterViewing(platform, senior, pinned.id, 'a');
  assert.ok(result.counted);
  assert.ok([result.a, result.b].some((side) => side.id === work.id && side.restricted === true), 'senior reveal names the restricted work');
  return work;
}

const pa = (platform) => platform.library.allWorks().find((work) => work.id === 'pa');
const keysOf = (board) => [...board.rows, ...board.unranked].map((row) => row.key);
const strip = ({ updatedAt, nextUpdateAt, refreshIntervalSeconds, ...board }) => board;

test('restricted works are invisible to anonymous, members, moderators and automation; seniors see and rank them', async () => fixture(async (f) => {
  const { platform, call, moderator } = f;
  const before = strip((await call('/api/leaderboard?by=model')).data);
  const work = await seed(f);
  const { library, arena } = platform;

  // Matrix over HTTP read paths.
  for (const who of [undefined, 'member', 'moderator']) {
    const boot = (await call('/api/bootstrap', who)).data;
    assert.ok(!boot.works.some((item) => item.id === work.id), `bootstrap hides it from ${who ?? 'anonymous'}`);
    assert.ok(!(boot.workAccess ?? []).some((item) => item.id === work.id));
    assert.equal(boot.totals.votes, 1, 'totals count only public ballots');
    assert.deepEqual(boot.arena.one, { works: 2, entries: 2 });
    const board = await call('/api/leaderboard?by=model', who);
    assert.ok(!keysOf(board.data).includes(KEY));
    assert.equal(board.data.totals.votes, 1);
    const missing = await call('/api/works/one/up-zzzzzzzz/comments', who);
    const hidden = await call(`/api/works/one/${work.id}/comments`, who);
    assert.deepEqual([hidden.status, hidden.text], [missing.status, missing.text], 'same 404 as a missing work');
    const calibration = await call(`/api/works/${work.id}/calibration`, who);
    assert.deepEqual([calibration.status, calibration.text], [(await call('/api/works/up-zzzzzzzz/calibration', who)).status,
      (await call('/api/works/up-zzzzzzzz/calibration', who)).text]);
    assert.equal((await call(`/media/${work.id}/cover.png`, who)).status, 404);
  }
  assert.ok(!(await call('/api/catalog')).data.works.some((item) => item.id === work.id));
  assert.ok(!(await call('/api/show1/works')).data.works.some((item) => item.id === work.id));
  const modList = await call('/api/admin/works', 'moderator');
  assert.ok(!modList.data.works.some((item) => item.id === work.id));
  assert.equal(modList.data.total, 2);
  const review = await call('/api/review?panel=works', 'moderator');
  assert.ok(!review.data.works.some((item) => item.id === work.id));
  assert.ok(!review.data.counts.works || review.data.counts.works === 2);
  const log = await call('/api/review?panel=log', 'moderator');
  assert.ok(!log.data.audit.some((row) => row.work === work.id), 'audit rows stay hidden');
  const hiddenDetail = await call(`/api/admin/works/one/${work.id}`, 'moderator');
  const missingDetail = await call('/api/admin/works/one/up-zzzzzzzz', 'moderator');
  assert.deepEqual([hiddenDetail.status, hiddenDetail.text], [missingDetail.status, missingDetail.text]);
  assert.throws(() => library.setFaceSettings(moderator, 'one', work.id, { show_arena: false }), (error) => error.status === 404);

  // Public score of Alpha/Beta is exactly what the public ballot alone gives.
  const publicBoard = strip((await call('/api/leaderboard?by=model')).data);
  assert.notDeepEqual(publicBoard.rows, before.rows);
  const onlyPublic = strip(await arena.leaderboard({ by: 'model' }));
  assert.deepEqual(publicBoard.rows, onlyPublic.rows);

  // Senior: works, boards (separate cache, no-store), pin list, marker.
  const seniorBoot = (await call('/api/bootstrap', 'senior')).data;
  assert.equal(seniorBoot.works.find((item) => item.id === work.id)?.restricted, true);
  assert.ok(seniorBoot.arenaModels.some((model) => model.key === KEY));
  const seniorBoard = await call('/api/leaderboard?by=model', 'senior');
  assert.equal(seniorBoard.headers.get('cache-control'), 'no-store');
  assert.ok(keysOf(seniorBoard.data).includes(KEY));
  assert.equal(seniorBoard.data.totals.votes, 2);
  assert.equal([...seniorBoard.data.rows, ...seniorBoard.data.unranked].find((row) => row.key === KEY).restricted, true);
  assert.ok(!keysOf((await call('/api/leaderboard?by=model')).data).includes(KEY), 'public cache unaffected after a senior read');
  assert.ok((await call('/api/admin/works', 'senior')).data.works.some((item) => item.id === work.id));
  assert.equal((await call(`/api/works/one/${work.id}/comments`, 'senior')).status, 200);

  // Content hosts: no stable public address; the senior preview resolves through its key.
  const stored = library.work('one', work.id, null, f.senior);
  assert.equal(library.byContentKey(stored.contentKey), null);
  assert.equal(library.publicContent(stored), false);
  const scene = library.toPublic(stored, f.senior).scene;
  assert.match(scene, /^http:\/\/p[0-9a-f]{32}\.localhost\/$/);
  assert.equal(library.previewByKey(/\/\/(p[0-9a-f]{32})\./.exec(scene)[1]).id, work.id);

  // Automation acting as the senior account, and the blind pool for others.
  const automation = { ...f.senior, automation: true };
  assert.equal(seesRestricted(automation), false);
  assert.equal(library.work('one', work.id, null, automation), null);
  assert.ok(library.eligible('one').every((item) => item.id !== work.id));
  for (let i = 0; i < 5; i++) {
    const match = await arena.createMatch(null, 'one');
    const row = platform.db.prepare('SELECT a_work, b_work FROM matches WHERE id = ?').get(match.id);
    assert.ok(![row.a_work, row.b_work].includes(work.id));
  }
  await assert.rejects(() => arena.createMatch(f.member, 'one', null, undefined, false, KEY), (error) => error.status === 403);
  assert.throws(() => library.retryModeration(f.senior, 'one', work.id), (error) => error.code === 'restricted_model');
}));

test('restricted names are reserved and restricted identities cannot be merged into public models', async () => fixture(async (f) => {
  const { platform, member, senior } = f;
  const { library } = platform;
  library.restricted.add(KEY, CODE, 'test');
  const submit = (user, modelName) => {
    const draft = library.createDraft(user, 'one', 'w.html', page(`${user.name}-${modelName}`));
    return library.submit(user, { draftId: draft.id, confirmed: true, modelName, effort: 'high', providerId: 'official', harnessOther: 'cli' });
  };
  for (const name of [CODE, 'MIX', 'mix', 'M-I-X', 'm i x', 'ＭＩＸ', KEY]) {
    assert.throws(() => submit(member, name), (error) => error.status === 400 && error.code === 'invalid_model' && !/灰度|保留|restricted|reserved/i.test(error.message));
  }
  assert.equal(submit(member, 'Mixtral').modelId, null, 'other names stay free text');
  assert.equal(submit(member, 'Alpha').modelId, 'a', 'registered public names still resolve');
  const own = submit(senior, 'M-I-X');
  assert.equal(own.vendor ?? '', '');
  assert.match(own.title, /^Mix/);
  assert.deepEqual([own.modelId, own.modelName, library.isRestricted(own)], [null, CODE, true]);
  assert.throws(() => library.setMeta(senior, 'one', own.id, { modelName: 'Alpha' }), (error) => error.code === 'restricted_model');
  assert.throws(() => library.setMeta(senior, 'one', own.id, { modelId: 'a' }), (error) => error.code === 'restricted_model');
  assert.equal(library.setMeta(senior, 'one', own.id, { title: 'Renamed', modelName: CODE }).title, 'Renamed');
  assert.equal(library.isRestricted(library.work('one', own.id, null, senior)), true);
  // Removing the registration publishes the key like any other model.
  library.restricted.remove(KEY);
  assert.ok(library.work('one', own.id));
}));

test('CLI registers restricted codes and imports only registered ones; the running server notices', async () => fixture(async (f) => {
  const { platform, call, config, root } = f;
  const cli = (...args) => spawnSync(process.execPath, ['server/cli.mjs', ...args], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATA_DIR: config.dataDir, DIST_DIR: config.dist }, encoding: 'utf8' });
  const dir = join(root, 'import');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="assets/app.js"></script></head><body><canvas></canvas></body></html>');
  writeFileSync(join(dir, 'assets/app.js'), 'console.log(1)');
  const args = ['restricted-import', '--task', 'one', '--model', CODE, '--effort', 'high', '--owner', 'root', '--dir', dir];
  const count = () => platform.db.prepare('SELECT COUNT(*) AS n FROM works').get().n;

  const refused = cli(...args);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /尚未登记/);
  assert.equal(count(), 0);
  for (const code of ['Alpha', 'ALPHA', 'a', 'B-E-T-A']) assert.equal(cli('restricted-model', 'add', code).status, 1, `${code} collides with a registered model`);
  const survey = cli('restricted-model', 'check', CODE);
  assert.equal(survey.status, 0, survey.stderr);
  assert.deepEqual(JSON.parse(survey.stdout).works, 0);
  // An older public work whose name compacts to the code blocks registration until --force.
  const draft = platform.library.createDraft(f.member, 'one', 'w.html', page('older'));
  const older = platform.library.submit(f.member, { draftId: draft.id, confirmed: true, modelName: 'M-I-X', vendor: 'V', effort: 'high', providerId: 'official', harnessOther: 'cli' });
  const blocked = cli('restricted-model', 'add', CODE);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /已有 1 件作品.*--force/);
  assert.equal(platform.library.restricted.hasKey(KEY), false);
  assert.equal(cli('restricted-model', 'add', CODE, '--force').status, 0);
  await new Promise(setImmediate); // the CLI ran synchronously inside this batch; a request would start a new one
  assert.equal(cli('restricted-model', 'add', 'm-i-x', '--force').status, 1, 'one compact name, one registration');
  // Edits keep that older work public: same name stays, a new restricted name is refused, even for seniors.
  const edited = platform.library.setMeta(f.senior, 'one', older.id, { vendor: 'W' });
  assert.deepEqual([edited.modelName, edited.vendor, platform.library.isRestricted(edited)], ['M-I-X', 'W', false]);
  assert.equal(platform.library.setMeta(f.senior, 'one', older.id, { modelName: 'M I X' }).modelName, 'M-I-X');
  assert.throws(() => platform.library.setMeta(f.senior, 'one', pa(platform).id, { modelName: 'Mix' }), (error) => error.status === 400 && error.code === 'invalid_model');
  assert.ok(platform.library.work('one', older.id), 'still public');
  assert.equal(cli('restricted-import', ...args.slice(1), '--owner', 'member').status, 1, 'owner must be a senior admin');
  const dry = cli(...args, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).files, 2);
  assert.equal(count(), 1, "dry run writes nothing");
  const done = cli(...args, '--title', 'Gray import');
  assert.equal(done.status, 0, done.stderr);
  const id = done.stdout.trim().split('\n').at(-1);
  assert.match(id, /^up-[a-z0-9]{8}$/);

  const work = platform.library.work('one', id, null, f.senior);
  assert.deepEqual([work.status, work.showArena, work.showGallery, work.moderation.status, work.modelId, work.modelName, work.files],
    ['verified', true, true, 'approved', null, CODE, 2]);
  assert.equal(platform.db.prepare('SELECT source_name, show_entertainment FROM works WHERE id = ?').get(id).source_name, 'import.zip', 'local directory name is not stored');
  assert.equal(platform.db.prepare('SELECT show_entertainment FROM works WHERE id = ?').get(id).show_entertainment, 0);
  const after = JSON.parse(cli('restricted-model', 'check', 'MIX').stdout);
  assert.deepEqual([after.registered, after.works, after.votes, after.list.map((item) => item.id)], [true, 2, 0, [older.id, id]]);
  assert.equal(platform.library.work('one', id), null);
  assert.ok((await call('/api/bootstrap', 'senior')).data.works.some((item) => item.id === id));
  assert.ok(!(await call('/api/catalog')).data.works.some((item) => item.id === id));
  assert.ok(!(await call('/api/bootstrap', 'moderator')).data.works.some((item) => item.id === id));
  assert.equal(platform.library.eligible('one', null, f.senior).some((item) => item.id === id), true);
  // Unregistering from another process publishes the work on the next read.
  assert.equal(cli('restricted-model', 'remove', CODE).status, 0);
  assert.ok((await call('/api/catalog')).data.works.some((item) => item.id === id));
}));

test('catalog conflicts compare compact names, ids and aliases', () => {
  const models = [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', aliases: ['Astra Six'] }, { id: 'mixtral-8x7b', name: 'Mixtral 8x7B' }];
  const compact = (text) => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const catalog = { models: () => models, model: (id) => models.find((model) => model.id === id) ?? null,
    modelNamed: (name) => models.find((model) => [model.name, ...(model.aliases ?? [])].some((item) => compact(item) === compact(name))) ?? null };
  for (const code of ['gpt-6-astra', 'GPT 6 Astra', 'astra-six', 'ＧＰＴ６ＡＳＴＲＡ', 'Mixtral8x7b', '---']) assert.equal(catalogConflict(catalog, code), true, code);
  for (const code of ['Mix', 'x:mix', 'Mixtral']) assert.equal(catalogConflict(catalog, code), false, code);
});

test('every edit entry keeps restricted works on x:mix and hides them from non-seniors', async () => fixture(async (f) => {
  const { platform, call, member, moderator, senior } = f;
  const { library } = platform;
  const addQuestion = (id, owner) => platform.db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation, category)
    VALUES (?, ?, ?, 'S', 'P', '[]', '["static"]', ?, '{"status":"approved"}', '静态网页')`).run(id, owner.id, id, Date.now());
  const work = await seed(f);
  const keyOf = () => platform.db.prepare('SELECT model_id, model_other FROM works WHERE id = ?').get(work.id);
  const intact = () => assert.deepEqual({ ...keyOf() }, { model_id: null, model_other: CODE });
  const rejected = (error) => error.status === 400 && error.code === 'restricted_model';
  const hiddenError = (error) => error.status === 404;

  // Senior edits: model changes are refused, other fields pass and the key stays.
  for (const body of [{ modelName: 'Alpha' }, { modelId: 'a' }, { modelName: 'Beta', vendor: 'B' }]) {
    assert.throws(() => library.setMeta(senior, 'one', work.id, body), rejected);
    assert.throws(() => library.setDisplay(senior, 'one', work.id, body), rejected);
    assert.throws(() => library.reviewWithMeta(senior, 'one', work.id, { status: 'verified', meta: body }), rejected);
    assert.throws(() => library.review(senior, 'one', work.id, { status: 'verified', ...body }), rejected);
    intact();
  }
  library.setMeta(senior, 'one', work.id, { title: 'Still gray', modelName: 'mix', effort: 'low' });
  library.review(senior, 'one', work.id, { status: 'verified', effort: 'high' });
  library.reviewWithMeta(senior, 'one', work.id, { status: 'verified', meta: { harnessOther: 'cli' } });
  intact();
  assert.equal(library.isRestricted(library.work('one', work.id, null, senior)), true);

  // A member-owned question is not a home for gray works: no move, no API upload.
  addQuestion('q-member', member);
  assert.throws(() => library.setMeta(senior, 'one', work.id, { task: 'q-member' }), (error) => error.status === 409);
  intact();
  const draft = library.createDraft(senior, 'q-member', 'w.html', page('senior-mix'));
  assert.throws(() => library.submit(senior, { draftId: draft.id, confirmed: true, modelName: CODE, effort: 'high', providerId: 'official' }), (error) => error.status === 409);

  // Non-senior edit entries answer exactly as for a missing work.
  for (const run of [
    () => library.setMeta(moderator, 'one', work.id, { title: 'x' }),
    () => library.setMeta(senior.automation ? senior : { ...senior, automation: true }, 'one', work.id, { title: 'x' }),
    () => library.setDisplay(moderator, 'one', work.id, { title: 'x' }),
    () => library.review(moderator, 'one', work.id, { status: 'questioned', reason: 'x' }),
    () => library.reviewWithMeta(moderator, 'one', work.id, { status: 'questioned', reason: 'x', meta: { effort: 'low' } }),
    () => library.assignInbox(moderator, [{ task: 'one', id: work.id }], { task: 'one' }),
    () => library.setMeta(member, 'one', work.id, { title: 'x' }, { author: true }),
  ]) assert.throws(run, hiddenError);
  intact();
  const missing = await call('/api/dots/works/one/up-zzzzzzzz/meta', null);
  const hidden = await call(`/api/dots/works/one/${work.id}/meta`, null);
  assert.equal(hidden.status, missing.status);

  // Counts a non-senior sees do not move with the gray work or its ballot.
  assert.equal((await call('/api/review?panel=catalog', 'moderator')).status, 403, 'question counts are a senior panel');
  const seniorRow = (await call('/api/review?panel=catalog', 'senior')).data.questions.find((item) => item.id === 'one');
  assert.deepEqual([seniorRow.works, seniorRow.votes], [3, 2]);
  assert.equal((await call('/api/admin/users', 'moderator')).status, 403, 'member counts are a senior panel');
  const seniorMembers = (await call('/api/admin/users', 'senior')).data.users;
  assert.deepEqual([seniorMembers.find((user) => user.name === 'root').works.verified, seniorMembers.find((user) => user.name === 'root').votes], [1, 1]);

  // Moving into a senior's own question is allowed and keeps the key; that question's cover cannot point at it.
  addQuestion('q-senior', senior);
  library.setMeta(senior, 'one', work.id, { task: 'q-senior' });
  intact();
  const cover = await fetch(`${f.base}/api/admin/questions/q-senior/meta`, { method: 'POST', headers: { cookie: f.cookies.senior, 'content-type': 'application/json', origin: f.base },
    body: JSON.stringify({ cover: work.id }) });
  assert.deepEqual([cover.status, (await cover.json()).error], [400, '封面必须是本题现有作品']);
}));

test('counts, deletes and previews never reveal or remove restricted works for non-seniors', async () => fixture(async (f) => {
  const { platform, call, moderator, senior } = f;
  const { library, db } = platform;
  const work = await seed(f);
  const automation = { ...senior, automation: true };
  const sum = (works) => works.reduce((total, item) => total + item.votes, 0);

  // Work list vote column: public basis for moderators, everything for seniors.
  assert.equal(sum((await call('/api/admin/works', 'moderator')).data.works), 2);
  assert.equal(sum((await call('/api/admin/works', 'senior')).data.works), 4);

  // Question deletion runs on all data: whoever cannot see the gray work gets the usual 409.
  const questions = createQuestions(db, { restricted: library.restricted });
  questions.bindCatalog(createCatalog(f.config.dist, questions));
  db.prepare(`INSERT INTO questions (id, owner_id, title, summary, prompt, tags, templates, created_at, moderation, category)
    VALUES ('q-gray', ?, 'Q', 'S', 'P', '[]', '["static"]', ?, '{"status":"approved"}', '静态网页')`).run(senior.id, Date.now());
  const gray = library.importRestricted(senior, { taskId: 'q-gray', code: CODE, effort: 'high', filename: 'g.html', buffer: page('only gray') });
  assert.throws(() => questions.remove(automation, 'q-gray'), (error) => error.status === 409 && error.message === '这道题目已有投票记录，不能删除');
  assert.ok(library.work('q-gray', gray.id, null, senior), 'gray work survives');
  assert.throws(() => questions.remove(automation, 'one'), (error) => error.status === 409 && error.message === '这道题目已有投票记录，不能删除');
  // Prompt edits see the gray work as an existing work (accepted: dots is told 409 while listing 0 works).
  assert.throws(() => questions.edit(automation, 'q-gray', { prompt: 'changed' }), (error) => error.status === 409);
  assert.equal(questions.adminGet('q-gray', automation).works, 0);

  // Voiding a public work: the moderator-visible audit line counts public ballots only.
  const opponent = db.prepare('SELECT a_work, b_work FROM votes WHERE a_work = ? OR b_work = ?').get(work.id, work.id);
  const publicSide = opponent.a_work === work.id ? opponent.b_work : opponent.a_work;
  library.remove(moderator, 'one', publicSide, { void: true, reason: 'test' });
  const line = (await call('/api/review?panel=log', 'moderator')).data.audit.find((row) => row.work === publicSide && /作废/.test(row.detail));
  assert.match(line.detail, /作废 1 票对局/);

  // A senior's preview key for a gray work stops resolving once that account is demoted.
  const scene = library.toPublic(library.work('one', work.id, null, senior), senior).scene;
  const key = /\/\/(p[0-9a-f]{32})\./.exec(scene)[1];
  assert.equal(library.previewByKey(key).id, work.id);
  // Automatic screenshots load a gray work through a key issued to its senior owner.
  const shotKey = /\/\/(p[0-9a-f]{32})\./.exec(library.captureOrigin(library.work('one', work.id, null, senior)))[1];
  assert.equal(library.previewByKey(shotKey).id, work.id);
  assert.match(library.captureOrigin(library.work('one', publicSide === 'pa' ? 'pb' : 'pa')), /^http:\/\/[a-z0-9]+\.localhost$/);
  platform.auth.promote('root', 'moderator');
  assert.equal(library.previewByKey(key), null);
  assert.equal(library.previewByKey(shotKey), null);
  assert.equal(library.captureOrigin(library.work('one', work.id, null, senior)), null, 'owner demoted: nothing to capture');
}));
