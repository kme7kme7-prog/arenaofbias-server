// Read-only artifact report. Does not initialize the service or write a database.
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { artifactStats, shouldCountArtifactFile } from '../server/artifact-stats.mjs';
import { isTextTask } from '../server/categories.mjs';

function contained(root, path) {
  const base = realpathSync(root), full = realpathSync(path), rel = relative(base, full);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact path escapes its root');
  return full;
}

export function readArtifactFiles(root) {
  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isSymbolicLink()) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        // Probe a text filename to reuse the exact directory exclusions before reading.
        if (shouldCountArtifactFile(path + '/probe.txt')) walk(join(dir, entry.name), path + '/');
      } else if (entry.isFile() && shouldCountArtifactFile(path)) files.push({ path, content: readFileSync(join(dir, entry.name)) });
    }
  }
  walk(root);
  return files;
}

export function artifactBackfill({ dist, works, database } = {}) {
  const artifacts = [], warnings = [];
  const tasks = new Map();
  const record = (work, root, kind, origin) => {
    try {
      if (lstatSync(root).isSymbolicLink()) throw new Error('Symbolic work roots are not scanned');
      const files = readArtifactFiles(root);
      const artifact = artifactStats(files, { kind });
      if (!artifact.files) warnings.push({ id: work.id, origin, reason: 'no-original-text-files' });
      else artifacts.push({ ...work, origin, artifact });
    } catch (error) {
      if (error.code === 'ENOENT') warnings.push({ id: work.id, origin, reason: 'missing-files' });
      else throw error;
    }
  };
  if (dist) {
    dist = resolve(dist);
    const data = JSON.parse(readFileSync(join(dist, 'data.json'), 'utf8'));
    for (const task of data.tasks) {
      tasks.set(task.id, task);
      for (const work of task.results) {
        if (!work.scene) { warnings.push({ id: work.id, origin: 'datapack', reason: 'missing-scene' }); continue; }
        try { record({ taskId: task.id, id: work.id }, contained(dist, join(dist, work.scene)), isTextTask(task) ? 'text' : 'code', 'datapack'); }
        catch (error) { if (error.code === 'ENOENT') warnings.push({ id: work.id, origin: 'datapack', reason: 'missing-files' }); else throw error; }
      }
    }
  }
  if (works) {
    works = resolve(works);
    if (database) {
      const db = new DatabaseSync(resolve(database), { readOnly: true });
      try {
        db.exec('BEGIN');
        for (const row of db.prepare('SELECT id, category, templates FROM questions').all()) tasks.set(row.id, { ...row, templates: JSON.parse(row.templates) });
        for (const row of db.prepare('SELECT id, task_id, checks FROM works WHERE deleted_at IS NULL').all()) {
          if (typeof row.id !== 'string' || !row.id || /[\\/]/.test(row.id) || ['.', '..'].includes(row.id)) {
            warnings.push({ id: row.id, origin: 'upload', reason: 'invalid-work-id' }); continue;
          }
          let path;
          try {
            const original = join(works, row.id);
            path = contained(works, original);
            if (lstatSync(original).isSymbolicLink()) {
              warnings.push({ id: row.id, origin: 'upload', reason: 'symbolic-work-root' }); continue;
            }
          } catch (error) {
            if (error.code === 'ENOENT') warnings.push({ id: row.id, origin: 'upload', reason: 'missing-files' });
            else warnings.push({ id: row.id, origin: 'upload', reason: 'outside-works-root' });
            continue;
          }
          const text = isTextTask(tasks.get(row.task_id)) || JSON.parse(row.checks).some(check => check.id === 'format' && check.template === 'text');
          record({ id: row.id, taskId: row.task_id }, path, text ? 'text' : 'code', 'upload');
        }
      } finally { db.close(); }
    } else {
      for (const entry of readdirSync(works, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.isDirectory()) record({ id: entry.name }, join(works, entry.name), 'code', 'upload');
      }
      warnings.push({ origin: 'upload', reason: 'no-database-task-and-kind-unknown' });
    }
  }
  return { artifacts, warnings };
}

export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { dist: { type: 'string' }, works: { type: 'string' }, database: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('node scripts/artifact-backfill.mjs [--dist DIR] [--works DIR [--database FILE]]\nRead-only; JSON to stdout.');
  if (!values.dist && !values.works) throw new Error('Specify --dist or --works');
  if (values.database && !values.works) throw new Error('--database requires --works');
  console.log(JSON.stringify(artifactBackfill(values), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error('产物回填失败：' + error.message); process.exitCode = 1; }
}
