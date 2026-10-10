// Public reads share IP budgets across both frontends and every work hostname.
import { clientIp, rateLimit } from './http.mjs';

const catalogPaths = new Set([
  '/api/bootstrap', '/api/catalog', '/api/activity', '/api/show1/works', '/api/works', '/api/prompts',
  '/api/votes', '/api/ratings', '/api/leaderboard', '/api/show1/leaderboard', '/api/guess/today',
]);

export function createReadGuard(config) {
  const budget = (name, fallback) => rateLimit(60_000, config.readLimits?.[name] ?? fallback,
    '读取太频繁，请稍后再试');
  const api = budget('api', 180);
  const catalog = budget('catalog', 30);
  const files = budget('files', 1200);
  const pages = budget('pages', 60);
  const ip = (req) => clientIp(req, config.trustProxy);
  return {
    api(req, pathname) {
      const key = ip(req);
      api(key);
      if (catalogPaths.has(pathname)) catalog(key);
    },
    file(req) { files(ip(req)); },
    page(req) { pages(ip(req)); },
  };
}
