import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {openDatabase,MIGRATIONS} from '../server/db.mjs';
import {importUsage} from '../scripts/usage-import.mjs';

// Same format and 15 IDs as the requested import, with synthetic measurements only.
const ids = ["up-1zy7w4he", "up-33r0q17o", "up-42sjfikq", "up-47mv7gey", "up-8mg9mglv", "up-9fn4mkwp", "up-cto2ie8m", "up-oxtdzr2t", "up-p8pi7hp7", "up-pdqywj94", "up-qwb2ucvx", "up-r72jrksf", "up-sruci5vu", "up-z6e64yog", "up-zyu7ww7g"];

test('v57 is additive/idempotent and usage import dry-runs, validates, deduplicates and requires replace', () => {
  const root=mkdtempSync(join(tmpdir(),'usage-import-')), file=join(root,'platform.db');
  const db=openDatabase(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,MIGRATIONS.length);
    MIGRATIONS[56](db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_prices').get().n,0);
    const insert=db.prepare(`INSERT INTO works (id,task_id,title,model_other,content_key,source_name,root,entry,file_count,bytes,digest,checks,trial,created_at,updated_at)
      VALUES (?,'task','Synthetic fixture','Test model',?,'index.html','','index.html',1,10,?,'[]','{}',1,1)`);
    ids.forEach(id=>insert.run(id,`key-${id}`,`digest-${id}`));
    const data={works:ids.map((uploadId,i)=>({uploadId,usage:{input:i+1,cacheRead:i,output:2,reasoning:1,requests:1,durationSec:0.5,source:'log'}}))};
    const first=importUsage({db,data});
    assert.equal(first.apply,false);assert.equal(first.results.filter(row=>row.status==='insert').length,15);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_usage').get().n,0);
    const input=join(root,'usage.json');writeFileSync(input,JSON.stringify(data));
    const dry=spawnSync(process.execPath,['scripts/usage-import.mjs','--db',file,'--input',input],{encoding:'utf8'});
    assert.equal(dry.status,0,dry.stderr);assert.match(dry.stdout,/dry-run/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_usage').get().n,0);
    db.exec(`CREATE TEMP TRIGGER fail_second_usage BEFORE INSERT ON work_usage WHEN NEW.work_id='${ids[1]}' BEGIN SELECT RAISE(ABORT,'synthetic second insert failure'); END`);
    assert.throws(()=>importUsage({db,data,apply:true}),/synthetic second insert failure/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_usage').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='usage-save'").get().n,0);
    db.exec('DROP TRIGGER fail_second_usage');
    db.exec(`CREATE TEMP TRIGGER fail_usage_audit BEFORE INSERT ON audit WHEN NEW.action='usage-save' AND NEW.work_id='${ids[1]}' BEGIN SELECT RAISE(ABORT,'synthetic second audit failure'); END`);
    assert.throws(()=>importUsage({db,data,apply:true}),/synthetic second audit failure/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_usage').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='usage-save'").get().n,0);
    db.exec('DROP TRIGGER fail_usage_audit');
    const applied=spawnSync(process.execPath,['scripts/usage-import.mjs','--db',file,'--input',input,'--apply'],{encoding:'utf8'});
    assert.equal(applied.status,0,applied.stderr);assert.match(applied.stdout,/\"written\":true/);assert.match(applied.stdout,/导入后公开目录与榜单缓存会在下次请求时刷新/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_usage').get().n,15);
    assert.equal(db.prepare('SELECT created_name FROM work_usage LIMIT 1').get().created_name,'系统导入');
    assert.equal(db.prepare('SELECT cache_write FROM work_usage LIMIT 1').get().cache_write,null);
    const stamp=db.prepare('SELECT updated_at FROM work_usage ORDER BY work_id').all();
    assert.ok(importUsage({db,data,apply:true}).results.every(row=>row.status==='unchanged'));
    assert.deepEqual(db.prepare('SELECT updated_at FROM work_usage ORDER BY work_id').all(),stamp);
    data.works[0].usage.input=999;
    assert.equal(importUsage({db,data,apply:true}).results[0].status,'conflict');
    assert.notEqual(db.prepare('SELECT input FROM work_usage WHERE work_id=?').get(ids[0]).input,999);
    assert.equal(importUsage({db,data,apply:true,replace:true}).results[0].status,'replace');
    assert.equal(db.prepare('SELECT input FROM work_usage WHERE work_id=?').get(ids[0]).input,999);
    const invalid={works:[{uploadId:'missing',usage:{input:1,source:'api'}},{...data.works[0],usage:{input:-1,source:'api'}}]};
    const rejected=importUsage({db,data:invalid,apply:true});assert.equal(rejected.blocked,true);assert.ok(rejected.results.every(row=>row.status==='invalid'));
    assert.throws(()=>importUsage({db,data,adminId:'missing'}),/管理员/);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('artifact backfill JSON persists package and upload measurements idempotently without scanning sources', async () => {
  const {importArtifacts}=await import('../scripts/artifact-import.mjs');
  const db=openDatabase(':memory:');
  try {
    const artifact={files:1,lines:2,bytes:8,tokens:3,tokenizer:'utf8-pretoken-4-v1',approximate:true};
    // A pure measurement stub supplies the same shape as artifactStats; no estimator is duplicated here.
    const catalog={work:(task,id)=>task==='task'&&['pack','upload-stub'].includes(id)?{id}:null};
    const data={artifacts:[{taskId:'task',id:'pack',origin:'pack',artifact},{taskId:'task',id:'upload-stub',origin:'upload',artifact:{files:1,lines:1,bytes:6,chars:2}}]};
    assert.equal(importArtifacts({db,data,catalog}).blocked,false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_artifacts').get().n,0);
    assert.equal(importArtifacts({db,data,catalog,apply:true}).blocked,false);
    assert.ok(importArtifacts({db,data,catalog,apply:true}).results.every(row=>row.status==='unchanged'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_artifacts').get().n,2);
    const invalid={artifacts:[{...data.artifacts[0],artifact:{...artifact,tokens:-1}}]};
    assert.equal(importArtifacts({db,data:invalid,catalog,apply:true}).blocked,true);
    assert.equal(JSON.parse(db.prepare("SELECT artifact FROM work_artifacts WHERE work_id='pack'").get().artifact).tokens,3);
  }finally{db.close();}
});


test('artifact validation accepts only the declared code and text shapes', async () => {
  const {validateArtifact}=await import('../server/work-usage.mjs');
  const code={files:0,lines:0,bytes:0,tokens:0,tokenizer:'utf8-pretoken-4-v1',approximate:true};
  const text={files:0,lines:0,bytes:0,chars:0};
  assert.deepEqual(validateArtifact(code),code);assert.deepEqual(validateArtifact(text),text);
  for(const artifact of [{files:1,lines:1,bytes:1,tokens:100},{...code,chars:0},{...code,approximate:false},
    {...code,tokenizer:''},{...code,tokenizer:'unknown'},{files:1,lines:1,bytes:1},{...text,tokens:0},{...text,approximate:true}]) {
    assert.throws(()=>validateArtifact(artifact),/Invalid artifact/);
  }
});
