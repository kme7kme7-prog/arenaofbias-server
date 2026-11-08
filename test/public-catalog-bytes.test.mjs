import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createPlatform} from '../server/app.mjs';
import {limits} from '../server/config.mjs';
import {openDatabase} from '../server/db.mjs';

// Exact response bodies frozen from 577067e with this data, clock and server version.
// Provenance/generator: .local/board-v3-20261108/usage/dev-guided/metrics-endpoint/freeze-577.mjs.
test('catalog and anonymous full bootstrap remain byte-for-byte equal to 577067e even with stored metrics', async t => {
  t.mock.timers.enable({apis:['Date'],now:1800000000000});
  const previous=process.env.SERVER_VERSION;process.env.SERVER_VERSION='catalog-byte-fixture';
  const root=mkdtempSync(join(tmpdir(),'catalog-bytes-')),dist=join(root,'dist'),dataDir=join(root,'state');
  let platform,server;
  try {
    mkdirSync(join(dist,'results/fixture'),{recursive:true});
    copyFileSync(new URL('./fixtures/public-catalog-data.json',import.meta.url),join(dist,'data.json'));
    writeFileSync(join(dist,'results/fixture/index.html'),'<h1>Fixture work</h1>');
    const db=openDatabase(join(dataDir,'platform.db'));
    db.prepare("INSERT INTO work_usage(task_id,work_id,input,source,created_at,updated_at) VALUES ('fixture-task','fixture-work',123,'log',1,1)").run();
    db.prepare("INSERT INTO work_artifacts(task_id,work_id,artifact,updated_at) VALUES ('fixture-task','fixture-work',?,1)").run(JSON.stringify({files:1,lines:1,bytes:6,chars:2}));db.close();
    platform=createPlatform({config:{dist,dataDir,contentTemplate:'http://{token}.localhost',siteOrigins:[],admins:[],cdn:[],capture:false,secureCookies:false,leaderboardWarmup:false},limits});
    server=createServer(platform.handleSite).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const route of ['catalog','bootstrap']) {
      const response=await fetch(`${base}/api/${route}`);assert.equal(response.status,200);
      assert.equal(await response.text(),readFileSync(new URL(`./fixtures/public-${route}-577067e.json`,import.meta.url),'utf8'));
    }
    const metrics=await (await fetch(base+'/api/works/metrics')).json();
    assert.equal(metrics.usage['fixture-task']['fixture-work'].input,123);
    assert.equal(metrics.artifact['fixture-task']['fixture-work'].chars,2);
  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(platform)await platform.close();rmSync(root,{recursive:true,force:true});
    if(previous===undefined)delete process.env.SERVER_VERSION;else process.env.SERVER_VERSION=previous;
  }
});
