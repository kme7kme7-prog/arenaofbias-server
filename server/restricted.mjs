// Restricted (gray) models. A work whose model key is listed in restricted_models exists
// only for senior admins: every other viewer, automation token included, must not be able
// to tell it apart from a work that was never uploaded. The registry is written by the CLI
// in its own process; PRAGMA data_version tells this connection about those commits.
import { modelNameKey } from './catalog.mjs';
import { isSenior } from './roles.mjs';

// dots automation acts through a senior account but never sees restricted works.
export const seesRestricted = (viewer) => Boolean(isSenior(viewer) && !viewer.automation);
// Internal reads (ballot scoring, senior boards, bearer previews) that must resolve every work.
export const ALL_WORKS = Object.freeze({ role: 'admin', internal: true });
// Restricted codes are free-text model names, so their key is always the `x:` form.
export const restrictedKeyOf = (code) => {
  const text = String(code ?? '').normalize('NFKC').trim().toLowerCase();
  return text.startsWith('x:') ? text : `x:${text}`;
};
// Same key as catalog.modelKey(), tolerant of DTOs and raw rows without a model name.
export const workModelKey = (work) => {
  if (!work) return null;
  if (typeof work.modelKey === 'string') return work.modelKey;
  const modelId = work.modelId !== undefined ? work.modelId : work.model_id;
  if (modelId) return modelId;
  const name = work.modelName !== undefined ? work.modelName : work.model_other;
  return name == null ? null : `x:${String(name).normalize('NFKC').trim().toLowerCase()}`;
};

// A code may not read like any registered model id, name or alias (compact comparison), or
// typed names would resolve to the public model instead of the restricted one.
export function catalogConflict(catalog, code) {
  const name = String(code ?? '').normalize('NFKC').trim().replace(/^x:/i, '');
  const compact = modelNameKey(name);
  return Boolean(!compact || catalog.model(name) || catalog.modelNamed(name)
    || catalog.models().some((model) => modelNameKey(model.id) === compact));
}

export function createRestricted(db) {
  const q = {
    list: db.prepare('SELECT model_key, label, created_at, created_by FROM restricted_models ORDER BY model_key'),
    add: db.prepare('INSERT INTO restricted_models (model_key, label, created_at, created_by) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM restricted_models WHERE model_key = ?'),
    version: db.prepare('PRAGMA data_version'),
  };
  let local = 0, stamp = null, fresh = false, keys = new Set(), names = new Map(), labels = new Map();
  // One registry check per synchronous batch; the next batch sees other processes' commits.
  function load() {
    if (fresh) return;
    const next = `${local}|${q.version.get().data_version}`;
    if (next !== stamp) {
      stamp = next;
      const rows = q.list.all();
      keys = new Set(rows.map((row) => row.model_key));
      names = new Map([...keys].map((key) => [modelNameKey(key.slice(2)), key]));
      labels = new Map(rows.map((row) => [row.model_key, restrictedKeyOf(row.label) === row.model_key ? row.label.normalize('NFKC').trim() : row.model_key.slice(2)]));
    }
    fresh = true;
    queueMicrotask(() => { fresh = false; });
  }
  const changed = () => { local++; fresh = false; };
  return {
    revision() { load(); return stamp; },
    keys() { load(); return new Set(keys); },
    hasKey(key) { load(); return keys.has(key); },
    isRestrictedWork(work) {
      if (!work) return false;
      load();
      return keys.size > 0 && keys.has(workModelKey(work));
    },
    // Hidden from this viewer: restricted and the viewer is not a senior person.
    hiddenFrom(work, viewer) { return !seesRestricted(viewer) && this.isRestrictedWork(work); },
    // The restricted key a typed model name claims (exactly or by compact name), or null.
    claims(name) {
      load();
      if (!keys.size || name == null || !String(name).trim()) return null;
      const key = restrictedKeyOf(name);
      return keys.has(key) ? key : names.get(modelNameKey(name)) ?? null;
    },
    // The stored model name for a key: the registered spelling (e.g. "Mix" for x:mix).
    displayName(key) { load(); return labels.get(key) ?? key.slice(2); },
    list() { return q.list.all(); },
    add(key, label = '', by = '') {
      q.add.run(key, label, Date.now(), by);
      changed();
    },
    remove(key) {
      const removed = q.remove.run(key).changes > 0;
      changed();
      return removed;
    },
  };
}
