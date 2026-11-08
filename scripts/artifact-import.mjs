// Persist the read-only artifact-backfill tool's JSON. No source files or data packages are changed.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,transaction} from '../server/db.mjs';
import {createCatalog} from '../server/catalog.mjs';
import {putArtifact,validateArtifact} from '../server/work-usage.mjs';

export function importArtifacts({db,data,catalog=null,apply=false}) {
  if(!Array.isArray(data?.artifacts))throw new Error('输入必须含 artifacts 数组');
  const exists=db.prepare('SELECT 1 FROM works WHERE task_id=? AND id=? AND deleted_at IS NULL');
  const stored=db.prepare('SELECT artifact FROM work_artifacts WHERE task_id=? AND work_id=?');
  const canonical=object=>JSON.stringify(Object.entries(object).sort(([a],[b])=>a.localeCompare(b)));
  const seen=new Set();
  const results=data.artifacts.map(row=>{
    try {
      if(!row.taskId||!row.id)throw new Error('缺少题目或作品ID');
      const key=JSON.stringify([row.taskId,row.id]);if(seen.has(key))throw new Error('作品重复');seen.add(key);
      if(!exists.get(row.taskId,row.id)&&!catalog?.work(row.taskId,row.id))throw new Error('作品不存在（数据包作品需 --dist）');
      validateArtifact(row.artifact);
      const previous=stored.get(row.taskId,row.id);
      return {...row,status:previous&&canonical(JSON.parse(previous.artifact))===canonical(row.artifact)?'unchanged':previous?'update':'insert'};
    }catch(error){return {taskId:row?.taskId,id:row?.id,status:'invalid',error:error.message};}
  });
  const blocked=results.some(row=>row.status==='invalid');
  if(apply&&!blocked)transaction(db,()=>{for(const row of results)if(row.status!=='unchanged')putArtifact(db,{task:row.taskId,work:row.id,artifact:row.artifact});});
  return {apply,blocked,results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2), options={apply:false};
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--apply')options.apply=true;
      else if(args[i]==='--dry-run')options.apply=false;
      else if(['--db','--input','--dist'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--'))options[args[i].slice(2)]=args[++i];
      else throw new Error('用法：node scripts/artifact-import.mjs --db <platform.db> --input <artifact.json> [--dist <datapack>] [--dry-run|--apply]');
    }
    if(!options.db||!options.input)throw new Error('必须显式指定 --db 和 --input，默认只读预演');
    const data=JSON.parse(readFileSync(resolve(options.input),'utf8'));
    const db=options.apply?openDatabase(resolve(options.db)):new DatabaseSync(resolve(options.db),{readOnly:true});
    try {
      const report=importArtifacts({db,data,apply:options.apply,catalog:options.dist?createCatalog(resolve(options.dist)):null});
      for(const row of report.results)console.log(JSON.stringify({...row,mode:options.apply?'apply':'dry-run',written:options.apply&&!report.blocked&&row.status!=='unchanged'}));
      if(report.blocked)process.exitCode=1;
    }finally{db.close();}
  }catch(error){console.error(error.message);process.exitCode=1;}
}
