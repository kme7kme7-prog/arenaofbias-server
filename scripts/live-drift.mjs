// Compare a live directory on the server with a git ref, file by file.
// Usage: node scripts/live-drift.mjs --host arena --live /www/wwwroot/arenaofbias-server [--repo .] [--ref origin/main]
//        [--prefix site/] [--exclude a,b/] [path ...]
// Given paths are walked recursively on the server. Without paths, every directory the ref has under <prefix>
// is listed one level deep (the root included), so files added next to tracked ones show up while directories
// that another source shares (e.g. a data package) are not walked. Excludes are exact paths, or prefixes ending in "/".
// Exit code 1 means the live files differ from the ref.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string' },
    live: { type: 'string' },
    repo: { type: 'string', default: '.' },
    ref: { type: 'string', default: 'origin/main' },
    prefix: { type: 'string', default: '' },
    exclude: { type: 'string', default: '' },
  },
});
if (!opts.host || !opts.live) throw new Error('--host and --live are required');
const prefix = opts.prefix && !opts.prefix.endsWith('/') ? `${opts.prefix}/` : opts.prefix;
const excludes = opts.exclude.split(',').filter(Boolean);
const excluded = (path) => excludes.some((rule) => (rule.endsWith('/') ? path.startsWith(rule) : path === rule));
const git = (...args) => execFileSync('git', ['-C', opts.repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const commit = git('rev-parse', `${opts.ref}^{commit}`).trim();
const paths = positionals;

const blob = (buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
const expected = new Map();
const tree = git('ls-tree', '-r', '-z', '--full-tree', commit, '--', ...(paths.length ? paths.map((path) => prefix + path) : [prefix || '.']));
for (const entry of tree.split('\0').filter(Boolean)) {
  const [meta, path] = entry.split('\t');
  const [mode, type, sha] = meta.split(' ');
  if (type !== 'blob' || mode === '120000') continue;
  const rel = path.slice(prefix.length);
  if (!excluded(rel)) expected.set(rel, sha);
}
const dirs = paths.length ? [] : [...new Set([...expected.keys()].map((path) => path.split('/').slice(0, -1).join('/')))];

// Runs on the server with its own Node; prints [path, raw blob id, blob id without CR] for each file.
const remote = String.raw`
const { lstatSync, readdirSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const [root, json] = process.argv.slice(2);
const { paths, dirs } = JSON.parse(json);
const skip = new Set(['node_modules', '.git', '.data', '.datapack']);
const blob = (b) => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const out = [];
const seen = new Set();
const visit = (rel, deep = true) => {
  if (seen.has(rel)) return;
  let stat;
  try { stat = lstatSync(join(root, rel)); } catch { return; }
  if (stat.isDirectory()) {
    if (!deep) return;
    for (const name of readdirSync(join(root, rel)).sort()) if (!skip.has(name)) visit(rel ? rel + '/' + name : name);
  } else if (stat.isFile()) {
    seen.add(rel);
    const data = readFileSync(join(root, rel));
    out.push([rel, blob(data), blob(Buffer.from(data.toString('latin1').replace(/\r/g, ''), 'latin1'))]);
  }
};
for (const path of paths) visit(path);
for (const dir of dirs) {
  let names = [];
  try { names = readdirSync(join(root, dir)); } catch {}
  for (const name of names) visit(dir ? dir + '/' + name : name, false);
}
process.stdout.write(JSON.stringify(out));
`;
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const listing = JSON.parse(execFileSync('ssh', [opts.host, `node - ${quote(opts.live)} ${quote(JSON.stringify({ paths, dirs }))}`],
  { input: remote, encoding: 'utf8', maxBuffer: 1 << 28 }));

const groups = { differs: [], crlf: [], onlyLive: [], onlyGit: [] };
const live = new Map(listing.filter(([path]) => !excluded(path)).map(([path, raw, lf]) => [path, { raw, lf }]));
for (const [path, { raw, lf }] of live) {
  const sha = expected.get(path);
  if (!sha) groups.onlyLive.push(path);
  else if (sha === raw) continue;
  else if (sha === lf) groups.crlf.push(path);
  else groups.differs.push(path);
}
for (const path of expected.keys()) if (!live.has(path)) groups.onlyGit.push(path);

const labels = { differs: 'Differs from git', crlf: 'Only line endings differ', onlyLive: 'Only on the server', onlyGit: 'Only in git (not deployed)' };
for (const [key, list] of Object.entries(groups)) {
  if (!list.length) continue;
  console.log(`${labels[key]} (${list.length}):`);
  for (const path of list.sort()) console.log(`  ${path}`);
}
const drift = groups.differs.length + groups.onlyLive.length + groups.onlyGit.length;
console.log(JSON.stringify({ ref: opts.ref, commit, live: `${opts.host}:${opts.live}`, files: live.size, same: live.size - groups.differs.length - groups.crlf.length - groups.onlyLive.length,
  differs: groups.differs.length, crlfOnly: groups.crlf.length, onlyLive: groups.onlyLive.length, onlyGit: groups.onlyGit.length }));
process.exitCode = drift ? 1 : 0;
