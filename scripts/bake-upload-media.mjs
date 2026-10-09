// Produce both card modes with the same source digest and capture recipe.
// capture-dir contains actual default-page captures; originals are never changed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadPreviewAdaptations } from './upload-preview-adaptations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function selectMediaJobs(bootstrap, ids, adaptations = uploadPreviewAdaptations) {
  return ids.map(id => {
    const work = bootstrap.works?.find(w => w.id === id && w.status === 'verified' && w.scene);
    if (!work) throw new Error('No verified public work: ' + id);
    const recipe = adaptations[`${work.task}/${id}`] ?? {};
    return { id, task: work.task, mode: recipe.previewMode === 'screenshot' ? 'screenshot' : 'model' };
  });
}

async function capturePages(jobs, bootstrap, adaptations, sourceRoot, destination, channel) {
  const requireFromData = createRequire(join(resolve(process.env.DATAPACK_SOURCE_DIR), 'package.json'));
  const { chromium } = requireFromData('playwright');
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
    let errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (['GET', 'HEAD'].includes(request.method())) errors.push(request.failure()?.errorText ?? 'Resource request failed');
    });
    for (const job of jobs) {
      errors = [];
      const work = bootstrap.works.find(work => work.id === job.id);
      const url = new URL(work.scene);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^w[0-9a-f]{32}\.w\.arenaofbias\.icu$/i.test(url.hostname)) throw new Error('Not a public work origin: ' + job.id);
      const entry = ['index.html', 'source.html', job.id + '.html'].map(name => join(sourceRoot, job.id, name)).find(existsSync);
      if (!entry) throw new Error('Missing exact source entry: ' + job.id);
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!response?.ok() || hash(await response.body()) !== hash(readFileSync(entry))) throw new Error('Public source changed: ' + job.id);
      const waitMs = adaptations[`${job.task}/${job.id}`]?.captureWaitMs ?? 20000;
      await page.waitForTimeout(waitMs);
      if (errors.length) throw new Error(`${job.id}: default capture failed: ${errors[0]}`);
      const directory = join(destination, job.id);
      mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: join(directory, 'first.jpg'), type: 'jpeg', quality: 92 });
      console.log(`${job.id}: natural default capture after ${waitMs}ms`);
    }
  } finally { await browser.close(); }
}

async function run() {
  const options = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error('Pass named --key=value arguments.');
    return [match[1], match[2]];
  }));
  for (const key of ['bootstrap', 'id', 'source-dir', 'output-dir']) {
    if (!options[key]) throw new Error('Missing --' + key);
  }
  const output = resolve(options['output-dir']);
  const fromOutput = relative(join(root, 'output'), output);
  if (!fromOutput || fromOutput === '..' || fromOutput.startsWith('..' + sep) || isAbsolute(fromOutput)) {
    throw new Error('Use a dedicated directory under server output/.');
  }
  const bootstrap = JSON.parse(readFileSync(resolve(options.bootstrap), 'utf8'));
  const adaptations = options.adaptations
    ? { ...uploadPreviewAdaptations, ...JSON.parse(readFileSync(resolve(options.adaptations), 'utf8')) }
    : uploadPreviewAdaptations;
  const jobs = selectMediaJobs(bootstrap, options.id.split(','), adaptations);
  const captureDir = options['capture-pages'] === 'true' ? join(output, 'source-captures')
    : options['capture-dir'] && resolve(options['capture-dir']);
  if (!captureDir) throw new Error('Pass --capture-dir or --capture-pages=true.');
  if (options['capture-pages'] === 'true') await capturePages(jobs, bootstrap, adaptations,
    resolve(options['source-dir']), captureDir, options.browser ?? 'chrome');
  const models = jobs.filter(job => job.mode === 'model');
  const invoke = (script, args) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { stdio: 'inherit' });
  const shared = ['--bootstrap=' + resolve(options.bootstrap), '--source-dir=' + resolve(options['source-dir'])];
  if (models.length) invoke('bake-upload-previews.mjs', [...shared,
    '--id=' + models.map(job => job.id).join(','), '--output-dir=' + join(output, 'models'),
    ...(options.adaptations ? ['--adaptations=' + resolve(options.adaptations)] : []),
    ...(options.browser ? ['--browser=' + options.browser] : [])]);
  invoke('bake-upload-captures.mjs', [...shared, '--id=' + jobs.map(job => job.id).join(','),
    '--capture-dir=' + captureDir, '--output-dir=' + join(output, 'captures')]);
  for (const job of jobs) {
    const captureDir = join(output, 'captures/media', job.id);
    const capture = JSON.parse(readFileSync(join(captureDir, 'preview.json'), 'utf8'));
    const modelDir = join(output, 'models/media', job.id);
    const manifest = job.mode === 'model' ? JSON.parse(readFileSync(join(modelDir, 'preview.json'), 'utf8')) : capture;
    if (manifest.sourceDigest !== capture.sourceDigest) throw new Error('Source digest changed: ' + job.id);
    const destination = join(output, 'media', job.id);
    mkdirSync(destination, { recursive: true });
    if (job.mode === 'model') for (const key of ['model', 'poster']) copyFileSync(join(modelDir, manifest[key]), join(destination, manifest[key]));
    copyFileSync(join(captureDir, capture.capture), join(destination, capture.capture));
    manifest.capture = capture.capture;
    manifest.captureSha = capture.captureSha;
    writeFileSync(join(destination, 'preview.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  writeFileSync(join(output, 'recipe.json'), JSON.stringify(jobs.map(job => ({ ...job, adaptation: adaptations[`${job.task}/${job.id}`] ?? {} })), null, 2) + '\n');
  console.log(`Media: ${models.length} models, ${jobs.length} captures. Output: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
