// Public JSON is shared across viewers. Only catalog writes invalidate it; session
// activity must not make every authenticated read rebuild the work/media DTOs.
import { createHash } from 'node:crypto';

export function createCatalogResponse(db, catalog, read, { mediaTtl = 30_000 } = {}) {
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
  const keyOf = (snapshot) => `${snapshot.version}|${revision.get().revision}|${external.get().data_version}`;
  const building = new Map();
  let cached;
  return async (req, res) => {
    const started = performance.now();
    let snapshot = catalog.snapshot(), key = keyOf(snapshot);
    const hit = cached?.key === key && Date.now() - cached.at < mediaTtl;
    let entry = cached;
    while (entry?.key !== key || Date.now() - entry.at >= mediaTtl) {
      if (!building.has(key)) {
        const buildKey = key, buildSnapshot = snapshot;
        const pending = Promise.resolve().then(async () => {
          const body = Buffer.from(JSON.stringify(await read(buildSnapshot)));
          return { key: buildKey, body, at: Date.now(), etag: `"${createHash('sha256').update(body).digest('hex')}"` };
        }).finally(() => building.delete(buildKey));
        building.set(key, pending);
      }
      entry = await building.get(key);
      // Serialization yields to I/O. A moderation change during a build must be
      // reflected before the response or conditional 304 leaves the server.
      snapshot = catalog.snapshot();
      key = keyOf(snapshot);
    }
    cached = entry;
    const headers = {
      'Cache-Control': 'public, no-cache',
      ETag: entry.etag,
      'Server-Timing': `catalog;dur=${(performance.now() - started).toFixed(2)};desc="${hit ? 'hit' : 'miss'}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    const matches = String(req.headers['if-none-match'] ?? '').split(',').some((value) => {
      const tag = value.trim().replace(/^W\//, '');
      return tag === '*' || tag === entry.etag;
    });
    if (matches) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': entry.body.length });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
  };
}
