import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every site, tooling, server, admin and test script, so new files are checked without editing package.json.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server', 'scripts', 'test', 'admin', 'tools/batch-upload'].filter(dir => existsSync(join(root, dir))).flatMap(dir => readdirSync(join(root, dir))
  .filter(name => /\.m?js$/.test(name)).map(name => `${dir}/${name}`));
let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }); }
  catch (error) { failed++; console.error(`ERROR ${file}\n${error.stderr}`); }
}
console.log(`Syntax check: ${files.length} file(s), ${failed} error(s).`);
process.exitCode = failed ? 1 : 0;
