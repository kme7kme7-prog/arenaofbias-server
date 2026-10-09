// Build private screenshot previews for explicitly selected public uploads.
// The original page is never opened; only its exact entry bytes are hashed.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const usage = 'Usage: node scripts/bake-upload-captures.mjs --bootstrap=<json> --source-dir=<dir> --capture-dir=<dir> --output-dir=<server/output dir> --id=<up-id>[,<up-id>...]';
const keys = ['bootstrap', 'source-dir', 'capture-dir', 'output-dir', 'id'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isUploadId = (id) => /^up-[a-z0-9]{8}$/.test(id);
const isPublicOrigin = (url) => url.protocol === 'https:' && !url.username && !url.password && !url.port &&
  /^w[0-9a-f]{32}\.w\.arenaofbias\.icu$/i.test(url.hostname);

export function parseOptions(args) {
  const values = {};
  for (const arg of args) {
    const equals = arg.indexOf('=');
    const key = equals > 2 ? arg.slice(2, equals) : '';
    if (!arg.startsWith('--') || !keys.includes(key) || Object.hasOwn(values, key)) throw new Error(usage);
    values[key] = arg.slice(equals + 1);
  }
  if (keys.some((key) => !values[key])) throw new Error(usage);
  const ids = values.id.split(',').map((id) => id.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('Pass a non-empty, unique comma-separated --id list.');
  return { ...values, ids };
}

export function prepareCaptureJob({ id, bootstrap, sourceRoot, captureRoot }) {
  if (!isUploadId(id)) throw new Error('Invalid upload id.');
  const work = bootstrap.works?.find((item) => item.id === id && item.status === 'verified' && item.scene);
  if (!work) throw new Error('No verified public bootstrap work found.');
  let scene;
  try { scene = new URL(work.scene); } catch { throw new Error('Work scene is not a public content URL.'); }
  if (!isPublicOrigin(scene)) throw new Error('Refusing a non-public work content origin.');

  const sourceDir = resolve(sourceRoot, id);
  const candidates = ['index.html', 'source.html', id + '.html'].map((name) => join(sourceDir, name));
  const sourcePath = candidates.find(existsSync);
  if (!sourcePath) throw new Error('Missing source HTML under source-dir/' + id + '.');
  const sourceBytes = readFileSync(sourcePath);
  if (!sourceBytes.length) throw new Error('Source HTML is empty.');

  const capturePath = join(resolve(captureRoot), id, 'first.jpg');
  const captureBytes = readFileSync(capturePath);
  if (captureBytes.length < 4 || captureBytes[0] !== 0xff || captureBytes[1] !== 0xd8) {
    throw new Error('first.jpg is empty or does not have a JPEG signature.');
  }
  return {
    id,
    task: work.task,
    sourcePath,
    sourceRelative: relative(resolve(sourceRoot), sourcePath),
    capturePath,
    captureRelative: relative(resolve(captureRoot), capturePath),
    sourceDigest: sha256(sourceBytes),
    originalCaptureSha: sha256(captureBytes),
    captureBytes,
  };
}

export function previewManifest(sourceDigest, captureBytes) {
  return {
    schemaVersion: 1,
    sourceDigest,
    mode: 'screenshot',
    capture: 'preview.jpg',
    captureSha: sha256(captureBytes),
  };
}

async function resizeCapture(page, bytes) {
  const result = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/jpeg;base64,' + base64;
    await image.decode();
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('Decoded image has zero dimensions.');
    const scale = Math.min(1, 720 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a 2D canvas.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob || !blob.size) throw new Error('JPEG encoding returned no image.');
    const decoded = await createImageBitmap(blob);
    const outputWidth = decoded.width;
    const outputHeight = decoded.height;
    decoded.close();
    if (outputWidth !== width || outputHeight !== height) throw new Error('Encoded image dimensions changed.');
    const data = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < data.length; offset += 0x8000) {
      binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
    }
    return { sourceWidth, sourceHeight, width, height, base64: btoa(binary) };
  }, bytes.toString('base64'));
  const capture = Buffer.from(result.base64, 'base64');
  if (capture.length < 4 || capture[0] !== 0xff || capture[1] !== 0xd8) throw new Error('Encoded output is not a JPEG.');
  return { capture, sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight,
    width: result.width, height: result.height };
}

function outputDirectory(path) {
  const output = resolve(path);
  const base = resolve(root, 'output');
  const fromBase = relative(base, output);
  if (fromBase === '..' || fromBase.startsWith('..' + sep) || isAbsolute(fromBase)) {
    throw new Error('Output must stay under the server output/ directory.');
  }
  return output;
}

async function run() {
  const options = parseOptions(process.argv.slice(2));
  if (!process.env.DATAPACK_SOURCE_DIR) throw new Error('Set DATAPACK_SOURCE_DIR to the local arenaofbias-data checkout for its Playwright runtime.');
  const bootstrap = JSON.parse(readFileSync(resolve(options.bootstrap), 'utf8'));
  const sourceRoot = resolve(options['source-dir']);
  const captureRoot = resolve(options['capture-dir']);
  const outputRoot = outputDirectory(options['output-dir']);
  mkdirSync(outputRoot, { recursive: true });

  const results = options.ids.map((id) => {
    try { return { status: 'pending', job: prepareCaptureJob({ id, bootstrap, sourceRoot, captureRoot }) }; }
    catch (error) { return { status: 'failed', id, error: error.message }; }
  });
  const ready = results.filter((item) => item.job);
  let browser;
  let page;
  if (ready.length) {
    try {
      const datapackRoot = resolve(process.env.DATAPACK_SOURCE_DIR);
      const requireFromDatapack = createRequire(join(datapackRoot, 'package.json'));
      const { chromium } = requireFromDatapack('playwright');
      browser = await chromium.launch();
      page = await browser.newPage();
    } catch (error) {
      for (const result of ready) {
        result.status = 'failed';
        result.id = result.job.id;
        result.error = 'Could not start the local Playwright browser: ' + error.message.split('\n')[0];
        delete result.job;
      }
    }
  }

  try {
    if (page) for (const result of ready) {
      const job = result.job;
      try {
        const resized = await resizeCapture(page, job.captureBytes);
        const manifest = previewManifest(job.sourceDigest, resized.capture);
        const directory = join(outputRoot, 'media', job.id);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'preview.jpg'), resized.capture);
        writeFileSync(join(directory, 'preview.json'), JSON.stringify(manifest, null, 2) + '\n');
        result.status = 'ready';
        result.id = job.id;
        result.task = job.task;
        result.source = job.sourceRelative;
        result.capture = job.captureRelative;
        result.sourceDigest = job.sourceDigest;
        result.originalCaptureSha = job.originalCaptureSha;
        result.captureSha = manifest.captureSha;
        result.sourceDimensions = [resized.sourceWidth, resized.sourceHeight];
        result.previewDimensions = [resized.width, resized.height];
        result.previewBytes = resized.capture.length;
        result.output = relative(outputRoot, directory);
        console.log(job.task + '/' + job.id + ': ' + resized.sourceWidth + 'x' + resized.sourceHeight + ' -> ' +
          resized.width + 'x' + resized.height + ', ' + Math.round(resized.capture.length / 1024) + ' KiB');
      } catch (error) {
        result.status = 'failed';
        result.id = job.id;
        result.error = error.message;
        delete result.job;
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  for (const result of results) if (result.status === 'failed') console.error(result.id + ': ' + result.error);
  for (const result of results) delete result.job;
  const summary = {
    createdAt: new Date().toISOString(),
    ready: results.filter((item) => item.status === 'ready').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
  writeFileSync(join(outputRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('Captures: ' + summary.ready + ' ready, ' + summary.failed + ' failed. Output: ' + outputRoot);
  if (summary.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
