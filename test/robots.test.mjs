import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ROBOTS, withRobots } from '../server/robots.mjs';

test('both Node servers keep crawlers away and pass other requests through', async t => {
  const server = createServer(withRobots((req, res) => { res.writeHead(404); res.end('next'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const robots = await fetch(`${base}/robots.txt?x=1`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  assert.equal(await robots.text(), ROBOTS);
  assert.equal(ROBOTS, 'User-agent: *\nDisallow: /\n');
  assert.equal((await fetch(`${base}/robots.txt`, { method: 'POST' })).status, 404);
  assert.equal(await (await fetch(`${base}/v/robots.txt`)).text(), 'next');
});
