import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { openDatabase } from '../server/db.mjs';
import { createRouter, fail } from '../server/http.mjs';
import { registerShow1Guess } from '../server/show1/guess.mjs';
import { catalogRevision, GUESS_MODELS, modelById, judge, sameClues } from '../server/show1/guess-logic.mjs';

test('equivalent answers win, unknown is not a wildcard and prices distinguish GPT-5.5 Pro', () => {
  assert.equal(judge(modelById.get('gpt-5-6-sol'), modelById.get('gpt-5-6-terra')).won, true);
  assert.equal(judge(modelById.get('gpt-5-5'), modelById.get('gpt-5-5-pro')).won, false);
  const a = GUESS_MODELS[0];
  assert.equal(sameClues(a, { ...a, contextK:null }), false);
  assert.equal(sameClues({ ...a, contextK:null }, { ...a, contextK:null }), true);
});

test('daily API rejects stale catalogue and stale dates without submitting a guess', async () => {
  const db = openDatabase(':memory:');
  const router = createRouter();
  registerShow1Guess(router, { db, limit:{} });
  const call = body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = {'content-type':'application/json'};
    return router.match('POST','/api/guess/check').handler({req,ip:'127.0.0.1',user:null});
  };
  try {
    await assert.rejects(call({guessId:'glm-5',catalogVersion:'old'}), e => e.status===409 && e.code==='catalog-changed');
    await assert.rejects(call({guessId:'glm-5',catalogVersion:catalogRevision(),dayKey:'2026-01-01'}), e => e.status===409 && e.code==='daily-changed');
    assert.ok((await call({guessId:'glm-5',catalogVersion:catalogRevision()})).feedback);
  } finally { db.close(); }
});

test('shared admin endpoints authenticate, validate atomically, persist and reload appended models', async t => {
  const dataDir = mkdtempSync(join(tmpdir(),'aob-guess-catalog-'));
  const db = openDatabase(':memory:');
  const config = { dataDir, siteOrigins:['https://game.arenaofbias.icu'] };
  const adminOnly = ctx => {
    if (!ctx.user) fail(401,'Login required');
    if (ctx.user.role !== 'admin') fail(403,'Admin required');
    return ctx.user;
  };
  const admin = {id:'catalog-admin',role:'admin'};
  const router = createRouter();
  registerShow1Guess(router, { db, config, adminOnly, limit:{} });
  const call = (method,path,body={},user=admin,origin='https://game.arenaofbias.icu') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.socket = { encrypted:false };
    req.headers = {'content-type':'application/json',origin};
    return router.match(method,path).handler({req,ip:'127.0.0.1',user});
  };
  const id = 'audit-test-model-20261016';
  t.after(() => {
    db.close();
    const index = GUESS_MODELS.findIndex(m => m.id===id);
    if(index>=0) GUESS_MODELS.splice(index,1);
    modelById.delete(id);
    rmSync(dataDir,{recursive:true,force:true});
  });
  assert.throws(()=>call('GET','/api/admin/guess/models',{},null),e=>e.status===401);
  assert.throws(()=>call('GET','/api/admin/guess/stats',{}, {id:'member',role:'user'}),e=>e.status===403);
  const entry = {id,name:'Audit test model',org:'OpenAI',year:2026,month:10,openWeights:false,contextK:1000,
    modalities:['text'],reasoning:true,priceOut:3,popularity:10,difficulty:2,dailyEligible:true};
  await assert.rejects(call('POST','/api/admin/guess/models',entry,admin,'https://evil.invalid'),e=>e.status===403);
  for(const bad of [{priceOut:-1},{openWeights:'false'},{modalities:['image']},{region:'CN',org:'__proto__'},{id:'../escape'},{sinceDay:0},{dailyEligible:'true'},{difficulty:3},{contextK:null},{priceOut:null}])
    await assert.rejects(call('POST','/api/admin/guess/models',{...entry,...bad}),e=>e.status===400);
  const before = GUESS_MODELS.length;
  await call('POST','/api/admin/guess/models',entry);
  assert.equal(GUESS_MODELS.length,before+1);
  const disk = readFileSync(join(dataDir,'guess-models-extra.json'),'utf8');
  assert.equal(JSON.parse(disk).models[0].id,id);
  await assert.rejects(call('POST','/api/admin/guess/models',entry),e=>e.status===400);
  assert.equal(readFileSync(join(dataDir,'guess-models-extra.json'),'utf8'),disk);
  // A fresh service reloads the persisted entry after the in-memory catalogue is cleared.
  GUESS_MODELS.splice(GUESS_MODELS.findIndex(m=>m.id===id),1);modelById.delete(id);
  registerShow1Guess(createRouter(), {db,config,adminOnly,limit:{}});
  assert.equal(modelById.get(id).name,entry.name);
  assert.equal(modelById.get(id).dailyEligible,true);
  assert.equal(call('GET','/api/admin/guess/models').extraCount,1);
  assert.equal(call('GET','/api/admin/guess/stats').totals.played,0);
});
