import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { createRecaptures, recaptureOptions } from '../server/recapture.mjs';
import { HttpError } from '../server/http.mjs';
import { createServer } from 'node:http';

// Header fixture only: lifecycle tests do not claim a browser encoded these bytes.
const jpeg = (width, height) => Buffer.from([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0,255,217]);
const owner = { tokenId: 'token', actorId: 'actor', bindingRevision: 'revision' };
const wait = async check => { for (let n=0;n<200;n++) { const value=check(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('job did not settle'); };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recapture-')), dir = join(root, 'work'), output = join(root, 'private'); mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Never executed</h1>');
  const db = openDatabase(join(root, 'state.db'));
  let work = { taskId: 'task', id: 'work', dir, entry: 'index.html', updatedAt: 1 }, allowed = true, time = 100000;
  const calls = [];
  const library = { work: (task,id) => task === 'task' && id === 'work' ? work : null, uploadById: id => id === 'work' ? work : null };
  const capturer = { async enqueue(value, settings) {
    calls.push(settings);
    if (options.enqueue) return options.enqueue(value, settings);
    await settings.beforeCapture();
    for (const shot of settings.shots) writeFileSync(join(settings.outputDir, `${shot.id}.jpg`), jpeg(shot.viewport.width, shot.viewport.height));
    return { captures: { first: 'first.jpg', mobile: 'mobile.jpg' } };
  } };
  const args = { db, library, capturer, rootDir: output, now: () => time, authorizeJob: value => {
    if (!allowed || value.bindingRevision !== owner.bindingRevision) throw new HttpError(403,'revoked','scope_required');
  }, ...options.service };
  let service = createRecaptures(args);
  const f = { db, dir, output, calls, args, get service(){return service;}, body: async () => ({ task:'task',id:'work',version:(await service.source('task','work')).version }),
    allow: value=>{allowed=value;}, time: value=>{time=value;}, work: value=>{work=value;}, recreate: async()=>{await service.close(); service=createRecaptures(args);} };
  t.after(async()=>{await service.close();db.close();rmSync(root,{recursive:true,force:true});});
  return f;
}

test('private recapture honors dimensions, returns both JPEGs and never changes original source', async t=>{
  const f=fixture(t), original=readFileSync(join(f.dir,'index.html'));
  const info=await f.service.source('task','work'); assert.match(info.version,/^[a-f0-9]{64}$/); assert.equal(info.defaults.desktop.width,1440);
  const body={...await f.body(),desktop:{width:800,height:600},mobile:{width:360,height:640},wait:{load:'domcontentloaded',settleMs:50}};
  const job=await f.service.request(owner,body); assert.equal(job.state,'queued');
  const same=await f.service.request(owner,body); assert.equal(same.jobId,job.jobId);
  const done=await wait(()=>{const row=f.service.get(owner,job.jobId);return row.state==='succeeded'&&row;});
  assert.deepEqual(done.images.map(({slot,width,height})=>({slot,width,height})),[{slot:'first',width:800,height:600},{slot:'mobile',width:360,height:640}]);
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].publish,false); assert.equal(f.calls[0].late,false); assert.deepEqual(f.calls[0].wait,body.wait);
  assert.ok((await f.service.download(owner,job.jobId,'first')).file.startsWith(realpathSync(f.output))); assert.equal((await f.service.download(owner,job.jobId,'mobile')).type,'image/jpeg');
  assert.deepEqual(readFileSync(join(f.dir,'index.html')),original); assert.equal(existsSync(join(f.dir,'first.jpg')),false);
});

test('dimensions/wait/source inputs reject unknown fields, URLs, scripts and missing version', async t=>{
  const f=fixture(t), good=await f.body();
  for(const change of [{version:undefined},{url:'https://example.test'}, {desktop:{width:100000,height:900}}, {mobile:{width:390,height:10}},
    {wait:{load:'networkidle',settleMs:0}}, {wait:{load:'load',settleMs:10001}}, {wait:{load:'load',settleMs:0,selector:'script'}}, {id:'../../secret'}]) assert.throws(()=>recaptureOptions({...good,...change}),error=>error.status===400);
  assert.equal(f.calls.length,0);
});

test('stale version is rejected before enqueue and full source bytes participate in version', async t=>{
  const f=fixture(t), body=await f.body(); writeFileSync(join(f.dir,'asset.css'),'body{color:red}');
  assert.notEqual((await f.service.source('task','work')).version,body.version);
  await assert.rejects(()=>f.service.request(owner,body),error=>error.status===409&&error.code==='source_changed'); assert.equal(f.calls.length,0);
});

test('source and authorization are rechecked at actual shared-worker execution', async t=>{
  let release;
  const f=fixture(t,{enqueue:async(_work,settings)=>{await new Promise(resolve=>{release=resolve;}); await settings.beforeCapture();return{captures:{}};}});
  const job=await f.service.request(owner,await f.body()); await wait(()=>release);
  writeFileSync(join(f.dir,'index.html'),'Changed before worker started'); release();
  const done=await wait(()=>{const value=f.service.get(owner,job.jobId);return value.state==='failed'&&value;});
  assert.equal(done.error.code,'source_changed'); assert.deepEqual(done.images,[]);
  assert.equal(existsSync(join(f.output,job.jobId)),false);
});

test('revoked queued authority produces a safe error and owners/bindings cannot share jobs', async t=>{
  const f=fixture(t); const job=await f.service.request(owner,await f.body()); f.allow(false);
  const done=await wait(()=>{const value=f.service.get(owner,job.jobId);return value.state==='failed'&&value;});
  assert.equal(done.error.code,'scope_required'); assert.equal(f.calls.length,0);
  for(const changed of [{tokenId:'other'},{actorId:'other'},{bindingRevision:'new'}]) assert.throws(()=>f.service.get({...owner,...changed},job.jobId),error=>error.status===404);
});

test('completed output is withdrawn when source changes, and download path stays constrained', async t=>{
  const f=fixture(t), job=await f.service.request(owner,await f.body()); await wait(()=>f.service.get(owner,job.jobId).state==='succeeded');
  await assert.rejects(()=>f.service.download(owner,job.jobId,'../first'),error=>error.status===404);
  await assert.rejects(()=>f.service.download(owner,'../work','first'),error=>error.status===404);
  const file=(await f.service.download(owner,job.jobId,'first')).file; rmSync(file); symlinkSync(join(f.dir,'index.html'),file);
  await assert.rejects(()=>f.service.download(owner,job.jobId,'first'),error=>error.status===404);
  writeFileSync(join(f.dir,'index.html'),'new source');
  await assert.rejects(()=>f.service.download(owner,job.jobId,'first'),error=>error.code==='source_changed');
  const failed=f.service.get(owner,job.jobId); assert.equal(failed.state,'failed'); assert.equal(failed.error.code,'source_changed'); assert.deepEqual(failed.images,[]);
});

test('worker unavailable is distinguished from a bounded work render failure', async t=>{
  for(const [result,expected] of [[{unavailable:true,captures:{}},'environment_unavailable'],[{captures:{},error:{code:'capture_timeout',stage:'screenshot'}},'capture_timeout']]) {
    const f=fixture(t,{enqueue:async()=>result}),job=await f.service.request(owner,await f.body());
    const done=await wait(()=>{const value=f.service.get(owner,job.jobId);return value.state==='failed'&&value;}); assert.equal(done.error.code,expected);
  }
});

test('partial capture preserves only available private JPEG and reports error', async t=>{
  const f=fixture(t,{enqueue:async(_work,settings)=>{writeFileSync(join(settings.outputDir,'first.jpg'),jpeg(1440,900));return{captures:{first:'first.jpg'},error:{code:'capture_timeout',stage:'screenshot'}};}});
  const job=await f.service.request(owner,await f.body()),done=await wait(()=>{const value=f.service.get(owner,job.jobId);return value.state==='partial'&&value;});
  assert.equal(done.images.length,1); assert.equal(done.error.code,'capture_timeout'); await assert.rejects(()=>f.service.download(owner,job.jobId,'mobile'),error=>error.status===404);
});

test('work cooldown, retained capacity and expiry are bounded and restart never reruns jobs', async t=>{
  const f=fixture(t,{service:{retentionMs:1000,cooldownMs:100,maxJobs:1}}),body=await f.body(),job=await f.service.request(owner,body);
  await wait(()=>f.service.get(owner,job.jobId).state==='succeeded');
  await assert.rejects(()=>f.service.request(owner,body),error=>error.code==='recapture_cooldown'); f.time(100101);
  await assert.rejects(()=>f.service.request(owner,body),error=>error.code==='recapture_capacity');
  f.db.prepare("UPDATE recapture_jobs SET state='running' WHERE id=?").run(job.jobId); await f.recreate();
  assert.equal(f.service.get(owner,job.jobId).error.code,'service_restarted'); assert.equal(f.calls.length,1);
  f.time(101001); assert.throws(()=>f.service.get(owner,job.jobId),error=>error.status===404); assert.equal(existsSync(join(f.output,job.jobId)),false);
});

test('task deadline aborts in-flight work and prevents any late output publication', async t=>{
  const f=fixture(t,{service:{deadlineMs:20},enqueue:async(_work,settings)=>new Promise(resolve=>settings.signal.addEventListener('abort',()=>resolve({captures:{}}),{once:true}))});
  const job=await f.service.request(owner,await f.body()); const done=await wait(()=>{const value=f.service.get(owner,job.jobId);return value.state==='failed'&&value;});
  assert.equal(done.error.code,'job_timeout'); assert.equal(existsSync(join(f.output,job.jobId)),false);
});

test('large asynchronous source hashing lets unrelated HTTP requests finish first', async t=>{
  const f=fixture(t);writeFileSync(join(f.dir,'large.bin'),Buffer.alloc(32*1024*1024,7));
  let started,finished=false;const began=new Promise(resolve=>{started=resolve;});
  const server=createServer(async(req,res)=>{if(req.url==='/source'){started();const data=await f.service.source('task','work');finished=true;res.end(JSON.stringify(data));}else res.end('pong');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`,hash=fetch(base+'/source');await began;
    const ping=await fetch(base+'/ping');assert.equal(await ping.text(),'pong');assert.equal(finished,false,'32MiB source hash must yield to another HTTP request');assert.equal((await hash).status,200);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('authority revoked while asynchronous source is read never inserts a job', async t=>{
  const f=fixture(t),body=await f.body(),request=f.service.request(owner,body);f.allow(false);
  await assert.rejects(()=>request,error=>error.code==='scope_required');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM recapture_jobs').get().n,0);
});

test('source-change terminal error survives cancellation of an active worker', async t=>{
  const f=fixture(t,{enqueue:async(_work,settings)=>new Promise(resolve=>settings.signal.addEventListener('abort',()=>resolve({captures:{}}),{once:true}))});
  const job=await f.service.request(owner,await f.body());await wait(()=>f.calls.length);
  const prior=f.args.library.work('task','work');f.work({...prior,entry:'changed.html'});
  assert.equal(f.service.get(owner,job.jobId).error.code,'source_changed');await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.service.get(owner,job.jobId).error.code,'source_changed');
});

test('retained output fingerprint refuses same-size replacement before stream send', async t=>{
  const f=fixture(t),job=await f.service.request(owner,await f.body());await wait(()=>f.service.get(owner,job.jobId).state==='succeeded');
  const file=(await f.service.download(owner,job.jobId,'first')).file,bytes=readFileSync(file);bytes[bytes.length-1]^=1;writeFileSync(file,bytes);
  assert.throws(()=>f.service.verifyDownload(owner,job.jobId,'first'),error=>error.status===404);
});

test('pending-job capacity prevents another work from joining an occupied queue', async t=>{
  const f=fixture(t,{service:{maxPending:1},enqueue:async(_work,settings)=>new Promise(resolve=>settings.signal.addEventListener('abort',()=>resolve({captures:{}}),{once:true}))});
  const firstWork=f.args.library.work('task','work');
  f.args.library.work=(task,id)=>task==='task'&&['work','other'].includes(id)?{...firstWork,id}:null;
  f.args.library.uploadById=id=>['work','other'].includes(id)?{...firstWork,id}:null;
  await f.service.request(owner,await f.body());const other=await f.service.source('task','other');
  await assert.rejects(()=>f.service.request(owner,{task:'task',id:'other',version:other.version}),error=>error.code==='recapture_capacity');
});
