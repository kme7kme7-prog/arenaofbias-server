// Runs only in the dedicated capture service, without platform data or secrets.
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const endpointFile = process.env.CAPTURE_ENDPOINT_FILE;
if (!endpointFile) throw new Error('CAPTURE_ENDPOINT_FILE is required');
if (process.getuid?.() === 0) throw new Error('The capture service must run as a non-root user');

const { chromium } = await import('playwright');
const blocker = createServer((socket) => socket.destroy());
await new Promise((resolve, reject) => {
  blocker.once('error', reject);
  blocker.listen(0, '127.0.0.1', resolve);
});

let browser;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  rmSync(endpointFile, { force: true });
  await browser?.close().catch(() => {});
  await new Promise((resolve) => blocker.close(resolve));
}

try {
  const channel = process.env.CAPTURE_BROWSER ?? 'chrome';
  browser = await chromium.launchServer({ host: '127.0.0.1', chromiumSandbox: true,
    ...(channel ? { channel } : {}),
    // Do not pass service or platform credentials to the browser process.
    env: { HOME: process.env.HOME || '/var/lib/aob-capture', PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' },
    args: [`--proxy-server=http://127.0.0.1:${blocker.address().port}`, '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  browser.on('close', () => {
    if (stopping) return;
    stop().finally(() => { process.exitCode = 1; });
  });
  const temporary = `${endpointFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${browser.wsEndpoint()}\n`, { mode: 0o640 });
  renameSync(temporary, endpointFile);
  if (process.env.NOTIFY_SOCKET) await promisify(execFile)('/usr/bin/systemd-notify', ['--ready']);
  console.info('Capture browser ready');
} catch (error) {
  await stop();
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stop().catch(() => { process.exitCode = 1; });
});
