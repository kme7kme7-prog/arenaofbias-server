// Curated archive snapshots are bound to the real directory behind DIST_DIR.
// Deployments keep each published directory immutable while matches use it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './http.mjs';
import { generationOf } from './generation.mjs';

export const effortKey = (effort) => String(effort ?? '').normalize('NFKC').trim().toLowerCase();
export const modelKey = (work) => work.modelId ?? `x:${work.modelName.normalize('NFKC').trim().toLowerCase()}`;
export const entityKey = (work, by = 'config') => (by === 'model' ? modelKey(work) : `${modelKey(work)}|${effortKey(work.effort)}`);

function readSnapshot(root) {
  const file = join(root, 'data.json');
  if (!existsSync(file)) throw new Error(`找不到 ${file}。请先部署数据包。`);
  const raw = readFileSync(file);
  const data = JSON.parse(raw.toString('utf8'));
  const catalogDigest = createHash('sha256').update(raw).digest('hex');
  const sourceFile = join(root, '.datapack-source.json');
  const source = existsSync(sourceFile) ? JSON.parse(readFileSync(sourceFile, 'utf8')) : null;
  if ((data.schemaVersion ?? 1) !== 1) throw new Error(`${file} 的 schemaVersion 不受支持`);
  if (data.sourceCommit != null && !/^[0-9a-f]{40}$/i.test(data.sourceCommit)) throw new Error(`${file} 的 sourceCommit 无效`);
  if (source?.source === 'github' && (typeof source.repo !== 'string' || !/^[0-9a-f]{40}$/i.test(source.commit))) {
    throw new Error(`${sourceFile} 的来源信息无效`);
  }
  const commit = source?.source === 'github' ? source.commit : null;
  const version = commit ? `${root}|${commit}` : `${root}|dev:${catalogDigest}`;
  const models = new Map(data.models.map((model) => [model.id, model]));
  const harnesses = new Map((data.harnesses ?? []).map((item) => [item.id, item]));
  const providers = new Map((data.providers ?? []).map((item) => [item.id, item]));
  const tasks = new Map(data.tasks.map((task) => [task.id, {
    id: task.id, title: task.title, acceptsUploads: !task.promptPending,
    works: new Map(task.results.map((result) => {
      const model = models.get(result.model);
      return [result.id, {
        taskId: task.id, id: result.id, curated: true, status: 'verified', sourceUpload: result.sourceUpload ?? null,
        sourceDigest: result.sourceDigest ?? null,
        title: result.title, summary: result.summary ?? '', modelId: result.model,
        modelName: model?.name ?? result.model, vendor: model?.vendor ?? '',
        effort: result.effort ?? '', tool: result.sourceLabel ?? '', ownerId: null,
        harnessId: result.harness ?? null, harnessOther: '', harnessVersion: result.harnessVersion ?? '',
        providerId: result.provider ?? null, providerOther: '',
        ...generationOf(result),
        scene: result.scene, dir: result.scene ? join(root, result.scene) : null,
        cover: Object.values(result.captures ?? {})[0] ?? result.gallery?.[0]?.src ?? null,
      }];
    })),
  }]));
  // Entry-page digests identify the exact curated content a vote saw; computed once per work.
  const entryDigests = new Map();
  const entryDigest = (work) => {
    const key = `${work.taskId}/${work.id}`;
    if (!entryDigests.has(key)) {
      const entry = work.dir && join(work.dir, 'index.html');
      entryDigests.set(key, entry && existsSync(entry) ? createHash('sha256').update(readFileSync(entry)).digest('hex') : null);
    }
    return entryDigests.get(key);
  };
  let digests;
  return {
    root, version, commit, catalogDigest, schemaVersion: data.schemaVersion ?? 1,
    title: data.title,
    task(id) { return tasks.get(id) ?? null; },
    tasks() { return [...tasks.values()]; },
    tags() { return [...new Set(data.tasks.flatMap((task) => task.tags ?? []))]; },
    model(id) { return models.get(id) ?? null; },
    models() { return [...models.values()]; },
    harness(id) { return harnesses.get(id) ?? null; },
    harnesses() { return [...harnesses.values()]; },
    provider(id) { return providers.get(id) ?? null; },
    providers() { return [...providers.values()]; },
    work(taskId, id) { return tasks.get(taskId)?.works.get(id) ?? null; },
    works(taskId) { return [...(tasks.get(taskId)?.works.values() ?? [])]; },
    entryDigest,
    duplicateOf(digest) {
      if (!digests) {
        digests = new Map();
        for (const task of tasks.values()) for (const work of task.works.values()) {
          const value = entryDigest(work);
          if (value) digests.set(value, work);
        }
      }
      return digests.get(digest) ?? null;
    },
  };
}

export function createCatalog(dist, questions = null) {
  let current = null;
  let onChange = null;
  const handledRevisions = new Set();
  const queuedRevisions = new Set();
  const snapshots = new Map();
  let devStat = '', devRevision = '';
  function scheduleTakeover(snapshot) {
    if (!onChange || handledRevisions.has(snapshot.revision) || queuedRevisions.has(snapshot.revision)) return;
    queuedRevisions.add(snapshot.revision);
    setImmediate(() => {
      try {
        onChange(snapshot);
        handledRevisions.add(snapshot.revision);
      } catch (error) {
        console.error(`Catalog takeover failed for ${snapshot.revision}; will retry on refresh`, error);
      } finally {
        queuedRevisions.delete(snapshot.revision);
      }
    });
  }
  function refresh() {
    const root = realpathSync(dist);
    const sourceFile = join(root, '.datapack-source.json');
    const source = existsSync(sourceFile) ? JSON.parse(readFileSync(sourceFile, 'utf8')) : null;
    // A versioned directory is immutable. Unversioned development data is hashed so edits
    // are observed even when data.json's mtime is unchanged; ctime changes on every write,
    // so the hash is only recomputed when the file's stat changes.
    let revision;
    if (source?.source === 'github') revision = `${source.repo}|${source.commit}`;
    else {
      const file = join(root, 'data.json');
      const stat = statSync(file);
      const key = `${file}|${stat.ino}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}`;
      if (key !== devStat) {
        devStat = key;
        devRevision = `dev:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
      }
      revision = devRevision;
    }
    if (!current || current.root !== root || current.revision !== revision) {
      const snapshot = readSnapshot(root);
      snapshot.revision = revision;
      current = snapshot;
      snapshots.set(root, snapshot);
      // Pruned release directories no longer serve anything; drop their snapshots.
      for (const key of snapshots.keys()) if (key !== root && !existsSync(join(key, 'data.json'))) snapshots.delete(key);
    }
    scheduleTakeover(current);
    return current;
  }
  return {
    onChange(callback) { onChange = callback; scheduleTakeover(refresh()); },
    refresh, snapshot: refresh,
    // The package a match was created with. A match without one, or whose release has been
    // pruned, can no longer be served or scored.
    at(root) {
      if (!root || !existsSync(join(root, 'data.json'))) {
        if (root) snapshots.delete(root);
        fail(410, '这一组已经失效，请开始新的一组');
      }
      if (!snapshots.has(root)) snapshots.set(root, readSnapshot(root));
      return snapshots.get(root);
    },
    get version() { return refresh().version; },
    get datapack() { return refresh().commit; },
    get catalogDigest() { return refresh().catalogDigest; },
    get title() { return refresh().title; },
    task(id) { return refresh().task(id) ?? (questions?.get(id) ? { ...questions.get(id), acceptsUploads: true, works: new Map() } : null); },
    tasks() { return [...refresh().tasks(), ...(questions?.all() ?? []).map((question) => ({ ...question, acceptsUploads: true, works: new Map() }))]; },
    tags() { return [...new Set([...refresh().tags(), ...(questions?.all() ?? []).flatMap((task) => task.tags ?? [])])]; },
    model(id) { return refresh().model(id); },
    models() { return refresh().models(); },
    harness(id) { return refresh().harness(id); },
    harnesses() { return refresh().harnesses(); },
    provider(id) { return refresh().provider(id); },
    providers() { return refresh().providers(); },
    work(taskId, id) { return refresh().work(taskId, id); },
    works(taskId) { return refresh().works(taskId); },
    duplicateOf(digest) { return refresh().duplicateOf(digest); },
  };
}
