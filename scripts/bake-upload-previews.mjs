// Build private preview media for explicitly named, public single-HTML uploads.
// Example:
//   $env:DATAPACK_SOURCE_DIR='<path-to-data-checkout>'
//   $env:GALLERY_DIR='<path-to-gallery-checkout>'
//   node scripts/bake-upload-previews.mjs --id=up-... --bootstrap=... --source-dir=...
// This tool only writes its generated extraction copies and media under output/.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadPreviewAdaptations } from './upload-preview-adaptations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataRoot = resolve(process.env.DATAPACK_SOURCE_DIR ?? '');
const galleryRoot = resolve(process.env.GALLERY_DIR ?? '');
const bootstrapPath = resolve(arg('bootstrap') ?? '');
const sourceRoot = resolve(arg('source-dir') ?? '');
const outputRoot = resolve(arg('output-dir') ?? join(root, 'output/page-adaptation-20261004'));
const ids = (arg('id') ?? '').split(',').filter(Boolean);
if (!process.env.DATAPACK_SOURCE_DIR || !process.env.GALLERY_DIR || !arg('bootstrap') || !arg('source-dir') || !ids.length) {
  throw new Error('Set DATAPACK_SOURCE_DIR to the local arenaofbias-data checkout and GALLERY_DIR; pass --bootstrap=<json> --source-dir=<dir> --id=<up-id>[,<up-id>...]');
}
if (!outputRoot.startsWith(resolve(root, 'output') + sep)) throw new Error('Output must stay under the backend output/ directory.');
for (const required of [join(dataRoot, 'scripts/baker/import-architecture.js'), join(dataRoot, 'scripts/datapack-bridge.js'),
  join(dataRoot, 'dist/vendor/three.module.js'), join(dataRoot, 'dist/data.json'), join(galleryRoot, 'site/result-previews.js'),
  join(galleryRoot, 'site/preview-model.js'), join(galleryRoot, 'site/scene-resources.js')]) {
  if (!existsSync(required)) throw new Error(`Missing required preview source: ${required}`);
}

const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8'));
const galleryData = JSON.parse(readFileSync(join(dataRoot, 'dist/data.json'), 'utf8'));
const taskById = new Map((galleryData.tasks ?? []).map((task) => [task.id, task]));
const jobs = ids.map((id) => {
  if (!/^up-[a-z0-9]{8}$/.test(id)) throw new Error(`Invalid upload id: ${id}`);
  const work = bootstrap.works?.find((item) => item.id === id && item.scene && item.status === 'verified');
  if (!work) throw new Error(`No verified public bootstrap work found for ${id}`);
  const scene = new URL(work.scene);
  if (scene.protocol !== 'https:' || !/^w[0-9a-f]{32}\.w\.arenaofbias\.icu$/i.test(scene.hostname)) {
    throw new Error(`Refusing non-public work content origin for ${id}`);
  }
  const adaptation = uploadPreviewAdaptations[`${work.task}/${id}`] ?? {};
  const cardArchitecture = taskById.get(work.task)?.sceneProfile === 'architecture';
  return { task: work.task, id, scene: scene.href, bytes: work.bytes, model: work.modelName, effort: work.effort,
    architecture: adaptation.architecture ?? cardArchitecture, cardArchitecture, adaptation };
});
mkdirSync(outputRoot, { recursive: true });

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const extractions = new Map();
for (const job of jobs) {
  const sourceDir = join(sourceRoot, job.id);
  const sourcePath = ['index.html', 'source.html', `${job.id}.html`].map((name) => join(sourceDir, name)).find(existsSync);
  if (!sourcePath) throw new Error(`Missing explicit source HTML: ${sourceDir}`);
  const bytes = readFileSync(sourcePath);
  if (job.bytes && bytes.length !== job.bytes) throw new Error(`${job.id}: source HTML length ${bytes.length} does not match bootstrap bytes ${job.bytes}; use the original local entry file.`);
  const source = bytes.toString('utf8');
  const patched = instrumentExtractionCopy(source);
  const copyDir = join(outputRoot, 'extract', job.id);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, 'source.original.html'), bytes);
  writeFileSync(join(copyDir, 'index.html'), patched);
  extractions.set(job.id, { sourcePath, origin: new URL(job.scene), digest: sha256(bytes), htmlPath: join(copyDir, 'index.html') });
}

function instrumentExtractionCopy(source) {
  let patched = source.replace(/this\.isScene\s*=\s*(?:!0|true)\b/g, (match) => {
    return `${match},window.__galleryCaptureScene?.(this)`;
  });
  if (!patched.includes('window.__galleryCaptureScene?.(this)') && !patched.includes('window.__galleryCaptureScene?.(')) patched = patched.replace(/\bnew\s+(?:[A-Za-z_$][\w$]*\.)?Scene\s*\(\s*\)/g, (match) => {
    return `((s)=>(s?.isScene&&window.__galleryCaptureScene?.(s),s))(${match})`;
  });
  const prelude = `<script>(()=>{const prior=Object.getOwnPropertyDescriptor(Object.prototype,'isScene');if(prior)return;Object.defineProperty(Object.prototype,'isScene',{configurable:true,set(value){Object.defineProperty(this,'isScene',{value,writable:true,configurable:true,enumerable:true});if(value===true)queueMicrotask(()=>{if(this.isScene&&this.type==='Scene')window.__galleryCaptureScene?.(this)})}})})();</script><script src="/__bake/sandtable-bridge.js"></script>`;
  return /<head\b[^>]*>/i.test(patched)
    ? patched.replace(/<head\b[^>]*>/i, (head) => `${head}${prelude}`)
    : patched.replace(/^\s*(?:<!doctype[^>]*>)?/i, (doctype) => `${doctype}${prelude}`);
}

const dataBaker = join(dataRoot, 'scripts/baker');
const gallerySite = join(galleryRoot, 'site');
const dataVendor = join(dataRoot, 'dist/vendor');
const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const jobById = new Map(jobs.map((job) => [job.id, job]));
let activeId = jobs[0].id;
const appHtml = `<!doctype html><meta charset="utf-8"><title>Upload preview baker</title>
<style>body{font:14px/1.5 system-ui;margin:24px}iframe{position:fixed;left:-1600px;top:0;width:1280px;height:720px;visibility:hidden}li{margin:6px 0}.error{color:#b43b28}</style>
<h1>Building selected upload previews</h1><ol id="status"></ol>
<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/controls/OrbitControls.js":"/vendor/OrbitControls.js","three/addons/utils/BufferGeometryUtils.js":"/vendor/BufferGeometryUtils.js"}}</script>
<script>window.__UPLOAD_PREVIEW_ADAPTATIONS=${JSON.stringify(Object.fromEntries(jobs.map((job) => [`${job.task}/${job.id}`, job.adaptation])))};</script>
<script type="module">
import { importArchitecture, disposeObject } from '/__bake/import-architecture.js';
import { packPreview } from '/__bake/pack-preview.js';
import { selectPreviewRoots } from '/__bake/preview-subjects.js';
const jobs=${JSON.stringify(jobs.map(({ task,id,scene,architecture,cardArchitecture }) => ({task,id,scene,architecture,cardArchitecture})))};
const list=document.querySelector('#status');
function rootsFor(scenes, job) {
  const spec=window.__UPLOAD_PREVIEW_ADAPTATIONS[job.task+'/'+job.id]??{};
  if(spec.rootName){let found;for(const scene of scenes)scene.traverse(o=>{if(!found&&o.name===spec.rootName)found=o});if(!found)throw new Error('Configured subject root not found: '+spec.rootName);return [found]}
  if(Number.isInteger(spec.groupIndex)){const scene=scenes.find(s=>s.isScene&&s.children.filter(c=>c.isGroup).length>spec.groupIndex);const group=scene?.children.filter(c=>c.isGroup)[spec.groupIndex];if(!group)throw new Error('Configured subject group not found: '+spec.groupIndex);return [group]}
  return selectPreviewRoots(scenes,job.task,job.id);
}
function waitForScene(frame,job){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('No stable exportable scene within 60 seconds'))},60000);const onMessage=e=>{if(e.origin!==location.origin||e.source!==frame.contentWindow||e.data?.type!=='gallery-scene-ready')return;cleanup();resolve(frame.contentWindow.__galleryScenes)};function cleanup(){clearTimeout(timer);removeEventListener('message',onMessage)}addEventListener('message',onMessage);frame.src='/work/'+job.id+'/index.html?sandtable=1'})}
async function save(url,body){const r=await fetch(url,{method:'POST',body});if(!r.ok)throw new Error(await r.text())}
for(const job of jobs){const row=document.createElement('li');row.dataset.id=job.id;row.textContent=job.task+'/'+job.id+' · extracting';list.append(row);let frame,imported,rendered,renderer;
 try{window.__UPLOAD_PREVIEW_ACTIVE_ID=job.id;frame=document.createElement('iframe');document.body.append(frame);const scenes=await waitForScene(frame,job);const selected=rootsFor(scenes,job);imported=await importArchitecture(selected,job.id,{architecture:job.architecture,railwayPreview:false,task:job.task});const packed=await packPreview(imported,job.architecture);await save('/__bake/save/'+job.id+'/preview.sbox',packed);row.textContent=job.task+'/'+job.id+' · rendering Gallery poster';
  const blob=new Blob([packed],{type:'application/octet-stream'}),modelUrl=URL.createObjectURL(blob);const previews=await import('/result-previews.js');const {readModel}=await import('/preview-model.js');const {disposeObject:disposePreview}=await import('/scene-resources.js');rendered=await readModel(modelUrl);URL.revokeObjectURL(modelUrl);const card=previews.buildPreviewScene(rendered,job.cardArchitecture,job.cardArchitecture&&rendered.clip);const camera=previews.createPreviewCamera(),aspect=previews.previewAspect(camera,card.bounds);const width=Math.round(aspect>=1?720:720*aspect),height=Math.round(aspect>=1?720/aspect:720);renderer=previews.createPreviewRenderer(1);renderer.setSize(width,height,false);previews.fitPreviewCamera(camera,card.bounds,width/height);renderer.render(card.scene,camera);const poster=await new Promise((resolve,reject)=>renderer.domElement.toBlob(v=>v?resolve(v):reject(new Error('Gallery poster render returned no image')),'image/webp',0.86));await save('/__bake/save/'+job.id+'/preview.webp',poster);disposePreview(card.scene);row.dataset.success='true';row.textContent=job.task+'/'+job.id+' · preview ready';
 }catch(error){row.textContent=job.task+'/'+job.id+' · '+error.message;row.className='error';console.error('UPLOAD_PREVIEW_FAILED',job.id,error)}finally{frame?.remove();if(imported)disposeObject(imported.group);if(rendered)disposeObject(rendered.group);if(renderer){renderer.dispose();renderer.forceContextLoss()}}}
document.body.dataset.done='true';
</script>`;

function modifiedImporter() {
  let source = readFileSync(join(dataBaker, 'import-architecture.js'), 'utf8');
  const signature = "export async function importArchitecture(scenes, id, { architecture = true, railwayPreview = false, task = '' } = {}) {";
  if (!source.includes(signature)) throw new Error('Unexpected data importer signature; refusing an unsafe adaptation patch.');
  source = source.replace(signature, `${signature}\n  const adaptation = globalThis.__UPLOAD_PREVIEW_ADAPTATIONS?.[\`${'${task}/${id}'}\`] ?? {};`);
  source = replaceOnce(source, 'const previewFocus = focusedBounds || campFocus || launchFocus || rocketFocus ||', 'const previewFocus = adaptation.focusedBounds || focusedBounds || campFocus || launchFocus || rocketFocus ||');
  source = replaceOnce(source, 'const compoundBounds = focusedBounds || (architecture && (', 'const compoundBounds = adaptation.focusedBounds || focusedBounds || (architecture && (');
  source = replaceOnce(source, '  const previewYaw = task ===', '  const nativePreviewYaw = task ===');
  source = replaceOnce(source, '    ? Math.PI / 2 : noseYaw;\n  const compoundBounds', '    ? Math.PI / 2 : noseYaw;\n  const previewYaw = adaptation.previewYaw ?? nativePreviewYaw;\n  const compoundBounds');
  source = replaceOnce(source, '  ]).has(`${task}/${id}`);\n  for (const { mesh, size, bounds: meshBounds, instances } of meshes) {', '  ]).has(`${task}/${id}`) || adaptation.crop === true;\n  for (const { mesh, size, bounds: meshBounds, instances } of meshes) {');
  source = replaceOnce(source, 'const croppedGeometry = !mesh.isInstancedMesh && (oversized || deskSlab || lampBoundaryCrop || show1BoundaryCrop)', 'const croppedGeometry = !mesh.isInstancedMesh && (oversized || deskSlab || lampBoundaryCrop || show1BoundaryCrop || (adaptation.crop && !bounds.containsBox(meshBounds)))');
  return source;
}
function replaceOnce(source, find, replace) { if (!source.includes(find)) throw new Error(`Data importer adaptation point changed: ${find.slice(0, 70)}`); return source.replace(find, replace); }

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/__bake/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(appHtml); return; }
    if (pathname === '/__bake/import-architecture.js') { response.setHeader('Content-Type','text/javascript; charset=utf-8'); response.end(modifiedImporter()); return; }
    if (pathname === '/__bake/sandtable-bridge.js') { response.setHeader('Content-Type','text/javascript; charset=utf-8'); response.end(readFileSync(join(dataRoot,'scripts/datapack-bridge.js'),'utf8')); return; }
    const saveMatch=/^\/__bake\/save\/(up-[a-z0-9]{8})\/(preview\.sbox|preview\.webp)$/.exec(pathname);
    if(saveMatch&&request.method==='POST'){
      const [,id,file]=saveMatch;if(!jobById.has(id)){response.writeHead(404);response.end();return}
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks);
      const target=join(outputRoot,'media',id,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body);
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({bytes:body.length,sha256:sha256(body)}));return;
    }
    if (pathname.startsWith('/__bake/')) {
      const name = pathname.slice('/__bake/'.length);
      const base = name.startsWith('vendor/') ? dataVendor : dataBaker;
      const local = resolve(base, `.${name.startsWith('vendor/') ? name.slice('vendor'.length) : `/${name}`}`);
      if (!local.startsWith(base + sep) || !existsSync(local)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type',contentTypes[extname(local)]??'application/octet-stream'); response.end(readFileSync(local)); return;
    }
    if (pathname.startsWith('/vendor/')) {
      const local = resolve(dataVendor, `.${pathname.slice('/vendor'.length)}`);
      if (!local.startsWith(dataVendor + sep) || !existsSync(local)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type',contentTypes[extname(local)]??'application/octet-stream'); response.end(readFileSync(local)); return;
    }
    if (['/result-previews.js','/preview-model.js','/scene-resources.js','/sandtable.js'].includes(pathname)) {
      const local=join(gallerySite,pathname.slice(1)); if(!existsSync(local)){response.writeHead(404);response.end();return}
      response.setHeader('Content-Type','text/javascript; charset=utf-8');response.end(readFileSync(local));return;
    }
    const workMatch=/^\/work\/(up-[a-z0-9]{8})\/(.*)$/.exec(pathname);
    const selectedId=workMatch?.[1]??globalThis.__UPLOAD_PREVIEW_ACTIVE_ID??activeId;
    const extraction=extractions.get(selectedId);const job=jobById.get(selectedId);
    if(!extraction||!job){response.writeHead(404);response.end();return}
    activeId=selectedId;
    const remotePath=workMatch?.[2] ? `/${workMatch[2]}` : pathname;
    if(workMatch&&workMatch[2]==='index.html'){
      response.setHeader('Content-Type','text/html; charset=utf-8');response.end(readFileSync(extraction.htmlPath));return;
    }
    if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405,{Allow:'GET, HEAD'});response.end();return}
    const remote=new URL(remotePath+url.search,extraction.origin);
    if(remote.origin!==extraction.origin.origin){response.writeHead(403);response.end();return}
    const upstream=await fetch(remote,{method:request.method,signal:AbortSignal.timeout(30000)});
    response.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??contentTypes[extname(remote.pathname)]??'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
    if(request.method==='HEAD'||!upstream.body){response.end();return}
    for await(const chunk of upstream.body)response.write(chunk);response.end();
  } catch(error){if(!response.headersSent){response.writeHead(500);response.end(error.message)}else response.destroy(error)}
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const dataRequire=createRequire(join(dataRoot,'package.json'));
const {chromium}=dataRequire('playwright');
const browser=await chromium.launch({channel:arg('browser')??'chrome'});
let failed=0;
let ready=0;
const successfulIds = new Set();
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.route('**/*', route => {
    const request=route.request();
    const localSave=request.url().startsWith(`http://127.0.0.1:${server.address().port}/__bake/save/`);
    return ['GET','HEAD'].includes(request.method())||localSave?route.continue():route.abort();
  });
  page.on('console',message=>{if(message.type()==='error')console.error('Browser:',message.text())});
  await page.goto(`http://127.0.0.1:${server.address().port}/__bake/`);
  await page.waitForFunction(()=>document.body.dataset.done==='true',null,{timeout:0});
  for(const row of await page.locator('#status li.error').allTextContents()){failed++;console.error(row)}
  for(const id of await page.locator('#status li[data-success="true"]').evaluateAll(rows=>rows.map(row=>row.dataset.id)))successfulIds.add(id);
}finally{await browser.close();server.close()}

for(const job of jobs){
  if(!successfulIds.has(job.id))continue;
  const dir=join(outputRoot,'media',job.id), modelPath=join(dir,'preview.sbox'), posterPath=join(dir,'preview.webp');
  if(!existsSync(modelPath)||!existsSync(posterPath)){failed++;console.error(`${job.id}: preview succeeded but current model/poster output is missing`);continue;}
  const metadata={schemaVersion:1,sourceDigest:extractions.get(job.id).digest,mode:'model',model:'preview.sbox',modelSha:sha256(readFileSync(modelPath)),poster:'preview.webp',posterSha:sha256(readFileSync(posterPath))};
  writeFileSync(join(dir,'preview.json'),`${JSON.stringify(metadata,null,2)}\n`);
  ready++;
  console.log(`${job.task}/${job.id}: model ${Math.round(readFileSync(modelPath).length/1024)} KiB, poster ${Math.round(readFileSync(posterPath).length/1024)} KiB, source ${metadata.sourceDigest}`);
}
console.log(`Previews: ${ready} ready, ${failed} failed. Output: ${outputRoot}`);
if(failed)process.exitCode=1;
