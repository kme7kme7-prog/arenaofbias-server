import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, data: { type: 'string' }, gallery: { type: 'string' },
  output: { type: 'string' }, port: { type: 'string', default: '5363' },
} });
for (const name of ['source', 'data', 'gallery', 'output']) {
  if (!values[name]) throw new Error(`Missing --${name} directory`);
}
const preview = fileURLToPath(new URL('.', import.meta.url));
const roots = [
  ['/original/', resolve(values.source)],
  ['/__bake/', join(resolve(values.data), 'scripts', 'baker')],
  ['/__gallery/', join(resolve(values.gallery), 'site')],
  ['/vendor/addons/', join(resolve(values.data), 'node_modules', 'three', 'examples', 'jsm')],
  ['/vendor/', join(resolve(values.data), 'node_modules', 'three', 'build')],
];
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.sbox': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/__save/model.sbox' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      await writeFile(join(output, 'classical-garden-fountain.sbox'), buffer);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ saved: true, bytes: buffer.length }));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    let path;
    if (pathname === '/' || pathname === '/index.html') path = join(preview, 'index.html');
    else if (pathname === '/__bake/datapack-bridge.js') path = join(resolve(values.data), 'scripts', 'datapack-bridge.js');
    else if (pathname === '/model.sbox') path = join(output, 'classical-garden-fountain.sbox');
    else {
      const route = roots.find(([prefix]) => pathname.startsWith(prefix));
      if (!route) { res.writeHead(404); res.end(); return; }
      path = resolve(route[1], pathname.slice(route[0].length));
      if (!path.startsWith(route[1] + sep)) { res.writeHead(404); res.end(); return; }
    }
    const bytes = await readFile(path);
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    res.end(bytes);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end(error.code === 'ENOENT' ? 'Not found' : String(error));
  }
});
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`PREVIEW_URL=http://127.0.0.1:${values.port}/`);
});
