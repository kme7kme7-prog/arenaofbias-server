// Run on the review host; the platform reaches this loopback listener over SSH.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 81 * 1024 * 1024;
const TIMEOUT = 15 * 60e3;

export function createModerationRelay({ apiKey, model = 'gpt-6-luna', request = httpsRequest }) {
  if (!apiKey) throw new Error('MODERATION_API_KEY is required');
  return createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, model });
    if (req.method !== 'POST' || req.url !== '/v1/responses') return reply(404, { error: { code: 'not_found' } });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { error: { code: 'unauthorized' } });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return reply(413, { error: { code: 'body_too_large' } });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let payload;
      try { payload = JSON.parse(body); }
      catch { return reply(400, { error: { code: 'invalid_json' } }); }
      if (payload?.model !== model || payload.service_tier !== 'flex' || payload.store !== false || payload.stream === true) {
        return reply(400, { error: { code: 'review_request_required' } });
      }
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const fail = (error) => {
        // Never log request bodies, authorization headers, or provider messages.
        console.warn('Review relay upstream failed:', error.code ?? error.name);
        if (res.headersSent) res.destroy();
        else if (!res.destroyed) reply(503, { error: { code: 'upstream_unavailable' } });
      };
      const upstream = request('https://api.openai.com/v1/responses', {
        method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      }, (incoming) => {
        res.writeHead(incoming.statusCode, {
          'Content-Type': incoming.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store',
        });
        pipeline(incoming, res).catch(fail);
      });
      upstream.once('error', fail);
      upstream.end(body);
    } catch {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) reply(503, { error: { code: 'upstream_unavailable' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createModerationRelay({ apiKey: process.env.MODERATION_API_KEY, model: process.env.MODERATION_MODEL });
  relay.listen(Number(process.env.REVIEW_PORT ?? 5280), '127.0.0.1', () => {
    console.log(`Review relay listening on 127.0.0.1:${relay.address().port}`);
  });
  process.once('SIGTERM', () => relay.close());
  process.once('SIGINT', () => relay.close());
}
