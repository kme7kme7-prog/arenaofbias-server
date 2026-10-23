import { isIP } from 'node:net';
import { transaction } from './db.mjs';
import { fail } from './http.mjs';
import { isSenior } from './roles.mjs';
import { modelKey } from './catalog.mjs';
import { seesRestricted } from './restricted.mjs';

export const IP_RETENTION_MS = 180 * 86400e3;
export function normalizeIp(value) {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const ip = new URL(`http://[${value}]/`).hostname.slice(1,-1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(ip);
  if (mapped) return mapped.slice(1).flatMap(x => { const n = parseInt(x,16); return [n >> 8,n & 255]; }).join('.');
  return ip;
}
export function subnetOf(value) {
  const ip = normalizeIp(value);
  if (!ip) return null;
  if (isIP(ip) === 4) return `${ip.split('.').slice(0,3).join('.')}.0/24`;
  const [left,right = ''] = ip.split('::'), a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const parts = ip.includes('::') ? [...a,...Array(8-a.length-b.length).fill('0'),...b] : a;
  return `${new URL(`http://[${parts.slice(0,4).join(':')}::]/`).hostname.slice(1,-1)}/64`;
}
const iso = at => at == null ? null : new Date(at).toISOString();
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const model = value => {
  const w = typeof value === 'string' ? parse(value) : value;
  return w && typeof w==='object' ? { key: w.modelKey ?? modelKey(w), name: w.modelName ?? w.modelId ?? w.model ?? '' } : null;
};
const actorKey = row => row.user_id ? `u:${row.user_id}` : `g:${row.visitor_hash}`;
const staff = actor => { if (!isSenior(actor)) fail(403,'仅高级管理员可以查看投票风控'); };

export function createVoteRisk({ db, invalidate, restricted = null }) {
  const recordingStartedAt = () => iso(db.prepare('SELECT recording_started_at FROM vote_risk_settings WHERE id=1').get().recording_started_at);
  function options(query) {
    const now = Date.now(), from = query.get('from') == null ? now-7*86400e3 : Date.parse(query.get('from'));
    const to = query.get('to') == null ? now : Date.parse(query.get('to'));
    const number = (name,fallback,min,max) => {
      const raw = query.get(name); if (raw == null) return fallback;
      const n = Number(raw); if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n<min || n>max) fail(400,'查询参数无效','invalid_query');
      return n;
    };
    if (!Number.isFinite(from) || !Number.isFinite(to) || from>=to) fail(400,'时间范围无效','invalid_query');
    const ip = query.has('ip') ? normalizeIp(query.get('ip')) : null;
    if (query.has('ip') && !ip) fail(400,'IP无效','invalid_query');
    let subnet = null;
    if (query.has('subnet')) {
      const [address,prefix,...rest] = query.get('subnet').split('/');
      subnet = subnetOf(address);
      if (!subnet || rest.length || subnet.split('/')[1] !== prefix) fail(400,'网段无效','invalid_query');
    }
    const voided = query.get('voided') ?? 'all', outcome = query.get('outcome') ?? 'all';
    if (!['all','yes','no'].includes(voided) || !['all','accepted','rejected'].includes(outcome)) fail(400,'筛选无效','invalid_query');
    return { from,to,ip,subnet,voided,outcome,limit:number('limit',50,1,200),offset:number('offset',0,0,Number.MAX_SAFE_INTEGER),
      minVotes:number('minVotes',5,1,Number.MAX_SAFE_INTEGER), userId:query.get('userId'),visitorHash:query.get('visitorHash'),modelKey:query.get('modelKey') };
  }
  function load(o, acceptedOnly = false, actor = null) {
    // Automation acting as a senior account never sees evidence about restricted models.
    const hidden = row => restricted && !seesRestricted(actor) && [row.aModel, row.bModel].some(m => m && restricted.hasKey(m.key));
    const where = ['e.submitted_at>=?','e.submitted_at<?'], args = [o.from,o.to];
    for (const [field,value] of [['ip',o.ip],['subnet',o.subnet],['user_id',o.userId],['visitor_hash',o.visitorHash]]) {
      if (value != null) { where.push(`e.${field}=?`); args.push(value); }
    }
    if (o.voided !== 'all') where.push(`v.voided_at IS ${o.voided==='yes'?'NOT ':''}NULL`);
    if (acceptedOnly || o.outcome !== 'all') { where.push('e.outcome=?'); args.push(acceptedOnly?'accepted':o.outcome); }
    return db.prepare(`SELECT e.*,u.name AS username,v.voided_at,v.voided_by,v.void_reason,v.a_identity,v.b_identity,v.a_correction,v.b_correction
      FROM arena_choice_evidence e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN votes v ON v.id=e.vote_id
      WHERE ${where.join(' AND ')} ORDER BY e.submitted_at DESC,e.id DESC`).all(...args).map(row => {
        row.aModel = model(row.a_correction ?? row.a_identity) ?? parse(row.a_model);
        row.bModel = model(row.b_correction ?? row.b_identity) ?? parse(row.b_model);
        row.winnerModel = row.choice==='a'?row.aModel:row.choice==='b'?row.bModel:null;
        return row;
      }).filter(row => !hidden(row) && (!o.modelKey || [row.aModel?.key,row.bModel?.key].includes(o.modelKey)));
  }
  const page = (rows,o,extra={}) => ({from:iso(o.from),to:iso(o.to),recordingStartedAt:recordingStartedAt(),...extra,
    total:rows.length,rows:rows.slice(o.offset,o.offset+o.limit)});
  function grouped(rows,groupBy,o) {
    // Sharing uses the whole time window, not just the currently filtered actor/model.
    const shared = new Map();
    for (const r of db.prepare(`SELECT DISTINCT ip,user_id FROM arena_choice_evidence WHERE submitted_at>=? AND submitted_at<?
      AND outcome='accepted' AND ip IS NOT NULL AND user_id IS NOT NULL`).all(o.from,o.to)) {
      if (!shared.has(r.ip)) shared.set(r.ip,new Set()); shared.get(r.ip).add(r.user_id);
    }
    const groups = new Map();
    for (const row of rows) {
      const key = groupBy==='ip'?row.ip:groupBy==='subnet'?row.subnet:actorKey(row);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(row);
    }
    return [...groups].map(([key,list]) => {
      const first = list[0], votes = list.filter(r=>r.vote_id), timed = list.filter(r=>r.choice!=='skip' && r.ready_elapsed_ms!=null);
      const fast = timed.filter(r=>r.ready_elapsed_ms<=10000), hourly = new Map(), winners = new Map(), otherAccounts = new Set();
      for (const r of votes) { const h = Math.floor(r.submitted_at/3600e3); hourly.set(h,(hourly.get(h)??0)+1); }
      const decisiveVotes = votes.filter(r=>r.winnerModel && r.aModel?.key!==r.bModel?.key);
      for (const r of decisiveVotes) {
        const m = r.winnerModel;
        if (!winners.has(m.key)) winners.set(m.key,{model:m,count:0}); winners.get(m.key).count++;
      }
      for (const r of list) for (const userId of shared.get(r.ip)??[]) if (userId!==first.user_id) otherAccounts.add(userId);
      const top = [...winners.values()].sort((a,b)=>b.count-a.count)[0], decisive = decisiveVotes.length;
      const actors = new Set(list.map(actorKey)), accounts = new Set(list.filter(r=>r.user_id).map(r=>r.user_id));
      return {key,...(groupBy==='actor'?{actorKey:key,userId:first.user_id,username:first.username??null,visitorHash:first.visitor_hash}: {[groupBy]:key}),
        choiceCount:list.length,voteCount:votes.length,validVoteCount:votes.filter(r=>r.voided_at==null).length,
        voidedVoteCount:votes.filter(r=>r.voided_at!=null).length,actorCount:actors.size,accountCount:accounts.size,visitorCount:actors.size-accounts.size,
        timedChoices:timed.length,fastChoices:fast.length,fastChoiceShare:timed.length?fast.length/timed.length:null,
        peakHourlyVotes:Math.max(0,...hourly.values()),sharedIpOtherAccounts:groupBy==='actor'?otherAccounts.size:null,
        topWinnerModel:top?.model??null,topWinnerVotes:top?.count??0,decisiveVotes:decisive,topWinnerShare:decisive?(top?.count??0)/decisive:null};
    }).sort((a,b)=>b.voteCount-a.voteCount || a.key.localeCompare(b.key));
  }
  function changeVotes(actor,body,restore) {
    staff(actor);
    if (!Array.isArray(body.voteIds) || !body.voteIds.length || body.voteIds.length>200 || new Set(body.voteIds).size!==body.voteIds.length ||
      body.voteIds.some(id=>typeof id!=='string') || typeof body.reason!=='string' || !body.reason.trim() || body.reason.trim().length>500) fail(400,'请选择1至200张票并填写理由');
    const changed = transaction(db,()=>{
      const votes = body.voteIds.map(id=>db.prepare("SELECT * FROM votes WHERE id=? AND source='arena'").get(id));
      if (votes.some(v=>!v)) fail(404,'投票不存在或不是盲评票');
      let count=0;
      for (const v of votes) {
        if (restore ? v.voided_at==null : v.voided_at!=null) continue;
        db.prepare('UPDATE votes SET voided_at=?,voided_by=?,void_reason=? WHERE id=?')
          .run(restore?null:Date.now(),restore?null:actor.id,restore?null:body.reason.trim(),v.id); count++;
      }
      if (count) {
        db.prepare('UPDATE vote_risk_settings SET revision=revision+1 WHERE id=1').run();
        db.prepare('INSERT INTO audit(at,actor_id,actor_name,action,detail) VALUES (?,?,?,?,?)')
          .run(Date.now(),actor.id,actor.name,restore?'vote-restore':'vote-void',JSON.stringify({voteIds:body.voteIds,reason:body.reason.trim(),changed:count}));
      }
      return count;
    });
    if (changed) invalidate();
    return {ok:true,changed};
  }
  return {
    capture(actor,matchId,choice,ctx) {
      if (!['a','b','tie','skip'].includes(choice)) return null;
      const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
      if (!match || (match.user_id ? match.user_id!==actor.user?.id : actor.user || !actor.visitorHash || match.visitor_hash!==actor.visitorHash)) return null;
      return {match,actor,choice,at:ctx.receivedAt,ip:normalizeIp(ctx.ip),ua:String(ctx.req.headers['user-agent']??'').slice(0,512)};
    },
    record(evidence,{accepted=false,errorCode=null,verified=false,lastVerifiedAt=null}={}) {
      if (!evidence) return;
      const {match,actor,choice,at,ip,ua}=evidence;
      const vote = db.prepare('SELECT id FROM votes WHERE match_id=?').get(match.id);
      db.prepare(`INSERT INTO arena_choice_evidence(match_id,vote_id,submitted_at,draw_created_at,user_id,visitor_hash,task_id,choice,
        ip,subnet,draw_ip,draw_subnet,user_agent,ready_elapsed_ms,turnstile_passed,last_verified_at,outcome,error_code,a_model,b_model)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(match.id,vote?.id??null,at,match.created_at,actor.user?.id??null,actor.visitorHash,
          match.task_id,choice,ip,subnetOf(ip),match.draw_ip,match.draw_subnet,ua,
          match.ready_at==null?null:Math.max(0,(match.choice_received_at??at)-match.ready_at),Number(verified),lastVerifiedAt,
          accepted?'accepted':'rejected',errorCode,JSON.stringify(model(match.a_identity)),JSON.stringify(model(match.b_identity)));
    },
    cleanup(now=Date.now()) {
      const cutoff=now-IP_RETENTION_MS;
      db.prepare('UPDATE arena_choice_evidence SET ip=NULL WHERE submitted_at<=? AND ip IS NOT NULL').run(cutoff);
      db.prepare('UPDATE arena_choice_evidence SET draw_ip=NULL WHERE draw_created_at<=? AND draw_ip IS NOT NULL').run(cutoff);
      db.prepare('UPDATE matches SET draw_ip=NULL WHERE created_at<=? AND draw_ip IS NOT NULL').run(cutoff);
    },
    summary(actor,query) {
      staff(actor); const o=options(query),groupBy=query.get('groupBy')??'actor';
      if (!['actor','ip','subnet'].includes(groupBy)) fail(400,'分组无效','invalid_query');
      return page(grouped(load(o,true,actor),groupBy,o),o,{groupBy});
    },
    choices(actor,query) {
      staff(actor); const o=options(query);
      return page(load(o,false,actor).map(r=>({id:r.id,matchId:r.match_id,voteId:r.vote_id,submittedAt:iso(r.submitted_at),userId:r.user_id,
        username:r.username??null,visitorHash:r.visitor_hash,actorKey:actorKey(r),taskId:r.task_id,choice:r.choice,
        ip:r.ip,subnet:r.subnet,drawIp:r.draw_ip,drawSubnet:r.draw_subnet,userAgent:r.user_agent,readyElapsedMs:r.ready_elapsed_ms,
        turnstilePassed:Boolean(r.turnstile_passed),lastVerifiedAt:iso(r.last_verified_at),outcome:r.outcome,errorCode:r.error_code,
        winnerModel:r.winnerModel,aModel:r.aModel,bModel:r.bModel,voidedAt:iso(r.voided_at),voidedBy:r.voided_by??null,voidReason:r.void_reason??null})),o);
    },
    modelVoters(actor,query) {
      staff(actor); const o=options(query);
      if (!o.modelKey) fail(400,'请选择模型','invalid_query');
      const source=load(o,true,actor).filter(r=>r.vote_id && r.aModel?.key!==r.bModel?.key);
      const byActor=new Map();
      for (const r of source) { const key=actorKey(r); if (!byActor.has(key)) byActor.set(key,[]); byActor.get(key).push(r); }
      const rows=grouped(source,'actor',o).map(row=>{
        const votes=byActor.get(row.key),ties=votes.filter(r=>r.choice==='tie').length;
        const wins=votes.filter(r=>r.winnerModel?.key===o.modelKey).length,losses=votes.length-wins-ties;
        return {...row,modelComparisons:votes.length,wins,losses,ties,winShare:wins+losses?wins/(wins+losses):null};
      }).filter(r=>r.modelComparisons>=o.minVotes).sort((a,b)=>(b.winShare??-1)-(a.winShare??-1)||b.modelComparisons-a.modelComparisons);
      return page(rows,o,{modelKey:o.modelKey});
    },
    voidVotes:(actor,body)=>changeVotes(actor,body,false),
    restoreVotes:(actor,body)=>changeVotes(actor,body,true),
  };
}
