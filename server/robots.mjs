// The API host and the work content hosts are not meant for search results: the site
// pages live on the static frontends. Both Node servers answer /robots.txt themselves.
export const ROBOTS = 'User-agent: *\nDisallow: /\n';

export function withRobots(handler) {
  return (req, res) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && String(req.url).split('?')[0] === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : ROBOTS);
      return;
    }
    return handler(req, res);
  };
}
