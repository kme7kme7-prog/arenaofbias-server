import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertSameOrigin, fail, readJson } from '../http.mjs';
import { GUESS_MODELS, VENDOR_REGION, dayNumber, guessDayKey, modelById, registerExtraModels, validateExtraModels } from './guess-logic.mjs';

// Append-only server data, independent of the checked-in base catalogue.
export function registerGuessAdmin(router, { db, config, adminOnly, limit, adminOn, adminJson }) {
  if (!config?.dataDir || !adminOnly) return;
  const on = adminOn ?? ((...args) => router.on(...args));
  const json = adminJson ?? ((ctx, bytes) => readJson(ctx.req, bytes));
  const file = join(config.dataDir, 'guess-models-extra.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { models: [], vendorRegions: {} };
  // The process owns one catalogue. Re-registering an application in tests is idempotent.
  const extras = new Set(saved.models.map(m => m.id));
  const fresh = saved.models.filter(m => !modelById.has(m.id));
  if (fresh.length) registerExtraModels({ ...saved, models: fresh });
  const gate = ctx => { const user = adminOnly(ctx); limit?.write?.(user.id); return user; };
  on('GET', '/api/admin/guess/stats', ctx => {
    gate(ctx);
    const summary = where => db.prepare(`SELECT COUNT(*) AS played, COALESCE(SUM(won),0) AS won,
      ROUND(AVG(CASE WHEN won=1 THEN attempts END),1) AS avgSteps FROM guess_results WHERE superseded=0 ${where}`).get();
    return {
      day: guessDayKey(), totals: summary(''), today: summary(`AND day_key='${guessDayKey()}'`),
      byDifficulty: db.prepare(`SELECT difficulty,COUNT(*) AS played,COALESCE(SUM(won),0) AS won,
        ROUND(AVG(CASE WHEN won=1 THEN attempts END),1) AS avgSteps FROM guess_results WHERE superseded=0 GROUP BY difficulty ORDER BY difficulty`).all(),
      byDay: db.prepare(`SELECT day_key AS day,COUNT(*) AS played,COALESCE(SUM(won),0) AS won FROM guess_results
        WHERE superseded=0 GROUP BY day_key ORDER BY day_key DESC LIMIT 14`).all(),
      byModel: db.prepare(`SELECT answer_id AS id,COUNT(*) AS times,COALESCE(SUM(won),0) AS won,
        ROUND(AVG(CASE WHEN won=1 THEN attempts END),1) AS avgSteps FROM guess_results WHERE superseded=0
        GROUP BY answer_id ORDER BY times DESC,id`).all().map(row => ({ ...row, name: modelById.get(row.id)?.name ?? row.id })),
    };
  });
  on('GET', '/api/admin/guess/models', ctx => {
    gate(ctx);
    return { total: GUESS_MODELS.length, extraCount: extras.size,
      vendors: Object.entries(VENDOR_REGION).map(([org, region]) => ({ org, region })),
      models: GUESS_MODELS.map(m => ({ id: m.id, name: m.name, vendor: m.vendor, released: m.released,
        difficulty: m.difficulty, answerEligible: m.answerEligible, dailyEligible: m.dailyEligible, extra: extras.has(m.id) })),
    };
  });
  on('POST', '/api/admin/guess/models', async ctx => {
    gate(ctx);
    if (!ctx.reauthorize) assertSameOrigin(ctx.req, config);
    const body = await json(ctx, 8192);
    const keys = ['name','id','org','region','year','month','difficulty','popularity','contextK','priceOut','openWeights','reasoning','modalities','dailyEligible'];
    if (Object.keys(body).some(k => !keys.includes(k))) fail(400, '模型字段无效');
    if (saved.models.length >= 2000) fail(409, '增量题库已满，请整理主题库');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const org = typeof body.org === 'string' ? body.org.trim() : '';
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const number = v => v === '' || v === null || v === undefined ? null : Number(v);
    const entry = { id, name, org, year: Number(body.year), month: Number(body.month), difficulty: Number(body.difficulty),
      popularity: Number(body.popularity), contextK: number(body.contextK), priceOut: number(body.priceOut),
      openWeights: body.openWeights, reasoning: body.reasoning, dailyEligible: body.dailyEligible ?? false,
      modality: Array.isArray(body.modalities) ? body.modalities.join('+') : '', sinceDay: dayNumber() + 1 };
    const vendorRegions = Object.hasOwn(VENDOR_REGION, org) ? {} : { [org]: typeof body.region === 'string' ? body.region.trim().toUpperCase() : '' };
    try { validateExtraModels({ models: [entry], vendorRegions }); }
    catch (error) { fail(400, error.message, 'invalid_model'); }
    const next = { models: [...saved.models, entry], vendorRegions: { ...saved.vendorRegions, ...vendorRegions } };
    // No await between validation and rename/registration: concurrent requests cannot lose additions.
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    registerExtraModels({ models: [entry], vendorRegions });
    Object.assign(saved, next);
    extras.add(id);
    return { ok: true, model: modelById.get(id) };
  });
}
