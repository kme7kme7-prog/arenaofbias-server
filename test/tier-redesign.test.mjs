import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlatform } from '../server/app.mjs';
import { MIGRATIONS, transaction } from '../server/db.mjs';
import { limits } from '../server/config.mjs';
import { checkTiming } from '../server/arena-voter-state.mjs';
import { IP_RETENTION_MS, normalizeIp, subnetOf } from '../server/vote-risk.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'tier-redesign-')), dist = join(root, 'dist');
  const works = Array.from({ length: 24 }, (_, i) => ({ id: `${i < 12 ? 'a' : 'b'}${i % 12}`, model: i < 12 ? 'a' : 'b',
    effort: 'High', title: `Work ${i}`, scene: `works/${i}/`, generationMode: 'single-turn', humanIntervention: 'none' }));
  for (const w of works) { mkdirSync(join(dist, w.scene), { recursive: true }); writeFileSync(join(dist, w.scene, 'index.html'), `<title>${w.title}</title><p>${w.id}</p>`); }
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    tasks: [{ id: 'supernovai', title: 'Question', prompt: 'Create a scene', category: '静态网页', results: works },
      { id: 'other', title: 'Other', prompt: 'Other scene', category: '建模', results: works }] }));
  const used = new Set(), calls = [];
  const verify = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const t = new URLSearchParams(body).get('response'); calls.push(t);
    const success = t?.startsWith('good-') && !used.has(t); used.add(t);
    res.end(JSON.stringify({ success, action: 'arena', hostname: '127.0.0.1' }));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => verify.once('listening', resolve));
  const keys = ['TURNSTILE_SITE_KEY','TURNSTILE_SECRET_KEY','TURNSTILE_VERIFY_URL'], saved = keys.map(k => process.env[k]);
  process.env.TURNSTILE_SITE_KEY = 'test-site'; process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${verify.address().port}`;
  const platform = createPlatform({ config: { dist, dataDir: join(root, 'state'), contentTemplate: 'http://{token}.localhost',
    contentPathOrigin: 'https://content.tier.test',
    siteOrigins: ['http://127.0.0.1'], admins: ['root'], cdn: [], capture: false, secureCookies: false, trustProxy: true }, limits });
  const server = createServer(platform.handleSite).listen(0, '127.0.0.1');
  const content = createServer(platform.handleContent).listen(0, '127.0.0.1');
  await Promise.all([server,content].map(s => new Promise(resolve => s.once('listening', resolve))));
  const base = `http://127.0.0.1:${server.address().port}`, jars = new Map(), users = {};
  users.root = platform.auth.createAdmin('root', 'correct horse');
  for (const name of ['member','otheruser']) users[name] = await platform.auth.register(name, 'correct horse');
  for (const [name,user] of Object.entries(users)) platform.auth.startSession({ setHeader: (_, value) => jars.set(name, value.split(';')[0]) }, user.id);
  let n = 0;
  const proof = () => `good-${++n}`;
  async function call(who, method, path, body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { origin: base,
      ...(jars.has(who) ? { cookie: jars.get(who) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) jars.set(who, response.headers.get('set-cookie').split(';')[0]);
    return { status: response.status, data: await response.json() };
  }
  async function draw(who = 'member', extra = {}) {
    const r = await call(who, 'POST', '/api/arena/matches', { task: 'supernovai', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data;
  }
  function age(match, elapsed = 6000) {
    const at = Date.now() - elapsed;
    platform.db.prepare('UPDATE matches SET created_at=?,ready_at=? WHERE id=?').run(at, at, match.id);
  }
  const vote = (who, match, extra = {}) => call(who, 'POST', `/api/arena/matches/${match.id}/vote`, { choice: 'a', ...extra });
  function getContent(url) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: content.address().port, path: u.pathname, headers: { host: u.host } }, res => {
        let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }); req.on('error', reject); req.end();
    });
  }
  try { await run({ ...platform, users, call, draw, age, vote, proof, calls, getContent }); }
  finally {
    await Promise.all([server,content,verify].map(s => new Promise(resolve => s.close(resolve))));
    await platform.close(); rmSync(root, { recursive: true, force: true });
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

test('v44 initializes existing users and 10/26 sections once without rewriting historical votes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of MIGRATIONS.slice(0,43)) typeof migration === 'function' ? migration(db) : db.exec(migration);
    db.exec("INSERT INTO users(id,name,name_key,role,salt,hash,created_at) VALUES ('u','member','member','user','s','h',1);");
    db.exec("INSERT INTO votes(id,match_id,task_id,a_work,b_work,pair_key,choice,created_at) VALUES ('old','old','supernovai','a','b','old','a',1)");
    transaction(db, () => { MIGRATIONS[43](db); MIGRATIONS[44](db); });
    assert.equal(db.prepare('SELECT member_level FROM users').get().member_level, 0);
    assert.equal(db.prepare('SELECT voter_level FROM votes').get().voter_level, null);
    assert.deepEqual(db.prepare('SELECT section_id,COUNT(*) AS n FROM curated_questions GROUP BY section_id ORDER BY n').all().map(r => [r.section_id,r.n]), [['web-design',10],['three-dimensional',26]]);
    const started = db.prepare('SELECT counting_started_at FROM curated_settings').get().counting_started_at;
    db.exec("UPDATE users SET member_level=1; DELETE FROM curated_questions WHERE task_id='supernovai'");
    transaction(db, () => { MIGRATIONS[43](db); MIGRATIONS[44](db); });
    assert.equal(db.prepare('SELECT member_level FROM users').get().member_level, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curated_questions').get().n, 35);
    assert.equal(db.prepare('SELECT counting_started_at FROM curated_settings').get().counting_started_at, started);
  } finally { db.close(); }
});

test('view and skip boundaries use server ready time, not prefetch creation time', async () => {
  const match = { ready_at: 1000 };
  for (const [choice,delay] of [['a',5000],['tie',5000],['skip',3000]]) {
    assert.throws(() => checkTiming(match, choice, 1000 + delay - 1), e => e.code === 'vote_too_early');
    assert.doesNotThrow(() => checkTiming(match, choice, 1000 + delay));
  }
  assert.doesNotThrow(() => checkTiming({ ready_at: null }, 'skip'));
  await fixture(async f => {
    const m = await f.draw();
    assert.equal((await f.vote('member', m)).data.code, 'match_not_ready');
    const ready = await f.call('member', 'POST', `/api/arena/matches/${m.id}/ready`);
    assert.equal(Date.parse(ready.data.skipAllowedAt) - Date.parse(ready.data.readyAt), 3000);
    assert.equal(Date.parse(ready.data.voteAllowedAt) - Date.parse(ready.data.readyAt), 5000);
    assert.equal((await f.vote('member', m, { choice: 'skip' })).data.code, 'vote_too_early');
    f.age(m, 3500);
    assert.equal((await f.vote('member', m)).status, 409);
    assert.equal((await f.vote('member', m, { choice: 'skip' })).data.reason, 'skipped');
    const failed = await f.draw();
    const skipped = await f.vote('member', failed, { choice: 'skip' });
    assert.equal(skipped.status, 200); assert.equal(skipped.data.a, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  });
});

test('level-zero creation is blocked while unbound public votes count', async () => fixture(async f => {
  for (const path of ['/api/questions','/api/drafts','/api/works']) {
    const r = await f.call('member', 'POST', path, {});
    assert.equal(r.status, 403); assert.equal(r.data.code, 'level_required');
  }
  const m = await f.draw(); f.age(m);
  const r = await f.vote('member', m);
  assert.equal(r.data.countedFor.public, true); assert.equal(r.data.countedFor.curated, false);
  assert.equal(f.db.prepare('SELECT voter_level FROM votes').get().voter_level, 0);
  f.auth.promote('member', 1);
  const gate = await f.call('member', 'GET', '/api/questions/eligibility');
  assert.equal(gate.data.eligibility.allowed, true);
  assert.equal((await f.call('member', 'POST', '/api/questions', {})).data.code, 'email_required');
  assert.equal((await f.call('member', 'GET', '/api/session')).data.user.levelSource, 'admin');
}));

test('third fast choice requires verification, pending survives another round, slow choices reset and staff are exempt', async () => fixture(async f => {
  for (let i = 0; i < 2; i++) { const m = await f.draw(); f.age(m); assert.equal((await f.vote('member',m)).status,200); }
  const third = await f.draw(); f.age(third);
  assert.equal((await f.vote('member',third)).data.code, 'turnstile_required');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 2);
  f.age(third, 20000);
  assert.equal((await f.vote('member',third)).data.code, 'turnstile_required');
  assert.equal((await f.vote('member',third,{ turnstileToken: f.proof() })).status,200);
  for (const elapsed of [6000,11000,6000,6000]) { const m = await f.draw(); f.age(m,elapsed); assert.equal((await f.vote('member',m)).status,200); }
  f.auth.promote('member','moderator');
  for (let i=0;i<4;i++) { const m=await f.draw(); f.age(m); assert.equal((await f.vote('member',m)).status,200); }
  assert.equal(f.calls.length,1);
}));

test('visitor first entry and each five accepted choices require server proof across prefetched matches', async () => fixture(async f => {
  const denied = await f.call('guest','POST','/api/arena/matches',{task:'supernovai'});
  assert.equal(denied.data.code,'turnstile_required');
  const matches=[], eligible=f.library.eligible;
  try {
    // Prefetch has not cast any votes yet: give each draw a distinct candidate pair.
    // Random left/right order stays real, and the server's duplicate rule stays enabled.
    for(let i=0;i<6;i++) {
      f.library.eligible=function(task,...args) {
        return eligible.call(this,task,...args).filter(w=>task!=='supernovai'||w.id==='a0'||w.id===`b${i}`);
      };
      matches.push(await f.draw('guest',i===0?{turnstileToken:f.proof()}:{}));
    }
  } finally { f.library.eligible=eligible; }
  assert.equal(new Set(matches.map(m=>{
    const row=f.db.prepare('SELECT a_work,b_work FROM matches WHERE id=?').get(m.id);
    return [row.a_work,row.b_work].sort().join('+');
  })).size,6);
  for(const m of matches) f.age(m);
  for(const m of matches.slice(0,5)) assert.equal((await f.vote('guest',m)).data.counted,true);
  assert.equal((await f.vote('guest',matches[5])).data.code,'turnstile_required');
  assert.equal((await f.vote('guest',matches[5],{turnstileToken:f.proof()})).status,200);
  assert.equal(f.calls.length,2);
  const evidence=f.db.prepare("SELECT * FROM arena_choice_evidence WHERE outcome='accepted' ORDER BY id").all();
  assert.equal(evidence.length,6);
  assert.ok(evidence[0].last_verified_at);
  assert.equal(evidence[5].turnstile_passed,1);
  const votes=f.db.prepare('SELECT user_id,visitor_hash,voter_level FROM votes').all();
  assert.equal(votes.length,6); assert.ok(votes.every(v=>v.user_id===null && v.visitor_hash && v.voter_level===null));
  assert.equal(new Set(votes.map(v=>v.visitor_hash)).size,1);
  assert.equal((await f.arena.leaderboard()).totals.voters,1);
  assert.equal((await f.arena.leaderboard({audience:'curated'})).totals.votes,0);
}));

test('senior admins maintain standard pairs and preview eligible candidates with versioned edits', async () => fixture(async f => {
  for (const level of [0,1,2]) {
    f.auth.promote('member',level);
    assert.equal((await f.call('member','GET','/api/admin/qualification')).status,403);
    assert.equal((await f.call('member','GET','/api/admin/qualification/works?taskId=supernovai')).status,403);
    assert.equal((await f.call('member','POST','/api/admin/qualification/pairs',{})).status,403);
  }
  const candidates=(await f.call('root','GET','/api/admin/qualification/works?taskId=supernovai')).data.works;
  assert.equal(candidates.length,24);
  assert.equal((await f.getContent(candidates[0].preview)).status,200);
  assert.equal((await f.getContent(candidates[12].preview)).status,200);
  assert.equal((await f.getContent(candidates[0].preview)).headers['cache-control'],'no-store');
  const initial=(await f.call('root','GET','/api/admin/qualification')).data;
  assert.deepEqual(initial.settings,{version:1,questionCount:20,passPercent:80});
  const settings=await f.call('root','PUT','/api/admin/qualification/settings',initial.settings);
  assert.equal(settings.data.settings.version,2);
  assert.equal((await f.call('root','PUT','/api/admin/qualification/settings',initial.settings)).data.code,'exam_revision_conflict');
  const created=await f.call('root','POST','/api/admin/qualification/pairs',{taskId:'supernovai',aWorkId:candidates[0].id,bWorkId:candidates[12].id,correctAnswer:'a'});
  assert.equal(created.status,200);
  const p=created.data.pair;
  const edited=await f.call('root','PATCH',`/api/admin/qualification/pairs/${p.id}`,{version:p.version,correctAnswer:'b',explanation:'B 更符合题意'});
  assert.equal(edited.data.pair.correctAnswer,'b'); assert.equal(edited.data.pair.version,2);
  assert.equal((await f.call('root','DELETE',`/api/admin/qualification/pairs/${p.id}`,{version:p.version})).data.code,'exam_revision_conflict');
  assert.equal((await f.call('root','DELETE',`/api/admin/qualification/pairs/${p.id}`,{version:2})).status,200);
  assert.equal((await f.call('root','GET','/api/admin/qualification')).data.pairs[0].enabled,false);
}));

test('standard-pair exam freezes sides, scores 16/20, resumes without expiry and never creates ballots', async () => fixture(async f => {
  assert.equal((await f.call('member','GET','/api/qualification')).data.exam.ready,false);
  for(let i=0;i<20;i++) {
    const r=await f.call('root','POST','/api/admin/qualification/pairs',{taskId:'supernovai',aWorkId:`a${Math.floor(i/12)}`,bWorkId:`b${i%12}`,correctAnswer:'a'});
    assert.equal(r.status,200,JSON.stringify(r.data));
  }
  const overview=(await f.call('member','GET','/api/qualification')).data;
  assert.equal(overview.exam.correctRequired,16); assert.equal(overview.exam.passPercent,80); assert.equal(overview.exam.ready,true);
  const failedStart=(await f.call('otheruser','POST','/api/qualification/attempts',{})).data.attempt;
  f.db.prepare('UPDATE qualification_attempts SET started_at=? WHERE id=?').run(Date.now()-90*86400e3,failedStart.id);
  f.db.prepare('UPDATE qualification_attempt_items SET token_expires_at=0 WHERE attempt_id=?').run(failedStart.id);
  const resumed=(await f.call('otheruser','POST','/api/qualification/attempts',{})).data.attempt;
  assert.equal(resumed.id,failedStart.id);
  assert.deepEqual(resumed.items.map(i=>i.id),failedStart.items.map(i=>i.id));
  assert.notEqual(resumed.items[0].a,failedStart.items[0].a,'expired tickets refresh without limiting exam duration');
  f.db.prepare(`UPDATE qualification_attempt_items SET answer=CASE WHEN position<=15 THEN correct_answer
    WHEN correct_answer='a' THEN 'b' ELSE 'a' END WHERE attempt_id=?`).run(failedStart.id);
  const failed=(await f.call('otheruser','POST',`/api/qualification/attempts/${failedStart.id}/submit`,{})).data;
  assert.equal(failed.correctCount,15); assert.equal(failed.passed,false); assert.equal(failed.user.level,0);
  assert.notEqual((await f.call('otheruser','POST','/api/qualification/attempts',{})).data.attempt.id,failedStart.id);
  const start=(await f.call('member','POST','/api/qualification/attempts',{})).data.attempt;
  assert.equal(start.items.length,20);
  assert.doesNotMatch(JSON.stringify(start),/correctAnswer|snapshot_json|aWorkId|pairId|modelName/);
  assert.equal((await f.getContent(start.items[0].a)).status,200);
  assert.equal((await f.getContent(start.items[0].a)).headers['cache-control'],'no-store');
  const saved=f.db.prepare('SELECT * FROM qualification_attempt_items WHERE attempt_id=? ORDER BY position').all(start.id);
  assert.equal(new Set(saved.map(i=>i.pair_id)).size,20);
  assert.ok(saved.every(i=>JSON.parse(i[`${i.correct_answer}_snapshot_json`]).id.startsWith('a')));
  assert.equal((await f.call('otheruser','GET',`/api/qualification/attempts/${start.id}`)).status,404);
  assert.equal((await f.call('member','POST',`/api/qualification/attempts/${start.id}/submit`,{})).data.code,'exam_incomplete');
  for(let i=0;i<20;i++) {
    const item=saved[i]; f.db.prepare('UPDATE qualification_attempt_items SET ready_at=? WHERE id=?').run(Date.now()-6000,item.id);
    const answer=i<16?item.correct_answer:item.correct_answer==='a'?'b':'a';
    const r=await f.call('member','PUT',`/api/qualification/attempts/${start.id}/items/${item.id}/answer`,{choice:answer});
    assert.equal(r.status,200); assert.equal(r.data.correct,undefined);
  }
  assert.equal((await f.call('member','GET','/api/session')).data.qualification.activeAnswered,20);
  const completed=(await f.call('member','POST',`/api/qualification/attempts/${start.id}/submit`,{})).data;
  assert.equal(completed.correctCount,16); assert.equal(completed.passed,true); assert.equal(completed.user.level,1); assert.equal(completed.user.levelSource,'exam');
  assert.ok(completed.user.levelSince);
  assert.deepEqual((await f.call('member','POST',`/api/qualification/attempts/${start.id}/submit`,{})).data,completed);
  assert.equal((await f.call('member','GET','/api/session')).data.qualification,null);
  assert.equal((await f.getContent(start.items[0].a)).status,410);
  for(const table of ['matches','votes']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='qualification-promote'").get().n,1);
  const member=(await f.call('root','GET','/api/admin/users')).data.users.find(u=>u.id===f.users.member.id);
  assert.deepEqual([member.level,member.exam.attempts,member.exam.bestCorrect,member.exam.questionCount],[1,1,16,20]);
}));

test('curated starts at zero, filters level snapshots and history, and sections have their own 30-comparison qualification', async () => fixture(async f => {
  assert.equal((await f.arena.leaderboard({audience:'curated'})).totals.votes,0);
  const epoch=f.db.prepare('SELECT counting_started_at FROM curated_settings').get().counting_started_at;
  let n=0;
  function seed(task,count,level,at=epoch) {
    const a=f.library.work(task,'a0'),b=f.library.work(task,'b0');
    const identity=w=>JSON.stringify({...w,dir:undefined,digest:createHash('sha256').update(readFileSync(join(w.dir,'index.html'))).digest('hex')});
    for(let i=0;i<count;i++) {
      const key=`seed-${++n}`;
      f.db.prepare(`INSERT INTO votes(id,match_id,user_id,task_id,a_work,b_work,pair_key,choice,created_at,source,a_identity,b_identity,voter_level)
        VALUES (?,?,?,?,?,?,?,'a',?,'arena',?,?,?)`).run(key,key,f.users.member.id,task,a.id,b.id,key,at,identity(a),identity(b),level);
    }
    f.arena.invalidate({votesOnly:true});
  }
  seed('supernovai',30,1); seed('supernovai',8,0); seed('supernovai',3,null); seed('supernovai',4,1,epoch-1); seed('other',29,2);
  assert.equal((await f.arena.leaderboard()).totals.votes,74);
  assert.equal((await f.arena.leaderboard({audience:'curated',by:'model'})).totals.votes,30);
  f.auth.promote('member',1);
  assert.equal((await f.arena.leaderboard({audience:'curated'})).totals.votes,30,'promotion never changes saved level snapshots');
  let config=(await f.call('root','GET','/api/admin/curated')).data;
  assert.equal(config.sections.reduce((sum,s)=>sum+s.selectedQuestionCount,0),1,'missing seed IDs do not inflate selected counts');
  assert.ok(config.sections.every(s=>s.selectedQuestionCount===s.questionCount && s.questionCount===s.taskIds.length));
  const missing=config.questions.find(q=>q.taskId==='chinese-architecture');
  assert.equal(missing.selected,true); assert.equal(missing.available,false); assert.ok(missing.unavailableReason);
  assert.equal((await f.call('member','PUT','/api/admin/curated/questions',{revision:config.revision,questions:[]})).status,403);
  const changed=await f.call('root','PUT','/api/admin/curated/questions',{revision:config.revision,questions:[
    {taskId:'supernovai',sectionId:'web-design'},{taskId:'other',sectionId:'three-dimensional'}]});
  assert.equal(changed.status,200);
  const metadata=(await f.call('member','GET','/api/curated')).data;
  assert.deepEqual(metadata.sections.map(s=>s.taskIds),[['supernovai'],['other']]);
  const total=await f.arena.leaderboardSnapshot({audience:'curated',by:'model'});
  assert.equal(total.totals.votes,59); assert.equal(total.rows.length,2);
  const scoped=await f.arena.leaderboard({audience:'curated',sectionId:'three-dimensional',by:'model'});
  assert.equal(scoped.totals.votes,29); assert.deepEqual(scoped.rows,[]);
  seed('other',1,1);
  assert.equal((await f.arena.leaderboard({audience:'curated',sectionId:'three-dimensional',by:'model'})).rows.length,2);
  assert.equal((await f.arena.leaderboardSnapshot({audience:'curated',by:'model'})).totals.votes,59,'new votes keep public snapshot');
  config=(await f.call('root','GET','/api/admin/curated')).data;
  assert.equal((await f.call('root','DELETE','/api/admin/curated/sections/three-dimensional',{revision:config.revision})).data.code,'section_not_empty');
  const removed=await f.call('root','DELETE','/api/admin/curated/sections/three-dimensional',{revision:config.revision,moveQuestionsTo:'web-design'});
  assert.equal(removed.status,200);
  assert.equal((await f.arena.leaderboardSnapshot({audience:'curated',by:'model'})).totals.votes,60,'config immediately invalidates snapshot');
  assert.equal((await f.call('root','PUT','/api/admin/curated/questions',{revision:config.revision,questions:[]})).data.code,'curated_revision_conflict');
  const empty=await f.call('root','PUT','/api/admin/curated/questions',{revision:removed.data.revision,questions:[]});
  assert.equal(empty.status,200);
  assert.equal((await f.arena.leaderboardSnapshot({audience:'curated'})).totals.votes,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,75,'no configuration change deletes history');
}));

test('choice evidence records submission and draw IP separately, rejected retries, timing, UA and reversible exclusions', async () => fixture(async f => {
  f.auth.promote('member',1);
  const draw=await f.call('member','POST','/api/arena/matches',{task:'supernovai'},{'x-forwarded-for':'9.9.9.9, 198.51.100.41'});
  assert.equal(draw.status,200); assert.equal(draw.data.ip,undefined); f.age(draw.data,3500);
  const path=`/api/arena/matches/${draw.data.id}/vote`, headers={'x-forwarded-for':'1.1.1.1, 203.0.113.71','user-agent':'a'.repeat(600)};
  assert.equal((await f.call('member','POST',path,{choice:'a'},headers)).data.code,'vote_too_early');
  f.age(draw.data,11000);
  assert.equal((await f.call('member','POST',path,{choice:'a'},headers)).data.counted,true);
  assert.equal((await f.call('member','POST',path,{choice:'a'},headers)).status,409);
  const raw=f.db.prepare('SELECT * FROM arena_choice_evidence ORDER BY id').all();
  assert.equal(raw.length,3); assert.deepEqual(raw.map(r=>r.outcome),['rejected','accepted','rejected']);
  assert.ok(raw.every(r=>r.ip==='203.0.113.71' && r.draw_ip==='198.51.100.41' && r.subnet==='203.0.113.0/24'));
  assert.ok(raw.every(r=>r.user_agent.length===512));
  assert.ok(raw[1].ready_elapsed_ms>=11000); assert.equal(raw[0].vote_id,null); assert.equal(raw[1].vote_id,raw[2].vote_id);
  const skipped=await f.draw(); assert.equal((await f.vote('member',skipped,{choice:'skip'})).status,200);
  assert.equal(f.db.prepare('SELECT ready_elapsed_ms FROM arena_choice_evidence WHERE match_id=?').get(skipped.id).ready_elapsed_ms,null);
  const pub=await f.arena.leaderboardSnapshot(), curated=await f.arena.leaderboardSnapshot({audience:'curated'});
  assert.equal(pub.totals.votes,1); assert.equal(curated.totals.votes,1);
  for(const level of [0,1,2]) {
    f.auth.promote('otheruser',level);
    assert.equal((await f.call('otheruser','GET','/api/admin/vote-risk/choices')).status,403);
    assert.equal((await f.call('otheruser','POST','/api/admin/vote-risk/votes/void',{voteIds:[raw[1].vote_id],reason:'复核'})).status,403);
  }
  const voidPath='/api/admin/vote-risk/votes/void',body={voteIds:[raw[1].vote_id],reason:'快速选择质量复核'};
  assert.equal((await f.call('root','POST',voidPath,{...body,voteIds:[...body.voteIds,'missing']})).status,404);
  assert.equal(f.db.prepare('SELECT voided_at FROM votes').get().voided_at,null);
  assert.equal((await f.call('root','POST',voidPath,body)).data.changed,1);
  const revision=f.db.prepare('SELECT revision FROM vote_risk_settings').get().revision;
  transaction(f.db,()=>MIGRATIONS.at(-1)(f.db));
  assert.equal(f.db.prepare('SELECT revision FROM vote_risk_settings').get().revision,revision);
  assert.equal((await f.arena.leaderboardSnapshot()).totals.votes,0);
  assert.equal((await f.arena.leaderboardSnapshot({audience:'curated'})).totals.votes,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,1);
  assert.equal((await f.call('root','POST',voidPath,body)).data.changed,0);
  assert.equal((await f.call('root','GET','/api/admin/vote-risk/choices?voided=yes')).data.rows[0].voidReason,body.reason);
  assert.equal((await f.call('root','POST','/api/admin/vote-risk/votes/restore',{...body,reason:'复核后恢复'})).data.changed,1);
  assert.equal((await f.arena.leaderboardSnapshot()).totals.votes,1);
  assert.equal((await f.arena.leaderboardSnapshot({audience:'curated'})).totals.votes,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('vote-void','vote-restore')").get().n,2);
  const stats=(await f.call('root','GET','/api/admin/vote-risk/summary?groupBy=actor')).data;
  assert.equal(stats.rows[0].choiceCount,2); assert.equal(stats.rows[0].voteCount,1,'retries never multiply aggregation');
}));

test('risk aggregates exact IP sharing, model preference and hourly peaks, then redacts raw IP after 180 days', async () => fixture(async f => {
  assert.equal(normalizeIp('::ffff:203.0.113.7'),'203.0.113.7');
  assert.equal(subnetOf('2001:0db8:1234:abcd:ffff::1'),'2001:db8:1234:abcd::/64');
  const ip='203.0.113.7'; let i=0;
  for(const who of ['member','otheruser']) for(const elapsed of [6000,12000]) {
    const match=await f.draw(who); f.age(match,elapsed);
    const saved=f.db.prepare('SELECT * FROM matches WHERE id=?').get(match.id);
    const winner=JSON.parse(saved.a_identity).modelId==='a'?'a':'b';
    assert.equal((await f.call(who,'POST',`/api/arena/matches/${match.id}/vote`,{choice:++i<4?winner:winner==='a'?'b':'a'},{'x-forwarded-for':ip})).status,200);
  }
  f.db.prepare('UPDATE arena_choice_evidence SET submitted_at=?').run(Math.floor(Date.now()/3600e3)*3600e3-1800e3);
  const grouped=(await f.call('root','GET','/api/admin/vote-risk/summary?groupBy=ip')).data.rows;
  assert.equal(grouped.length,1); assert.equal(grouped[0].voteCount,4); assert.equal(grouped[0].actorCount,2);
  assert.equal(grouped[0].fastChoiceShare,0.5); assert.equal(grouped[0].topWinnerModel.key,'a'); assert.equal(grouped[0].topWinnerShare,0.75);
  const actors=(await f.call('root','GET','/api/admin/vote-risk/summary?groupBy=actor')).data.rows;
  assert.ok(actors.every(r=>r.peakHourlyVotes===2 && r.sharedIpOtherAccounts===1));
  const bias=(await f.call('root','GET','/api/admin/vote-risk/model-voters?modelKey=a&minVotes=2')).data.rows;
  assert.deepEqual(bias.map(r=>r.winShare),[1,0.5]);
  const details=(await f.call('root','GET',`/api/admin/vote-risk/choices?ip=${ip}&modelKey=a&limit=1&offset=1`)).data;
  assert.equal(details.total,4); assert.equal(details.rows.length,1);
  assert.equal((await f.call('root','GET','/api/admin/vote-risk/choices?subnet=203.0.113.0%2F24')).data.total,4);
  const corrected=JSON.stringify({modelId:'a',modelName:'A',modelKey:'a'});
  const lastVote=f.db.prepare('SELECT vote_id FROM arena_choice_evidence ORDER BY id DESC LIMIT 1').get().vote_id;
  f.db.prepare('UPDATE votes SET a_correction=?,b_correction=? WHERE id=?').run(corrected,corrected,lastVote);
  const sameModel=(await f.call('root','GET','/api/admin/vote-risk/summary?groupBy=ip')).data.rows[0];
  assert.equal(sameModel.decisiveVotes,3); assert.equal(sameModel.topWinnerShare,1,'same-model choices do not demonstrate a model preference');
  const now=Date.now(), first=f.db.prepare('SELECT id FROM arena_choice_evidence ORDER BY id LIMIT 1').get().id;
  f.db.prepare('UPDATE arena_choice_evidence SET submitted_at=?,draw_created_at=? WHERE id=?').run(now-IP_RETENTION_MS,now-IP_RETENTION_MS,first);
  f.db.prepare('UPDATE matches SET created_at=? WHERE id=(SELECT match_id FROM arena_choice_evidence WHERE id=?)').run(now-IP_RETENTION_MS,first);
  f.voteRisk.cleanup(now);
  const expired=f.db.prepare('SELECT * FROM arena_choice_evidence WHERE id=?').get(first);
  assert.equal(expired.ip,null); assert.equal(expired.draw_ip,null); assert.equal(expired.subnet,'203.0.113.0/24');
  assert.equal(f.db.prepare('SELECT draw_ip FROM matches WHERE id=?').get(expired.match_id).draw_ip,null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM arena_choice_evidence WHERE ip IS NOT NULL').get().n,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,4);
}));
