import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { entertainmentDocument, entertainmentModule, entertainmentCamera } from '../server/entertainment-calibration.mjs';
import { bridgeTags } from '../server/bridge.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('qualified render calls restore only the active camera immediately before drawing', () => {
  const source=Buffer.from('const $pass={scene:{},camera:{isCamera:true},renderer:{render(s,c){window.draw(c)}}};$pass.renderer.render($pass.scene,$pass.camera);');
  const profile={modules:[{path:'/main.js',sha256:hash(source)}]};
  const order=[];
  runInNewContext(entertainmentModule(source,null,'/main.js',profile).toString(),{
    window:{__AOB__:{prepareCamera:c=>order.push(['prepare',c])},draw:c=>order.push(['draw',c])},
  });
  assert.deepEqual(order.map(row=>row[0]),['prepare','draw']);
  assert.equal(order[0][1],order[1][1]);
});
test('version pinned entertainment modules register controls after setup and reject changed assets', () => {
  for (const init of ['this.minDistance=0,this.maxDistance=1/0', 'field(this,"minDistance",0),field(this,"maxDistance",Infinity)']) {
    const source = Buffer.from(`class Controls{constructor(){${init};this.object={};this.target={};this.ready=true;}}new Controls();`);
    const profile = { modules: [{ path: '/assets/a.js', sha256: hash(source) }] };
    const adapted = entertainmentModule(source, null, '/assets/a.js', profile);
    const queued = [], registered = [];
    runInNewContext(adapted.toString(), { field: (object, key, value) => object[key] = value,
      queueMicrotask: callback => queued.push(callback), window: { __AOB__: { register: control => registered.push(control) } } });
    assert.equal(registered.length, 0);
    queued.forEach(callback => callback());
    assert.equal(registered.length, 1);
    assert.equal(registered[0].ready, true);
    assert.equal(entertainmentModule(Buffer.concat([source, Buffer.from(' ')]), null, '/assets/a.js', profile), null);
    assert.equal(entertainmentModule(source, null, '/other.js', profile), null);
  }
});

test('entertainment view survives author camera resets and releases on direct canvas interaction', () => {
  for (const entertainment of [false, true]) {
    const camera = { position: [1, 2, 3], target: [0, 0, 0] };
    const events = {}, window = entertainment ? { __AOB_ENTERTAINMENT__: true } : {};
    const context = { window, addEventListener: (name, fn) => events[name] = fn, setTimeout: () => {}, requestAnimationFrame: () => {} };
    for (const script of bridgeTags(camera).matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context);
    const object = { position: { x: 0, y: 0, z: 0 }, lookAt() {} }, control = { object, target: { x: 0, y: 0, z: 0 }, update() {} };
    window.__AOB__.register(control);
    object.position.x = 99;
    window.__AOB__.prepareCamera();
    assert.equal(object.position.x, entertainment ? 1 : 99);
    if (entertainment) {
      events.pointerdown({ target: { tagName: 'CANVAS' } });
      object.position.x = 42;
      window.__AOB__.prepareCamera();
      assert.equal(object.position.x, 42);
    }
  }
});

test('entertainment HTML keeps source bytes and URLs intact unless the exact revision matches', () => {
  const doc = Buffer.from('<head><script type="module" src="./assets/a.js"></script><script src="https://cdn.example/a.js"></script>'
    + '<script>class Controls{constructor(){this.minDistance=0,this.maxDistance=Infinity;}}</script></head><p>键盘</p>');
  const profile = { entrySha256: hash(doc), modules: [{ path: '/sub/assets/a.js', sha256: 'unused' }] };
  const out = entertainmentDocument(doc, null, '/sub/index.html', profile).toString();
  assert.match(out, /\/sub\/assets\/a\.js\?aob=entertainment-camera/);
  assert.match(out, /src="https:\/\/cdn.example\/a.js"/);
  assert.match(out, /queueMicrotask/);
  assert.match(out, /键盘/);
  const changed = Buffer.concat([doc, Buffer.from(' ')]);
  assert.equal(entertainmentDocument(changed, null, '/', profile), changed);
  assert.equal(entertainmentCamera({ taskId: 'unknown', id: 'unknown' }, doc), null);
});
