// Uniform screenshots of submitted works, taken like the archive's own captures: a fresh
// browser context at 1440×900 and a 390×844 touch phone, default state, light scheme.
// Needs Playwright and a local Chrome; without them automatic content checks wait
// for manual review and uploads show a text cover. Each viewport is shot twice: the
// public capture after load, then a review-only shot after scrolling, a click and a wait,
// so pages that hold back content for a few seconds or until input still get seen.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const SHOTS = [
  { id: 'first', viewport: { width: 1440, height: 900 }, mobile: false },
  { id: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
];

// Pages that cloak content from automation usually test these two properties.
const DISGUISE = `(() => {
  const proto = Navigator.prototype;
  Object.defineProperty(proto, 'webdriver', { get: () => false, configurable: true });
  for (const name of ['userAgent', 'appVersion']) {
    const get = Object.getOwnPropertyDescriptor(proto, name).get;
    Object.defineProperty(proto, name, { get() { return get.call(this).replace('HeadlessChrome', 'Chrome'); }, configurable: true });
  }
})();`;

// Text of the page and every frame inside it; a frame's text is not part of body.innerText.
async function pageText(page) {
  const parts = [];
  for (const frame of page.frames()) parts.push(await frame.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
  return parts.filter(Boolean).join('\n');
}

// Browser redirects are not all intercepted by route(). Fetch each permitted hop
// ourselves so a CDN redirect can never send Chromium to another network target.
// CDN bodies are hashed into resources so a later capture can tell when one changed.
export async function guardCaptureContext(context, { origin, cdn, resources = null }) {
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
        if (response.status() < 300 || response.status() >= 400) {
          if (resources && url.origin !== workOrigin) resources.set(request.url(), createHash('sha256').update(await response.body()).digest('hex'));
          return await route.fulfill({ response });
        }
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

export function createCapturer({ config, library, loadChromium = async () => (await import('playwright')).chromium, now = Date.now }) {
  let browser = null;
  let networkBlocker = null;
  let available = false;
  let failedAt = null;
  let launching = null;
  let reported = false;
  let running = null;
  let closed = false;
  const queue = [];

  async function launch() {
    if (!browser) {
      const chromium = await loadChromium();
      if (config.captureEndpointFile) {
        // The worker owns Chrome and its rejecting proxy. Read anew after every
        // disconnect because a restarted worker publishes a fresh endpoint.
        const endpoint = readFileSync(config.captureEndpointFile, 'utf8').trim();
        try {
          browser = await chromium.connect(endpoint, { timeout: 30000 });
        } catch {
          // The endpoint includes a capability token; keep it out of logs.
          throw new Error('独立截图服务连接失败');
        }
      } else {
        // Unrouted browser traffic has no network path. Permitted resources are
        // fetched by route.fetch(), which does not use Chromium's proxy flags.
        networkBlocker = createServer((socket) => socket.destroy());
        await new Promise((resolve, reject) => {
          networkBlocker.once('error', reject);
          networkBlocker.listen(0, '127.0.0.1', resolve);
        });
        try {
          // The OS sandbox needs a non-root service user; CAPTURE_SANDBOX=1 turns it on.
          browser = await chromium.launch({ ...(config.captureChannel ? { channel: config.captureChannel } : {}),
            chromiumSandbox: Boolean(config.captureSandbox),
            args: [`--proxy-server=http://127.0.0.1:${networkBlocker.address().port}`, '--proxy-bypass-list=<-loopback>',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
        } catch (error) {
          await new Promise((resolve) => networkBlocker.close(resolve));
          networkBlocker = null;
          throw error;
        }
      }
      const instance = browser;
      browser.on('disconnected', () => {
        if (browser !== instance) return;
        browser = null;
        available = false;
        if (networkBlocker?.listening) networkBlocker.close();
        networkBlocker = null;
      });
    }
    return browser;
  }

  async function initialize() {
    if (closed || !config.capture) {
      if (!reported) {
        console.info('自动截图已关闭。');
        reported = true;
      }
      return false;
    }
    if (available) return true;
    if (launching) return launching;
    if (failedAt !== null && now() - failedAt < 5 * 60e3) return false;
    launching = (async () => {
      try {
        await launch();
        available = !closed;
        failedAt = null;
        if (!reported) console.info('自动截图可用。');
      } catch (error) {
        available = false;
        failedAt = now();
        console.warn(`自动截图不可用（${error.message.split('\n')[0]}）。上传作品将显示文字封面，自动内容审查转人工；五分钟后新任务将重试。`);
      } finally {
        reported = true;
      }
      return available;
    })();
    try { return await launching; }
    finally { launching = null; }
  }

  // publish=false keeps the shots out of the work's public captures (periodic rechecks).
  async function capture(work, { prefix = '', publish = true } = {}) {
    if (!await initialize()) return null;
    const origin = library.publicContent(work) ? library.originOf(work.contentKey) : library.previewOrigin(work);
    const captures = {};
    const late = {};
    const texts = [];
    const firstTexts = [];
    const resources = new Map();
    for (const shot of SHOTS) {
      for (let attempt = 0; attempt < 2 && !closed; attempt++) {
        let context;
        try {
          if (!await initialize()) break;
          context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 1, isMobile: shot.mobile, hasTouch: shot.mobile, colorScheme: 'light', serviceWorkers: 'block' });
          await context.addInitScript(DISGUISE);
          await guardCaptureContext(context, { origin, cdn: config.cdn, resources });
          const page = await context.newPage();
          const response = await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30000 });
          if (!response?.ok()) throw new Error('作品页面未成功加载');
          await page.waitForTimeout(3500);
          mkdirSync(join(library.mediaDir, work.id), { recursive: true });
          const name = `${prefix}${shot.id}.jpg`;
          await page.screenshot({ path: join(library.mediaDir, work.id, name), type: 'jpeg', quality: 84 });
          const text = await pageText(page);
          texts.push(text);
          firstTexts.push(text);
          captures[shot.id] = name;
          try {
            const { width, height } = shot.viewport;
            await page.mouse.move(width / 2, height / 2);
            await page.mouse.wheel(0, height * 4);
            await page.mouse.click(width / 2, height / 2);
            await page.waitForTimeout(8500);
            const lateName = `${prefix}${shot.id}-late.jpg`;
            await page.screenshot({ path: join(library.mediaDir, work.id, lateName), type: 'jpeg', quality: 84 });
            texts.push(await pageText(page));
            late[shot.id] = lateName;
          } catch (error) {
            console.warn(`延迟截图失败 ${work.id} ${shot.id}：${error.message.split('\n')[0]}`);
          }
          break;
        } catch (error) {
          if (attempt === 1) console.warn(`截图失败 ${work.id} ${shot.id}：${error.message.split('\n')[0]}`);
        } finally {
          await context?.close().catch(() => {});
        }
      }
    }
    if (publish && !closed && Object.keys(captures).length && library.hasDirectory(work.id)) library.setCaptures(work.id, captures);
    return { captures, late, texts, firstTexts, resources: Object.fromEntries([...resources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
  }

  async function drain() {
    while (queue.length && !closed) {
      const { work, options, resolve } = queue.shift();
      try {
        resolve(await capture(work, options));
      } catch (error) {
        resolve(null);
        console.warn(`截图失败 ${work.id}：${error.message.split('\n')[0]}`);
      }
    }
    for (const item of queue.splice(0)) item.resolve(null);
  }

  function start() {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (queue.length && !closed) start();
    });
  }

  return {
    get available() { return available; },
    initialize,
    enqueue(work, options) {
      if (!config.capture || closed || (failedAt !== null && now() - failedAt < 5 * 60e3)) return Promise.resolve(null);
      return new Promise((resolve) => {
        queue.push({ work, options, resolve });
        start();
      });
    },
    async close() {
      closed = true;
      available = false;
      for (const item of queue.splice(0)) item.resolve(null);
      await browser?.close().catch(() => {});
      await running;
      await launching;
      // A launch already in flight can finish after close() starts.
      await browser?.close().catch(() => {});
      if (networkBlocker?.listening) await new Promise((resolve) => networkBlocker.close(resolve));
    },
  };
}
