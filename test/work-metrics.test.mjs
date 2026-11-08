import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from '../server/db.mjs';
import {createWorkMetrics,putArtifact} from '../server/work-usage.mjs';

test('one metrics snapshot uses exactly two bulk reads and preserves point DTO bytes/order and cost redaction', () => {
  const db=openDatabase(':memory:');
  try {
    db.prepare(`INSERT INTO work_usage (task_id,work_id,input,output,paid,source,created_at,updated_at,created_name)
      VALUES ('a','same',0,5,?,'bill',1,1,'Private recorder')`).run(JSON.stringify({basis:'api',amount:9,currency:'USD'}));
    putArtifact(db,{task:'a',work:'same',artifact:{files:1,lines:2,bytes:3,tokens:4,tokenizer:'utf8-pretoken-4-v1',approximate:true}});
    putArtifact(db,{task:'b',work:'same',artifact:{files:1,lines:1,bytes:6,chars:2}});
    for(const showCost of [false,true]) {
      const calls=[];
      const instrumented={prepare(sql){const statement=db.prepare(sql);return {
        get(...args){calls.push(['get',sql]);return statement.get(...args);},
        all(...args){calls.push(['all',sql]);return statement.all(...args);},
      };}};
      const read=createWorkMetrics(instrumented,{showCost});
      const works=[{taskId:'a',id:'same'},{taskId:'b',id:'same'},{taskId:'a',id:'missing'}];
      const expected=JSON.stringify(works.map(read));
      calls.length=0;
      const snapshot=read.snapshot();
      assert.equal(JSON.stringify(works.map(snapshot)),expected);
      for(let i=0;i<3300;i++)snapshot(works[i%works.length]);
      assert.equal(calls.length,2);assert.ok(calls.every(([method])=>method==='all'));
      assert.equal(calls.filter(([,sql])=>sql.includes('FROM work_usage')).length,1);
      assert.equal(calls.filter(([,sql])=>sql.includes('FROM work_artifacts')).length,1);
      assert.equal(expected.includes('Private recorder'),false);
      assert.equal(expected.includes('"amount"'),showCost);
      assert.deepEqual(Object.keys(snapshot(works[0])),['usage','artifact']);
      db.exec('UPDATE work_usage SET input=input+1');
      const oldValue=snapshot(works[0]).usage.input;
      const fresh=read.snapshot();
      assert.equal(fresh(works[0]).usage.input,oldValue+1);
      assert.equal(snapshot(works[0]).usage.input,oldValue,'a build keeps its own immutable row snapshot across yields');
    }
  }finally{db.close();}
});
