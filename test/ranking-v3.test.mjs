import test from 'node:test';
import assert from 'node:assert/strict';
import { widen, eligibility, rankRanges, composite, rankEntries, groupV3 } from '../server/ranking.mjs';
import { limits } from '../server/config.mjs';
import { WARM_BOARDS } from '../server/leaderboard-warmup.mjs';

test('widen combines independent vote and task noise', () => {
  assert.equal(widen(30, 4, 85), Math.hypot(30, 1.96 * 85 / 2));
  assert.equal(widen(30, 0, 85), widen(30, 1, 85));
});
test('eligibility reports every failed condition and exempts single-task coverage', () => {
  assert.deepEqual(eligibility({ tasks: 2, taskShare: .9, effectiveVoters: 3 }, limits.board), ['tasks','task-share','voters']);
  assert.deepEqual(eligibility({ tasks: 3, taskShare: .5, effectiveVoters: 10 }, limits.board), []);
  assert.deepEqual(eligibility({ tasks: 1, taskShare: 1, effectiveVoters: 10 }, { ...limits.board, minimumTasks: 0 }), []);
});
test('rank ranges reproduce by seed, separate distant scores and overlap equal scores', () => {
  const rule = { draws: 2000, level: .95, seed: 42 };
  const equal = [{ score: 1000, interval: 20 }, { score: 1000, interval: 20 }];
  assert.deepEqual(rankRanges(equal, rule), [[1,2],[1,2]]);
  assert.deepEqual(rankRanges(equal, rule), rankRanges(equal, rule));
  assert.deepEqual(rankRanges([{ score: 2000, interval: 20 }, equal[0]], rule), [[1,1],[2,2]]);
  assert.deepEqual(rankRanges([], rule), []);
});
test('composite aligns category centres and keeps incomplete entries in partial', () => {
  const boards = { a: [{key:'x',score:1200,interval:30,rank:1},{key:'y',score:1000,interval:30,rank:2},{key:'z',score:900,interval:30,rank:3}],
    b: [{key:'x',score:1000,interval:30,rank:2},{key:'y',score:1100,interval:30,rank:1}] };
  const result = composite(boards, {a:1,b:1});
  assert.deepEqual(result.partial[0].missing, ['b']);
  assert.deepEqual(result.rows.map(r => r.score), [1025,975]);
  const shifted = composite({ ...boards, b: boards.b.map(r => ({...r,score:r.score+500})) }, {a:1,b:1});
  assert.deepEqual(shifted.rows, result.rows);
  assert.deepEqual(composite({}, {a:1,b:1}), {rows:[],partial:[]});
});
test('weighted coverage counts effective tasks and voters after diminishing', () => {
  const votes = Array.from({length:40},(_,i)=>({a:{key:'a',taskId:i<30?'one':'two'},b:{key:'b'},choice:'a',userId:i<30?'u':'v'+i,publicWeight:1}));
  const [row] = rankEntries(votes,w=>w.key,{provisionalGames:30,scoring:3,voterModelKey:w=>w.key});
  const big = 30*Math.sqrt(20/30), total=big+10;
  assert.ok(Math.abs(row.taskShare-big/total)<1e-12);
  assert.ok(Math.abs(row.effectiveTasks-total**2/(big**2+100))<1e-12);
  assert.ok(Math.abs(row.effectiveVoters-total**2/(big**2+10))<1e-12);
  assert.equal(row.intervalVotes,row.interval);
});
test('v3 groups enforce visibility, single-task noise and no false ranks in watch', () => {
  const row = {key:'a',games:21,tasks:1,taskShare:1,effectiveVoters:10,effectiveTasks:1,score:1000,intervalVotes:30};
  const options={rule:limits.board,seed:1};
  assert.equal(groupV3([row],{...options,singleTask:true}).rows[0].interval,30);
  assert.deepEqual(groupV3([row],options).watch[0].reasons,['tasks','task-share']);
  assert.equal(groupV3([{...row,games:20}],options).watch.length,0);
  assert.ok(!('rank' in groupV3([row],options).watch[0]));
  assert.equal(WARM_BOARDS.filter(r=>r.scoring===3).length,2);
});

test('weighted rankEntries preserves exact voter and task-share eligibility boundaries', () => {
  for (const baseWeight of [0.5,1,1.25]) {
    const votes=Array.from({length:210},(_,i)=>({
      a:{key:'a',taskId:'one'},b:{key:'b',taskId:'one'},choice:'a',
      userId:`u${Math.floor(i/21)}`,publicWeight:baseWeight,
    }));
    const ranked=rankEntries(votes,w=>w.key,{provisionalGames:30,scoring:3,voterModelKey:w=>w.key});
    const grouped=groupV3(ranked,{rule:limits.board,seed:1,singleTask:true});
    assert.equal(grouped.rows.length,2);
    assert.equal(grouped.watch.length,0);
    assert.equal(grouped.rows[0].effectiveVoters,ranked[0].effectiveVoters,'retain raw floating output');
    // Exactly half the weighted comparisons on one task; the rest split equally.
    for (let i=0;i<votes.length;i++) {
      votes[i].a.taskId=i<105?'one':i<158?'two':'three';
    }
    const category=rankEntries(votes,w=>w.key,{provisionalGames:30,scoring:3,voterModelKey:w=>w.key});
    assert.ok(Math.abs(category[0].taskShare-.5)<1e-12);
    assert.equal(groupV3(category,{rule:limits.board,seed:1}).rows.length,2);
  }
  assert.deepEqual(eligibility({tasks:3,taskShare:.5+Number.EPSILON,effectiveVoters:10-Number.EPSILON*10},limits.board),[]);
  assert.deepEqual(eligibility({tasks:3,taskShare:.50000001,effectiveVoters:9.99},limits.board),['task-share','voters']);
});
