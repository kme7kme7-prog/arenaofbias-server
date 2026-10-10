// Camera bridge tests: importmap rewriting, virtual forwarding modules, the injected
// document plan per content key, and the content-server integration. Requests go through
// node:http because undici's fetch ignores custom Host headers, and the content server
// routes by work host name.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bridgeTags, probeTag, rewriteImportmap, serveBridgeVirtual, validCamera } from '../server/bridge.mjs';
import { createContentHandler } from '../server/content.mjs';
import { config as defaultConfig } from '../server/config.mjs';
import { drainServers } from '../server/shutdown.mjs';

const CAMERA = { position: [1, 2, 3], target: [0, 0, 0] };

test('rewriteImportmap moves CDN addons and the three entry onto the virtual route', () => {
  const doc = Buffer.from('<!doctype html><head><script type="importmap">'
    + '{"imports":{"three":"https://cdn.example.com/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.example.com/three@0.160.0/examples/jsm/"}}'
    + '</script></head><body></body>');
  const out = rewriteImportmap(doc, '/').toString('latin1');
  assert.match(out, /"three":"\/__aob__\/three\.mjs\?u=https%3A%2F%2Fcdn\.example\.com%2Fthree%400\.160\.0%2Fbuild%2Fthree\.module\.js"/);
  assert.match(out, /"three\/addons\/":"\/__aob__\/ad\/https%3A%2F%2Fcdn\.example\.com%2Fthree%400\.160\.0%2Fexamples%2Fjsm%2F\/"/);
});

test('rewriteImportmap resolves relative OrbitControls keys against the document URL', () => {
  const doc = Buffer.from('<script type="importmap">'
    + '{"imports":{"three":"./vendor/three.module.js","three/addons/OrbitControls.js":"./vendor/jsm/OrbitControls.js"}}'
    + '</script>');
  const out = rewriteImportmap(doc, '/sub/page.html').toString('latin1');
  assert.match(out, /"three\/addons\/OrbitControls\.js":"\/__aob__\/ad\/%2Fsub%2Fvendor%2Fjsm\/OrbitControls\.js"/);
  assert.match(out, /"three":"\.\/vendor\/three\.module\.js"/, 'non-https three stays untouched');
});

test('rewriteImportmap leaves unusable targets and malformed maps alone', () => {
  for (const json of ['{"imports":{"three/addons/":"data:text/plain,_"}}', '{not json', '{"scope":{}}']) {
    const doc = Buffer.from(`<script type="importmap">${json}</script>`);
    assert.equal(rewriteImportmap(doc, '/').toString('latin1'), doc.toString('latin1'));
  }
  const none = Buffer.from('<!doctype html><html><body>no map</body></html>');
  assert.equal(rewriteImportmap(none, '/').toString('latin1'), none.toString('latin1'));
});

test('serveBridgeVirtual validates forwarding targets', () => {
  assert.equal(serveBridgeVirtual('/index.html', new URLSearchParams()), null);
  assert.deepEqual(serveBridgeVirtual('/__aob__/three.mjs', new URLSearchParams('u=http://insecure.example/x.js')), { error: 400 });
  assert.deepEqual(serveBridgeVirtual('/__aob__/ad/%2F..%2Fjsm/x.js', new URLSearchParams()), { error: 400 });
  assert.deepEqual(serveBridgeVirtual('/__aob__/ad/https%3A%2F%2Fcdn.example%2Fjsm%2F..%2Fx.js', new URLSearchParams()), { error: 400 });
  assert.deepEqual(serveBridgeVirtual('/__aob__/ad/%2F__aob__%2Fjsm/x.js', new URLSearchParams()), { error: 400 });
  const controls = serveBridgeVirtual('/__aob__/ad/https%3A%2F%2Fcdn.example%2Fjsm/OrbitControls.js', new URLSearchParams());
  assert.match(controls.body, /window\.__AOB__\.wrap\(__Base\)/);
  assert.match(controls.body, /export default __AOB_NS\.default/, 'default export is forwarded for lil-gui-style addons');
  const other = serveBridgeVirtual('/__aob__/ad/%2Fvendor%2Fjsm/BufferGeometryUtils.js', new URLSearchParams());
  assert.match(other.body, /export \* from "\/vendor\/jsm\/BufferGeometryUtils\.js"/);
  assert.doesNotMatch(other.body, /__AOB__\.wrap/, 'only OrbitControls gets wrapped');
});

test('bridgeTags order the saved camera and capture flag before the runtime', () => {
  const tags = bridgeTags(CAMERA, true);
  assert.ok(tags.indexOf('window.__AOB_SAVED__=') < tags.indexOf('window.__AOB__={'), 'camera is in place before the runtime reads it');
  assert.ok(tags.includes('__AOB_CAPTURE__=true'));
  const plain = bridgeTags(null, false);
  assert.ok(!plain.includes('window.__AOB_SAVED__=') && !plain.includes('__AOB_CAPTURE__=true'));
  assert.ok(probeTag().includes("parent.postMessage('aob:work-ready','*')"));
  assert.ok(probeTag().includes("parent.postMessage('aob:work-loading','*')"));
});

test('validCamera accepts only position/target of three finite numbers', () => {
  assert.ok(validCamera(CAMERA));
  for (const bad of [null, {}, { position: [1, 2, 3] }, { position: [1, 2], target: [0, 0, 0] },
    { position: [1, 2, Infinity], target: [0, 0, 0] }, { position: [1, 2, 3], target: [0, 0, 0], zoom: 1 }]) {
    assert.ok(!validCamera(bad));
  }
});

// ---- content server integration ----

const key = (prefix, n) => `${prefix}${String(n).padStart(32, '0')}`;

function request(base, host, path = '/') {
  return new Promise((resolve, reject) => {
    httpGet(new URL(path, base), { headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'], body: Buffer.concat(chunks).toString('latin1') }));
    }).on('error', reject);
  });
}

test('content server injects per key type', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-works-'));
  let workFor = () => null;
  const server = createServer(createContentHandler({
    config: { cdn: ['cdn.example.com', ...defaultConfig.cdn], siteOrigins: ['https://game.example'] },
    siteOrigins: ['https://game.example'],
    library: {
      draftByToken: () => null,
      previewByKey: (k) => workFor(k) ?? null,
      byContentKey: (k) => workFor(k) ?? null,
      calibrationOf: (work, face) => work?.calibration?.[face] ?? null,
      isEligible: (work) => Boolean(work),
      publicContent: (work) => Boolean(work),
    },
    arena: { workForToken: (k) => workFor(k) ?? null },
  }));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    mkdirSync(join(root, 'importmap'));
    mkdirSync(join(root, 'plain'));
    const importmapDoc = '<!doctype html><head><script type="importmap">'
      + '{"imports":{"three":"https://cdn.example.com/three.module.js","three/addons/":"https://cdn.example.com/jsm/"}}'
      + '</script></head><body><canvas id="c"></canvas></body></html>';
    const plainDoc = '<!doctype html><head><title>w</title></head><body>hello</body></html>';
    writeFileSync(join(root, 'importmap', 'index.html'), importmapDoc);
    writeFileSync(join(root, 'plain', 'index.html'), plainDoc);
    workFor = (k) => {
      if (k[0] === 'm') return { dir: join(root, 'importmap'), entry: 'index.html', moderation: { status: 'legacy' }, calibration: { arena: { camera: CAMERA } } };
      if (k === key('w', 1)) return { dir: join(root, 'plain'), entry: 'index.html', moderation: { status: 'legacy' }, calibration: null };
      if (k === key('w', 2)) return { dir: join(root, 'plain'), entry: 'index.html', moderation: { status: 'legacy' }, calibration: { gallery: { camera: CAMERA } } };
      if (k === key('p', 3)) return { dir: join(root, 'plain'), entry: 'index.html', moderation: { status: 'approved' }, calibration: null };
      return null;
    };

    const match = await request(base, `${key('m', 9)}.w.example`);
    assert.equal(match.status, 200);
    assert.match(match.type, /^text\/html/);
    const scriptSources = match.csp.split(';').find(directive => directive.trim().startsWith('script-src ')).trim().split(/\s+/);
    assert.ok(scriptSources.includes('https://registry.npmmirror.com/three/0.170.0/files/'));
    assert.ok(!scriptSources.includes('https://registry.npmmirror.com'), 'the whole mirror remains blocked');
    assert.ok(match.body.includes('/__sp_fold.js'), 'match sides keep the fold');
    assert.ok(match.body.includes('data-aob-probe'), 'match sides get the ready probe');
    assert.ok(match.body.includes(`window.__AOB_SAVED__=${JSON.stringify(CAMERA)}`), 'arena camera is restored');
    assert.ok(!match.body.includes('__AOB_CAPTURE__=true'), 'match sides never capture');
    assert.match(match.body, /"three":"\/__aob__\/three\.mjs\?u=/, 'importmap is rewritten');

    const plainPublic = await request(base, `${key('w', 1)}.w.example`);
    assert.equal(plainPublic.body, plainDoc, 'uncalibrated public work stays byte-identical');

    const stage = await request(base, `${key('w', 1)}.w.example`, '/?aob=playground&aob=prev&aob=arena-fold&parent=https%3A%2F%2Fgame.example');
    assert.ok(stage.body.includes('/__playground.js'), 'approved playground gets its real-draw readiness owner');
    assert.ok(stage.body.includes('window.__PLAYGROUND_ORIGIN__="https://game.example"'), 'stage messages target the configured parent');
    assert.ok(!stage.body.includes('data-aob-probe'), 'readiness owners do not overlap');
    assert.ok(stage.body.includes('/__aob_fold.js'), 'the existing scene control fold remains');
    const stageScript = await request(base, `${key('w', 1)}.w.example`, '/__playground.js');
    assert.equal(stageScript.status, 200);
    assert.ok(stageScript.body.includes('GPUQueue') && stageScript.body.includes('hasLoadingOverlay'), 'GPU and real overlay checks survive production serving');
    const badParent = await request(base, `${key('w', 1)}.w.example`, '/?aob=playground&aob=prev&parent=https%3A%2F%2Foutside.example');
    assert.ok(!badParent.body.includes('/__playground.js'), 'an unconfigured parent cannot activate the stage bridge');
    const stageMatch = await request(base, `${key('m', 9)}.w.example`, '/?aob=playground&parent=https%3A%2F%2Fgame.example');
    assert.ok(!stageMatch.body.includes('/__playground.js') && stageMatch.body.includes('data-aob-probe'), 'formal match readiness stays unchanged');

    const folded = await request(base, `${key('w', 1)}.w.example`, '/?aob=fold&face=gallery&custom=keep');
    assert.ok(folded.body.includes('<script src="/__sp_fold.js"></script>'), 'public viewers can opt into the fold');
    assert.ok(!folded.body.includes('data-aob-probe'), 'public fold does not add the match ready probe');
    const foldAsset = await request(base, `${key('w', 1)}.w.example`, '/__sp_fold.js');
    assert.equal(foldAsset.status, 200, 'injected script loads without carrying the document query');
    assert.equal(foldAsset.body, readFileSync(new URL('../server/fold.js', import.meta.url), 'latin1'));

    const galleryCalibrated = await request(base, `${key('w', 2)}.w.example`);
    assert.ok(galleryCalibrated.body.includes(`window.__AOB_SAVED__=${JSON.stringify(CAMERA)}`), 'gallery camera falls back in for public pages');

    const capture = await request(base, `${key('w', 1)}.w.example`, '/?aob=bridge');
    assert.ok(capture.body.includes('__AOB_CAPTURE__=true'));
    assert.ok(!capture.body.includes('window.__AOB_SAVED__='), 'no camera to start from');
    const combined = await request(base, `${key('w', 1)}.w.example`, '/?aob=bridge&aob=fold&face=gallery');
    assert.ok(combined.body.includes('__AOB_CAPTURE__=true'));
    assert.ok(combined.body.includes('/__sp_fold.js'), 'adding fold preserves an existing bridge query');

    const preview = await request(base, `${key('p', 3)}.w.example`, '/?aob=bridge&face=gallery');
    assert.ok(preview.body.includes('__AOB_CAPTURE__=true'));

    const forwarded = await request(base, `${key('w', 1)}.w.example`, '/__aob__/ad/https%3A%2F%2Fcdn.example%2Fjsm/OrbitControls.js');
    assert.equal(forwarded.status, 200);
    assert.match(forwarded.type, /^text\/javascript/);
    assert.match(forwarded.body, /window\.__AOB__ \? window\.__AOB__\.wrap\(__Base\) : __Base/);

    const refused = await request(base, `${key('w', 1)}.w.example`, '/__aob__/three.mjs?u=http://insecure.example/x.js');
    assert.equal(refused.status, 400);
  } finally {
    await drainServers([server]);
    rmSync(root, { recursive: true, force: true });
  }
});
