import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { limits } from '../server/config.mjs';
test('only senior dots bypasses the email gate and demotion revokes the exemption', async () => {
 const root=mkdtempSync(join(tmpdir(),'dots-email-'));const dist=join(root,'dist');mkdirSync(dist);
 writeFileSync(join(dist,'data.json'),JSON.stringify({models:[],tasks:[]}));
 const platform=createPlatform({config:{dist,dataDir:join(root,'data'),admins:[],siteOrigins:[],cdn:[],capture:false,contentTemplate:'http://{token}.localhost',secureCookies:false,trustProxy:false},limits});
 const server=createServer(platform.handleSite);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const dots=platform.auth.createAdmin('dots','correct-password');const other=platform.auth.createAdmin('owner','correct-password');
  const cookieFor=user=>{let cookie;platform.auth.startSession({setHeader:(_,v)=>{cookie=v.split(';')[0];}},user.id);return cookie;};
  const cookie=cookieFor(dots);
  assert.equal(platform.auth.public(dots).emailOptional,true);assert.equal(platform.auth.public(other).emailOptional,false);
  assert.equal((await fetch(base+'/api/drafts',{headers:{cookie}})).status,200);
  const denied=await fetch(base+'/api/drafts',{headers:{cookie:cookieFor(other)}});assert.equal(denied.status,403);assert.equal((await denied.json()).code,'email_required');
  platform.db.prepare("UPDATE users SET role='user' WHERE id=?").run(dots.id);
  assert.equal(platform.auth.public(platform.auth.byId(dots.id)).emailOptional,false);
  assert.equal((await fetch(base+'/api/drafts',{headers:{cookie}})).status,403);
 } finally {await new Promise(r=>server.close(r));await platform.close();rmSync(root,{recursive:true,force:true});}
});
