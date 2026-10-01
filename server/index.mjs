// Starts the platform: the site with its API, and the separate content server for works.
import { createServer } from 'node:http';
import { createPlatform } from './app.mjs';
import { config, limits } from './config.mjs';
import { drainServers } from './shutdown.mjs';

let platform;
try {
  platform = createPlatform({ config, limits });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const site = createServer(platform.handleSite);
const content = createServer(platform.handleContent);
let ready = 0;
const started = async () => {
  if (++ready < 2) return;
  await platform.capturer.initialize();
  const shown = config.host === '127.0.0.1' || config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`同题异答 · 平台已启动
  站点  http://${shown}:${config.port}/
  作品  ${config.contentTemplate.replace('{token}', '<token>')}
  数据  ${config.dataDir}`);
};
for (const server of [site, content]) {
  server.on('error', (error) => {
    console.error(`无法启动：${error.message}`);
    process.exit(1);
  });
}
site.listen(config.port, config.host, started);
content.listen(config.contentPort, config.host, started);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => {
    console.error('Shutdown timed out after 10 seconds; forcing exit');
    process.exit(1);
  }, 10_000);
  try {
    await drainServers([site, content]);
    await platform.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error('Shutdown failed', error);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
