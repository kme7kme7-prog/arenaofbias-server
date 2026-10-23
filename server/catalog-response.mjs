// Public JSON is shared across viewers. Only catalog writes invalidate it; session
// activity must not make every authenticated read rebuild the work/media DTOs.
import { createHash } from 'node:crypto';
import { MIN_COMPRESS_BYTES, compress, etagFor, etagMatches, pickEncoding, withVary } from './compress.mjs';

export function createCatalogRevision(db) {
  db.exec('CREATE TEMP TABLE catalog_revision (revision INTEGER NOT NULL); INSERT INTO catalog_revision VALUES (0);');
  const tables = ['works', 'questions', 'work_overrides', 'question_overrides', 'reference_uploads'];
  for (const table of [...tables, 'users']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const change = table === 'users' && event === 'UPDATE' ? 'UPDATE OF name, nickname, avatar, role' : event;
      db.exec(`CREATE TEMP TRIGGER catalog_${table}_${event.toLowerCase()} AFTER ${change} ON main.${table}
        BEGIN UPDATE catalog_revision SET revision = revision + 1; END;`);
    }
  }
  const revision = db.prepare('SELECT revision FROM catalog_revision');
  const external = db.prepare('PRAGMA data_version');
  return () => `${revision.get().revision}|${external.get().data_version}`;
}

// Writes that change the public activity block (votes, reactions, featured picks).
// A separate counter, so a vote does not throw away the catalog's work DTOs.
export function createActivityRevision(db) {
  db.exec('CREATE TEMP TABLE activity_revision (revision INTEGER NOT NULL); INSERT INTO activity_revision VALUES (0);');
  for (const table of ['votes', 'reactions', 'featured_picks', 'featured_refreshes']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TEMP TRIGGER activity_${table}_${event.toLowerCase()} AFTER ${event} ON main.${table}
        BEGIN UPDATE activity_revision SET revision = revision + 1; END;`);
    }
  }
  const revision = db.prepare('SELECT revision FROM activity_revision');
  return () => String(revision.get().revision);
}

// One shared JSON body per generation, serialized, hashed and compressed once.
// `strict` must match when the body leaves: a change during the build rebuilds it
// (moderation withdrawals). `loose` only decides whether a cached body is reused,
// so frequent writes such as votes cannot keep a request rebuilding. `ttl` bounds
// how long a body outlives changes that no counter sees.
export function createSharedJson({ strict, loose = () => '', read, ttl = 30_000, cacheControl, label = 'shared', now = Date.now, compressBody = compress }) {
  const building = new Map();
  let cached;
  const fresh = (entry, strictKey, looseKey) => entry && entry.strict === strictKey && entry.loose === looseKey && now() - entry.at < ttl;
  async function current() {
    for (;;) {
      const strictKey = strict(), looseKey = loose();
      if (fresh(cached, strictKey, looseKey)) return { entry: cached, hit: true };
      const key = `${strictKey}#${looseKey}`;
      if (!building.has(key)) {
        const pending = Promise.resolve().then(async () => {
          const body = Buffer.from(JSON.stringify(await read()));
          const hash = createHash('sha256').update(body).digest('hex');
          // Unchanged content keeps its compressed copies and validator.
          const variants = cached?.hash === hash ? cached.variants : new Map();
          return { strict: strictKey, loose: looseKey, body, hash, variants, at: now() };
        }).finally(() => building.delete(key));
        building.set(key, pending);
      }
      const entry = await building.get(key);
      // Serialization yields to I/O. A strict change during the build must be
      // reflected before the response or a conditional 304 leaves the server.
      if (strict() !== entry.strict) continue;
      if (!cached || entry.at >= cached.at) cached = entry;
      return { entry, hit: false };
    }
  }
  const variant = (entry, encoding) => {
    if (!entry.variants.has(encoding)) {
      const pending = compressBody(entry.body, encoding);
      pending.catch(() => entry.variants.delete(encoding));
      entry.variants.set(encoding, pending);
    }
    return entry.variants.get(encoding);
  };
  const handler = async (req, res) => {
    const started = performance.now();
    for (;;) {
      const { entry, hit } = await current();
      if (strict() !== entry.strict) continue;
      const encoding = entry.body.length >= MIN_COMPRESS_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
      const headers = {
        'Cache-Control': cacheControl,
        ETag: etagFor(entry.hash, encoding),
        Vary: withVary(res, 'Accept-Encoding'),
        'X-Content-Type-Options': 'nosniff',
      };
      const timing = () => `${label};dur=${(performance.now() - started).toFixed(2)};desc="${hit ? 'hit' : 'miss'}"`;
      if (etagMatches(req.headers['if-none-match'], entry.hash)) {
        res.writeHead(304, { ...headers, 'Server-Timing': timing() });
        return res.end();
      }
      let body = entry.body;
      let used = null;
      if (encoding) {
        try { body = await variant(entry, encoding); used = encoding; } catch { body = entry.body; }
      }
      // Compression also yields. Recheck before publishing the bytes, including
      // the plain-body fallback when a compressor fails during a withdrawal.
      if (strict() !== entry.strict) continue;
      if (!used) headers.ETag = etagFor(entry.hash, null);
      res.writeHead(200, { ...headers, 'Server-Timing': timing(), 'Content-Type': 'application/json; charset=utf-8',
        ...(used ? { 'Content-Encoding': used } : {}), 'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
  };
  handler.current = current;
  return handler;
}

export function createCatalogResponse(db, catalog, read, { mediaTtl = 30_000, revision = createCatalogRevision(db) } = {}) {
  return createSharedJson({
    strict: () => `${catalog.snapshot().version}|${revision()}`,
    read: () => read(catalog.snapshot()),
    ttl: mediaTtl,
    cacheControl: 'public, no-cache',
    label: 'catalog',
  });
}
