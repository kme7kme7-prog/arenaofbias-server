// Raw administrator measurements and official-price records. No cost calculations or network reads.
import { fail } from './http.mjs';
import { isStaff, isSenior } from './roles.mjs';

const NUMBERS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'requests', 'durationSec'];
const COLUMNS = ['input', 'cache_read', 'cache_write', 'output', 'reasoning', 'requests', 'duration_sec'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const iso = value => value == null ? null : new Date(value).toISOString();
const present = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value != null));
const actor = (id, name) => id == null && !name ? null : { id: id ?? null, name: name ?? null };
const usageOf = row => row && present({ ...Object.fromEntries(NUMBERS.map((name, i) => [name, row[COLUMNS[i]]])),
  source: row.source, paid: row.paid ? JSON.parse(row.paid) : null });

export function validateUsage(body) {
  const invalid = () => fail(400, '用量字段无效，请填写非负数字及来源', 'invalid_usage');
  if (!plain(body) || Object.keys(body).some(key => ![...NUMBERS, 'source', 'paid'].includes(key))
    || !['api', 'harness', 'bill', 'log'].includes(body.source)) invalid();
  for (const name of NUMBERS) if (body[name] != null && (!finite(body[name]) || (name !== 'durationSec' && !Number.isSafeInteger(body[name])))) invalid();
  if (!NUMBERS.some(name => body[name] != null) && body.paid == null) invalid();
  if (body.reasoning != null && body.output != null && body.reasoning > body.output) invalid();
  if (body.paid != null && (!plain(body.paid) || Object.keys(body.paid).some(key => !['basis','amount','currency'].includes(key))
    || !['api','subscription','credits','reseller'].includes(body.paid.basis)
    || (body.paid.amount != null && (!finite(body.paid.amount) || !currency(body.paid.currency)))
    || (body.paid.currency != null && !currency(body.paid.currency)))) invalid();
  return present({ ...Object.fromEntries(NUMBERS.map(key => [key, body[key]])), source: body.source,
    paid: body.paid == null ? null : present({ basis: body.paid.basis, amount: body.paid.amount, currency: body.paid.currency }) });
}

export function createWorkMetrics(db, { showCost = false } = {}) {
  const usage = db.prepare('SELECT * FROM work_usage WHERE task_id=? AND work_id=?');
  const artifact = db.prepare('SELECT artifact FROM work_artifacts WHERE task_id=? AND work_id=?');
  return (work) => {
    const raw = usage.get(work.taskId, work.id), measured = artifact.get(work.taskId, work.id);
    const visible = usageOf(raw);
    if (visible?.paid && !showCost) visible.paid = { basis: visible.paid.basis };
    return { ...(raw ? { usage: visible } : {}), ...(measured ? { artifact: JSON.parse(measured.artifact) } : {}) };
  };
}

// Internal entry point for the artifact backfill CLI; there is no public writer.
export function validateArtifact(artifact) {
  if (!plain(artifact)
    || !['files','lines','bytes'].every(key => Number.isSafeInteger(artifact[key]) && artifact[key] >= 0)
    || Object.entries(artifact).some(([key,value]) => {
      if (['files','lines','bytes','tokens','chars'].includes(key)) return !Number.isSafeInteger(value) || value < 0;
      if (key === 'tokenizer') return typeof value !== 'string';
      if (key === 'approximate') return typeof value !== 'boolean';
      return true;
    })) throw new Error('Invalid artifact measurement');
  return artifact;
}

export function putArtifact(db, { task, work, artifact }) {
  if (!task || !work) throw new Error('Missing artifact work identity');
  validateArtifact(artifact);
  db.prepare(`INSERT INTO work_artifacts (task_id,work_id,artifact,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(task_id,work_id) DO UPDATE SET artifact=excluded.artifact,updated_at=excluded.updated_at`)
    .run(task, work, JSON.stringify(artifact), Date.now());
}

export function createUsageService({ db, catalog, library, showCost = false }) {
  const measured = db.prepare(`SELECT u.*, COALESCE(c.name,u.created_name) AS creator_name, COALESCE(e.name,u.updated_name) AS editor_name FROM work_usage u
    LEFT JOIN users c ON c.id=u.created_by LEFT JOIN users e ON e.id=u.updated_by WHERE task_id=? AND work_id=?`);
  const metadata = row => ({ createdBy: actor(row.created_by, row.creator_name), updatedBy: actor(row.updated_by, row.editor_name),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  const prices = db.prepare(`SELECT p.*, c.name AS creator_name, e.name AS editor_name FROM model_prices p
    LEFT JOIN users c ON c.id=p.created_by LEFT JOIN users e ON e.id=p.updated_by ORDER BY model_id,since`);
  const meta = db.prepare(`SELECT p.*, e.name AS editor_name FROM pricing_meta p LEFT JOIN users e ON e.id=p.updated_by WHERE p.id=1`);
  const staff = user => { if (!isStaff(user)) fail(403, '仅管理员可以维护用量'); };
  const senior = user => { if (!isSenior(user)) fail(403, '仅高级管理员可以维护价格'); };
  const workFor = (user, task, id) => {
    staff(user);
    const work = library.work(task, id, null, user);
    if (!work) fail(404, '作品不存在', 'not_found');
    return work;
  };
  const audit = (user, action, task = null, work = null) => db.prepare(`INSERT INTO audit (at,actor_id,actor_name,action,task_id,work_id,detail) VALUES (?,?,?,?,?,?,?)`)
    .run(Date.now(), user.id, user.name ?? '', action, task, work, '');
  const priceOf = row => present({ since: row.since, currency: row.currency, input: row.input, output: row.output,
    cacheRead: row.cache_read, cacheWrite: row.cache_write, url: row.url });
  function pricing(admin = false) {
    if (!admin && !showCost) return { showCost: false };
    const rows = prices.all(), info = meta.get();
    const models = {};
    for (const row of rows) (models[row.model_id] ??= []).push(priceOf(row));
    return { showCost, asOf: info?.as_of ?? null, fxAsOf: info?.fx_as_of ?? null, fx: admin || showCost ? JSON.parse(info?.fx ?? '{}') : {}, models: admin || showCost ? models : {},
      ...(admin ? { entries: rows.map(row => ({ model: row.model_id, ...priceOf(row), ...metadata(row) })),
        updatedBy: actor(info?.updated_by, info?.editor_name), updatedAt: iso(info?.updated_at) } : {}) };
  }
  return {
    pricing,
    adminPricing(user) { senior(user); return pricing(true); },
    getUsage(user, task, id) {
      workFor(user, task, id);
      const row = measured.get(task, id);
      return { task, id, usage: row ? { ...usageOf(row), ...metadata(row) } : null };
    },
    saveUsage(user, task, id, body) {
      workFor(user, task, id);
      body = validateUsage(body);
      const now = Date.now();
      db.prepare(`INSERT INTO work_usage (task_id,work_id,${COLUMNS.join(',')},paid,source,created_by,updated_by,created_at,updated_at,created_name,updated_name)
        VALUES (${Array(17).fill('?').join(',')}) ON CONFLICT(task_id,work_id) DO UPDATE SET
        ${COLUMNS.map(name => `${name}=excluded.${name}`).join(',')},paid=excluded.paid,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at,updated_name=excluded.updated_name`)
        .run(task, id, ...NUMBERS.map(name => body[name] ?? null), body.paid == null ? null : JSON.stringify(present(body.paid)), body.source, user.id ?? null, user.id ?? null, now, now, user.name ?? '导入', user.name ?? '导入');
      audit(user, 'usage-save', task, id);
      return this.getUsage(user, task, id);
    },
    deleteUsage(user, task, id) {
      workFor(user, task, id);
      db.prepare('DELETE FROM work_usage WHERE task_id=? AND work_id=?').run(task, id);
      audit(user, 'usage-delete', task, id);
      return { ok: true };
    },
    savePrice(user, model, since, body) {
      senior(user);
      const invalid = () => fail(400, '价格字段无效，请填写模型、有效日期、币种、基础单价与官方价格页', 'invalid_price');
      if (!catalog.snapshot().model(model) || !date(since) || !plain(body)
        || Object.keys(body).some(key => !['currency','input','output','cacheRead','cacheWrite','url'].includes(key))
        || !currency(body.currency) || !finite(body.input) || !finite(body.output)
        || ['cacheRead','cacheWrite'].some(key => body[key] != null && !finite(body[key]))) invalid();
      try { if (!['http:', 'https:'].includes(new URL(body.url).protocol)) invalid(); } catch { invalid(); }
      const now = Date.now();
      db.prepare(`INSERT INTO model_prices (model_id,since,currency,input,output,cache_read,cache_write,url,created_by,updated_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,since) DO UPDATE SET currency=excluded.currency,input=excluded.input,
        output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,url=excluded.url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(model, since, body.currency, body.input, body.output, body.cacheRead ?? null, body.cacheWrite ?? null, body.url, user.id, user.id, now, now);
      audit(user, 'price-save');
      return pricing(true);
    },
    deletePrice(user, model, since) {
      senior(user);
      db.prepare('DELETE FROM model_prices WHERE model_id=? AND since=?').run(model, since);
      audit(user, 'price-delete');
      return { ok: true };
    },
    saveMeta(user, body) {
      senior(user);
      if (!plain(body) || Object.keys(body).some(key => !['asOf','fxAsOf','fx'].includes(key))
        || (body.asOf != null && !date(body.asOf)) || (body.fxAsOf != null && !date(body.fxAsOf)) || !plain(body.fx)
        || Object.entries(body.fx).some(([key, value]) => !currency(key) || !finite(value) || value <= 0 || (key === 'CNY' && value !== 1))
        || (Object.keys(body.fx).length && !date(body.fxAsOf))) fail(400, '价格表日期或汇率无效', 'invalid_pricing_meta');
      db.prepare(`INSERT INTO pricing_meta (id,as_of,fx_as_of,fx,updated_by,updated_at) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET as_of=excluded.as_of,fx_as_of=excluded.fx_as_of,fx=excluded.fx,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(body.asOf ?? null, body.fxAsOf ?? null, JSON.stringify(body.fx), user.id, Date.now());
      audit(user, 'pricing-meta-save');
      return pricing(true);
    },
    deleteMeta(user) { senior(user); db.prepare('DELETE FROM pricing_meta WHERE id=1').run(); audit(user, 'pricing-meta-delete'); return { ok: true }; },
  };
}
