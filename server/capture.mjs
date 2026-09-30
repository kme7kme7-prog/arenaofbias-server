// Uniform screenshots of submitted works, taken like the archive's own captures: a fresh
// browser context at 1440×900 and a 390×844 touch phone, default state, light scheme.
// Needs Playwright and a local Chrome; without them uploads simply show a text cover.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const SHOTS = [
  { id: 'first', viewport: { width: 1440, height: 900 }, mobile: false },
  { id: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
];

// Browser redirects are not all intercepted by route(). Fetch each permitted hop
// ourselves so a CDN redirect can never send Chromium to another network target.
export async function guardCaptureContext(context, { origin, cdn }) {
  const workOrigin = new URL(origin).origin;
  const cdnOrigins = new Set(cdn.map((host) => new URL(`https://${host}`).origin));
  const allowed = (url, document) => !url.username && !url.password &&
    (url.origin === workOrigin || (!document && url.protocol === 'https:' && cdnOrigins.has(url.origin)));
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const document = request.resourceType() === 'document';
    let response;
    try {
      if (!['GET', 'HEAD'].includes(request.method())) return await route.abort();
      let url = new URL(request.url());
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!allowed(url, document)) return await route.abort();
        // Chrome resolves *.localhost itself; the Node-side fetch may not. Keep
        // the work's Host while connecting to the local content listener.
        const localWork = url.origin === workOrigin && url.protocol === 'http:' && url.hostname.endsWith('.localhost');
        const target = new URL(url);
        if (localWork) target.hostname = '127.0.0.1';
        response = await route.fetch({ url: target.href, ...(localWork ? { headers: { ...await request.allHeaders(), host: url.host } } : {}),
          maxRedirects: 0, timeout: 15000 });
        if (response.status() < 300 || response.status() >= 400) return await route.fulfill({ response });
        const location = response.headers().location;
        if (!location) return await route.abort();
        url = new URL(location, url);
        await response.dispose();
        response = null;
      }
      await route.abort();
    } catch {
      // A closed context or failed resource must not reject an event callback.
      await route.abort().catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  });
}

export function createCapturer({ config, library }) {
  let browser = null;
  let networkBlocker = null;
  let available = config.capture;
  let running = false;
  const queue = [];

  async function launch() {
    if (!browser) {
      const { chromium } = await import('playwright');
      // Unrouted browser traffic has no network path. Permitted resources are
      // fetched by route.fetch(), which does not use Chromium's proxy flags.
      networkBlocker = createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        networkBlocker.once('error', reject);
        networkBlocker.listen(0, '127.0.0.1', resolve);
      });
      try {
        browser = await chromium.launch({ ...(config.captureChannel ? { channel: config.captureChannel } : {}),
          args: [`--proxy-server=http://127.0.0.1:${networkBlocker.address().port}`, '--proxy-bypass-list=<-loopback>',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      } catch (error) {
        networkBlocker.close();
        throw error;
      }
    }
    return browser;
  }

  async function capture(work) {
    const instance = await launch();
    const origin = library.originOf(work.contentKey);
    const captures = {};
    for (const shot of SHOTS) {
      const context = await instance.newContext({ viewport: shot.viewport, deviceScaleFactor: 1, isMobile: shot.mobile, hasTouch: shot.mobile, colorScheme: 'light', serviceWorkers: 'block' });
      try {
        await guardCaptureContext(context, { origin, cdn: config.cdn });
        const page = await context.newPage();
        await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3500);
        mkdirSync(join(library.mediaDir, work.id), { recursive: true });
        await page.screenshot({ path: join(library.mediaDir, work.id, `${shot.id}.jpg`), type: 'jpeg', quality: 84 });
        captures[shot.id] = `${shot.id}.jpg`;
      } catch (error) {
        console.warn(`截图失败 ${work.id} ${shot.id}：${error.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
    if (Object.keys(captures).length && library.hasDirectory(work.id)) library.setCaptures(work.id, captures);
  }

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length && available) {
      const work = queue.shift();
      try {
        await capture(work);
      } catch (error) {
        available = false;
        queue.length = 0;
        console.warn(`自动截图不可用（${error.message.split('\n')[0]}）。上传作品将显示文字封面。`);
      }
    }
    running = false;
  }

  return {
    get available() { return available; },
    enqueue(work) {
      if (!available) return;
      queue.push(work);
      drain();
    },
    async close() {
      await browser?.close().catch(() => {});
      if (networkBlocker?.listening) await new Promise((resolve) => networkBlocker.close(resolve));
    },
  };
}
