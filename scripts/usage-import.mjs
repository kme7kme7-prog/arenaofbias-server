// Import raw measurements only; never alters identities, content, votes, or prices.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../server/db.mjs';
import { createUsageService, validateUsage } from '../server/work-usage.mjs';
import { isStaff } from '../server/roles.mjs';

export function importUsage(options) {
  return options.apply ? transaction(options.db, () => prepareAndImport(options)) : prepareAndImport(options);
}

function prepareAndImport({ db, data, adminId = null, apply = false, replace = false }) {
  if (!data || !Array.isArray(data.works)) throw new Error('输入必须含 works 数组');
  const actor = adminId ? db.prepare('SELECT * FROM users WHERE id=?').get(adminId) : {id:null,name:'系统导入',role:'admin'};
  if (!isStaff(actor)) throw new Error('录入人必须是现有管理员');
  const lookup = db.prepare('SELECT * FROM works WHERE id=? AND deleted_at IS NULL');
  const service = createUsageService({db,catalog:null,library:{work:(task,id)=>{
    const row=lookup.get(id);return row?.task_id === task ? row : null;
  }}});
  const seen = new Set(), plan = [];
  for (const item of data.works) {
    const id = item?.uploadId;
    try {
      if (typeof id !== 'string' || !id || seen.has(id)) throw new Error('投稿ID缺失或重复');
      seen.add(id);
      const work = lookup.get(id);
      if (!work) throw new Error('作品不存在或已删除');
      if (item.task != null && item.task !== work.task_id) throw new Error('题目与现有作品不符');
      const usage = validateUsage(item.usage), existing = service.getUsage(actor,work.task_id,id).usage;
      const normalized = existing ? validateUsage(Object.fromEntries(Object.entries(existing).filter(([key])=>!['createdBy','updatedBy','createdAt','updatedAt'].includes(key)))) : null;
      const status = !normalized ? 'insert' : JSON.stringify(normalized) === JSON.stringify(usage) ? 'unchanged' : replace ? 'replace' : 'conflict';
      plan.push({id,task:work.task_id,status,usage});
    } catch(error) {plan.push({id:id??null,status:'invalid',error:error.message});}
  }
  const blocked = plan.some(row=>['invalid','conflict'].includes(row.status));
  if (apply && !blocked) for (const row of plan) if (row.status !== 'unchanged') service.saveUsage(actor,row.task,row.id,row.usage,{inTransaction:true});
  return {apply,replace,blocked,results:plan};
}

function main() {
  const args=process.argv.slice(2), options={apply:false,replace:false};
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(flag==='--apply')options.apply=true;
    else if(flag==='--dry-run')options.apply=false;
    else if(flag==='--replace')options.replace=true;
    else if(['--db','--input','--admin-id'].includes(flag) && args[i+1] && !args[i+1].startsWith('--'))options[flag.slice(2)]=args[++i];
    else throw new Error('用法：node scripts/usage-import.mjs --db <platform.db> --input <usage.json> [--dry-run|--apply] [--replace] [--admin-id <id>]');
  }
  if(!options.db || !options.input)throw new Error('必须显式指定 --db 和 --input；默认仅预演');
  const data=JSON.parse(readFileSync(resolve(options.input),'utf8'));
  const db=options.apply ? openDatabase(resolve(options.db)) : new DatabaseSync(resolve(options.db),{readOnly:true});
  try {
    const report=importUsage({db,data,adminId:options['admin-id'],apply:options.apply,replace:options.replace});
    for(const row of report.results)console.log(JSON.stringify({...row,mode:report.apply?'apply':'dry-run',written:report.apply&&!report.blocked&&['insert','replace'].includes(row.status)}));
    console.log(JSON.stringify({mode:report.apply?'apply':'dry-run',blocked:report.blocked,count:report.results.length,
      ...(report.apply&&!report.blocked&&report.results.some(row=>row.status!=='unchanged') ? {notice:'导入后公开目录与榜单缓存会在下次请求时刷新'} : {})}));
    if(report.blocked)process.exitCode=1;
  } finally {db.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {main();} catch(error) {console.error(error.message);process.exitCode=1;}
}
