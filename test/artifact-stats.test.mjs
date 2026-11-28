import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { artifactStats, countArtifactTokens, shouldCountArtifactFile } from '../server/artifact-stats.mjs';
import { artifactBackfill } from '../scripts/artifact-backfill.mjs';

const file = (path, content = 'hello\n') => ({ path, content });
test('artifact skips locks, build trees, libraries, media and explicitly marked files', () => {
  const skipped = ['package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'node_modules/a/index.js', 'src/vendor/a.js', 'dist/index.html',
    'build/a.js', '.git/config.json', '.next/a.js', 'out/a.js', 'coverage/a.json', 'three.module.js', 'react-dom.min.js', 'app.bundle.js',
    'image.svg', 'picture.png', 'font.woff2', 'app.js.map', '../outside.js', '/absolute.js', 'a/../b.js', 'node_modules\\a\\index.js'];
  for (const path of skipped) assert.equal(shouldCountArtifactFile(path), false, path);
  assert.equal(artifactStats([...skipped.map(p => file(p)), { ...file('a.js'), generated: true }, { ...file('b.js'), vendor: true }]).files, 0);
  assert.equal(shouldCountArtifactFile('src/lib/mine.ts'), true);
});
test('artifact counts original UTF-8 bytes and physical lines, including empty and CRLF files', () => {
  const a = '你好\r\nx\r\ny\r';
  const result = artifactStats([file('src/a.js', Buffer.from(a)), file('empty.txt', ''), file('no-newline.txt', 'x')]);
  assert.equal(result.files, 3); assert.equal(result.lines, 4);
  assert.equal(result.bytes, Buffer.byteLength(a) + 1);
  assert.equal(result.approximate, true); assert.equal(result.tokenizer, 'utf8-pretoken-4-v1');
});
test('writing counts nonwhitespace codepoints and skips the generated HTML reader', () => {
  assert.deepEqual(artifactStats([file('original.md', '中 文😀!\r\n'), file('index.html', '<main>中 文😀!</main>')], { kind: 'text' }),
    { files: 1, lines: 1, bytes: Buffer.byteLength('中 文😀!\r\n'), chars: 4 });
});
test('invalid text and binary are excluded; duplicate paths and unsupported kinds reject', () => {
  assert.equal(artifactStats([file('a.js', Uint8Array.of(0xff)), file('b.txt', 'a\0b')]).files, 0);
  assert.throws(() => artifactStats([file('a.js'), file('a.js')]), /Duplicate/);
  assert.throws(() => artifactStats([], { kind: 'unknown' }), /kind/);
});
test('approximate tokenizer is deterministic across order, byte/string input, empty and Unicode samples', () => {
  assert.equal(countArtifactTokens(''), 0);
  for (const text of ['Hello, world!', '你好，世界！', 'const x = 123456;', '😀\n\n']) {
    assert.equal(countArtifactTokens(text), countArtifactTokens(text));
    assert.equal(artifactStats([file('a.js', text)]).tokens, artifactStats([file('a.js', Buffer.from(text))]).tokens);
  }
  assert.equal(countArtifactTokens('hello'), 2);
  const files = [file('a.js', 'a'), file('b.js', '你好')];
  assert.deepEqual(artifactStats(files), artifactStats(files.toReversed()));
});
test('backfill reports package and stored uploads without changing source bytes or database', t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist'), works = join(root, 'works');
  for (const p of [join(dist, 'task/work'), join(works, 'up-a/src'), join(works, 'up-a/dist'), join(works, 'up-text')]) mkdirSync(p, { recursive: true });
  writeFileSync(join(dist, 'data.json'), JSON.stringify({ tasks: [{ id: 't', category: '建模', results: [{ id: 'a', scene: 'task/work' }, { id: 'missing', scene: 'gone' }] }] }));
  writeFileSync(join(dist, 'task/work/index.html'), 'hi');
  writeFileSync(join(works, 'up-a/src/app.js'), 'const x = 1;'); writeFileSync(join(works, 'up-a/dist/index.html'), 'compiled');
  writeFileSync(join(works, 'up-text/original.txt'), '你好!'); writeFileSync(join(works, 'up-text/index.html'), 'viewer');
  symlinkSync(join(dist, 'task/work/index.html'), join(works, 'up-a/src/symlink.js'));
  const database = join(root, 'platform.db'), db = new DatabaseSync(database);
  db.exec(`CREATE TABLE works(id TEXT, task_id TEXT, checks TEXT, deleted_at INTEGER); CREATE TABLE questions(id TEXT,category TEXT,templates TEXT);
    INSERT INTO works VALUES ('up-a','t','[]',NULL),('up-text','writing','[]',NULL);
    INSERT INTO questions VALUES ('writing','文学','["text"]');`); db.close();
  const original = readFileSync(database);
  const report = artifactBackfill({ dist, works, database });
  assert.equal(report.artifacts.length, 3); assert.deepEqual(readFileSync(database), original);
  assert.equal(report.artifacts.find(w => w.id === 'up-a').artifact.files, 1);
  assert.equal(report.artifacts.find(w => w.id === 'up-text').artifact.chars, 3);
  assert.equal(report.warnings[0].reason, 'missing-files');
  const cli = spawnSync(process.execPath, ['scripts/artifact-backfill.mjs', '--dist', dist, '--works', works, '--database', database], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), report);
});
test('directory-only report states missing task metadata and never follows symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-dir-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'work')); writeFileSync(join(root, 'work/a.txt'), 'x'); symlinkSync(join(root, 'work'), join(root, 'linked'));
  const report = artifactBackfill({ works: root });
  assert.equal(report.artifacts.length, 1); assert.equal(report.warnings.at(-1).reason, 'no-database-task-and-kind-unknown');
});

test('upload ids cannot traverse nested symlinks or escape the real works root', t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-escape-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const works=join(root,'works'), outside=join(root,'outside'); mkdirSync(works); mkdirSync(join(outside,'nested'),{recursive:true});
  writeFileSync(join(outside,'nested/private.txt'),'SYNTHETIC SENTINEL');
  symlinkSync(outside,join(works,'alias')); symlinkSync(join(outside,'nested'),join(works,'direct'));
  mkdirSync(join(works,'real'));writeFileSync(join(works,'real','own.txt'),'SYNTHETIC OTHER WORK');symlinkSync(join(works,'real'),join(works,'internal'));
  const database=join(root,'db'),db=new DatabaseSync(database);
  db.exec(`CREATE TABLE works(id TEXT,task_id TEXT,checks TEXT,deleted_at INTEGER); CREATE TABLE questions(id TEXT,category TEXT,templates TEXT);
    INSERT INTO works VALUES ('alias/nested','t','[]',NULL),('alias\\nested','t','[]',NULL),('direct','t','[]',NULL),('internal','t','[]',NULL);`);db.close();
  const result=artifactBackfill({works,database}); assert.equal(result.artifacts.length,0);
  assert.equal(result.warnings.filter(w=>w.reason==='invalid-work-id').length,2);
  assert.equal(result.warnings.filter(w=>w.reason==='outside-works-root').length,1);
  assert.equal(result.warnings.filter(w=>w.reason==='symbolic-work-root').length,1);
});
