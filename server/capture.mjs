// Uniform screenshots of submitted works, taken like the archive's own captures: a fresh
// browser context at 1440×900 and a 390×844 touch phone, default state, light scheme.
// Needs Playwright and a local Chrome; without them automatic content checks wait
// for manual review and uploads show a text cover. Each viewport is shot twice: the
// public capture after load, then a review-only shot after scrolling, a click and a wait,
// so pages that hold back content for a few seconds or until input still get seen.
// Browser calls that can sit forever (newContext has no Playwright timeout) are raced
// with CAPTURE_*_TIMEOUT_MS. The whole job also stops at CAPTURE_TASK_TIMEOUT_MS.
// A timed-out call drops the connection so the next attempt opens a new one.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { THREE_MIRROR_PATH } from './config.mjs';
import { contentRuntimePath } from './content-path.mjs';

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
  const workPath = /^\/v\/[wmdpc][0-9a-f]{32}(?:\/|$)/.exec(new URL(origin).pathname)?.[0].replace(/\/$/, '');
  const workKey = workPath?.slice('/v/'.length);
  const ownResource = url => url.origin === workOrigin && (!workKey ||
    url.pathname === contentRuntimePath || [`/v/${workKey}/`, `/c/${workKey}/`].some(prefix => url.pathname.startsWith(prefix)));
  const cdnOrigins = new Set(cdn.map((host) => new URL(`https://${host}`).origin));
  const allowed = (url, document) => !url.username && !url.password &&
    (ownResource(url) || (!document && url.protocol === 'https:' && cdnOrigins.has(url.origin)
      && (url.hostname !== 'registry.npmmirror.com' || url.pathname.startsWith(THREE_MIRROR_PATH))));
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

// Defaults match captureTimeoutConfig. route/input/text are internal bounds; they stay
// inside the task budget and are not environment variables.
const TIMEOUT_DEFAULTS = {
  task: 180_000, newContext: 45_000, newPage: 30_000, goto: 45_000, screenshot: 60_000,
  close: 15_000, connect: 30_000, route: 15_000, input: 10_000, text: 45_000,
};

class CaptureTimeout extends Error {
  constructor(step) {
    super(`截图步骤超时（${step}）`);
    this.name = 'CaptureTimeout';
    this.step = step;
  }
}

function resolveTimeouts(configured = {}) {
  const source = configured ?? {};
  const pick = (key) => {
    const value = source[key];
    return Number.isInteger(value) && value > 0 ? value : TIMEOUT_DEFAULTS[key];
  };
  return Object.fromEntries(Object.keys(TIMEOUT_DEFAULTS).map((key) => [key, pick(key)]));
}

// Playwright's own timer should win when the call has one, so a slow navigation
// still retries in place. The extra slack only fires when that timer never does.
function relaxed(ms) {
  return ms + Math.min(1000, Math.max(25, Math.floor(ms / 10)));
}

function withTimeout(promise, ms, step) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CaptureTimeout(step)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createCapturer({ config, library, loadChromium = async () => (await import('playwright')).chromium, now = Date.now }) {
  const timeouts = resolveTimeouts(config.captureTimeouts);
  let browser = null;
  let networkBlocker = null;
  let available = false;
  let failedAt = null;
  let launching = null;
  let reported = false;
  let running = null;
  let closed = false;
  let activeBudget = null;
  let notedDiscard = false;
  let failActiveStep = null;
  const dropped = new WeakSet();
  const queue = [];

  function operationLimit(cap) {
    if (!activeBudget) return cap;
    return Math.min(cap, activeBudget.remaining());
  }

  // Drop a wedged connection without waiting forever for close(). The next
  // initialize() connects again and, for the remote worker, rereads the endpoint.
  function discardBrowser(target = browser) {
    if (!target) return;
    if (browser === target) {
      browser = null;
      available = false;
      const blocker = networkBlocker;
      networkBlocker = null;
      if (blocker?.listening) blocker.close();
      if (!notedDiscard && !closed) {
        notedDiscard = true;
        console.warn('截图连接无响应，已丢弃当前连接并准备重建。');
      }
    }
    if (dropped.has(target)) return;
    dropped.add(target);
    const closing = Promise.resolve().then(() => target.close()).catch(() => {});
    withTimeout(closing, timeouts.close, 'close').catch(() => {});
  }

  async function step(work, ms, name) {
    const limit = activeBudget ? Math.min(ms, Math.max(0, activeBudget.remaining())) : ms;
    if (limit <= 0) throw new CaptureTimeout('task');
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const previous = failActiveStep;
    failActiveStep = (error) => rejectAbort(error);
    try {
      return await withTimeout(Promise.race([
        Promise.resolve().then(work),
        ...(activeBudget ? [activeBudget.signal] : []),
        aborted,
      ]), limit, name);
    } catch (error) {
      if (activeBudget && activeBudget.remaining() <= 0) throw new CaptureTimeout('task');
      throw error;
    } finally {
      if (failActiveStep !== previous) failActiveStep = previous;
      rejectAbort?.(new Error('step-settled'));
    }
  }

  async function release(page, context, owner) {
    const jobs = [];
    if (page?.close) jobs.push(Promise.resolve().then(() => page.close()).catch(() => {}));
    if (context?.close) jobs.push(Promise.resolve().then(() => context.close()).catch(() => {}));
    if (!jobs.length) return;
    try {
      await withTimeout(Promise.all(jobs), timeouts.close, 'close');
    } catch {
      if (owner) discardBrowser(owner);
    }
  }

  function createBudget(ms) {
    let rejectBudget;
    const signal = new Promise((_, reject) => { rejectBudget = reject; });
    signal.catch(() => {});
    const deadline = Date.now() + ms;
    const timer = setTimeout(() => {
      discardBrowser(browser);
      rejectBudget(new CaptureTimeout('task'));
    }, ms);
    return {
      signal,
      remaining: () => deadline - Date.now(),
      clear: () => clearTimeout(timer),
    };
  }

  async function timedConnect(pending, limit) {
    try {
      return await withTimeout(pending, limit, 'connect');
    } catch (error) {
      pending.then((instance) => instance?.close?.().catch(() => {})).catch(() => {});
      if (activeBudget && activeBudget.remaining() <= 0) throw new CaptureTimeout('task');
      throw error;
    }
  }

  async function launch() {
    if (!browser) {
      const chromium = await loadChromium();
      const limit = operationLimit(timeouts.connect);
      if (limit <= 0) throw new CaptureTimeout('task');
      if (config.captureEndpointFile) {
        // The worker owns Chrome and its rejecting proxy. Read anew after every
        // disconnect because a restarted worker publishes a fresh endpoint.
        const endpoint = readFileSync(config.captureEndpointFile, 'utf8').trim();
        const pending = chromium.connect(endpoint, { timeout: limit });
        try {
          browser = await timedConnect(pending, limit);
        } catch (error) {
          // The endpoint includes a capability token; keep it out of logs.
          if (error instanceof CaptureTimeout && error.step === 'task') throw error;
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
        const pending = chromium.launch({ ...(config.captureChannel ? { channel: config.captureChannel } : {}),
          chromiumSandbox: Boolean(config.captureSandbox), timeout: limit,
          args: [`--proxy-server=http://127.0.0.1:${networkBlocker.address().port}`, '--proxy-bypass-list=<-loopback>',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
        try {
          // The OS sandbox needs a non-root service user; CAPTURE_SANDBOX=1 turns it on.
          browser = await timedConnect(pending, limit);
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
        failActiveStep?.(new Error('截图连接已断开'));
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
        if (error instanceof CaptureTimeout && error.step === 'task') throw error;
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

  async function openContext(owner, shot) {
    const pending = Promise.resolve().then(() => owner.newContext({
      viewport: shot.viewport, deviceScaleFactor: 1, isMobile: shot.mobile, hasTouch: shot.mobile,
      colorScheme: 'light', serviceWorkers: 'block',
    }));
    try {
      return await step(() => pending, timeouts.newContext, 'new_context');
    } catch (error) {
      // newContext has no Playwright timeout. If it resolves after we give up, close it.
      pending.then((context) => release(null, context, owner)).catch(() => {});
      throw error;
    }
  }

  // publish=false keeps the shots out of the work's public captures (periodic rechecks).
  async function capture(work, { prefix = '', publish = true } = {}) {
    notedDiscard = false;
    const budget = createBudget(timeouts.task);
    activeBudget = budget;
    let stop = false;
    try {
      if (!await initialize()) return null;
      const origin = library.publicContent(work) ? library.originOf(work.contentKey) : library.previewOrigin(work);
      const captures = {};
      const late = {};
      const texts = [];
      const firstTexts = [];
      const resources = new Map();
      for (const shot of SHOTS) {
        if (stop || closed) break;
        for (let attempt = 0; attempt < 2 && !closed && !stop; attempt++) {
          let context;
          let page;
          let owner = browser;
          try {
            if (budget.remaining() <= 0) { stop = true; break; }
            if (!await initialize()) break;
            owner = browser;
            context = await openContext(owner, shot);
            await step(() => context.addInitScript(DISGUISE), timeouts.route, 'route');
            await step(() => guardCaptureContext(context, { origin, cdn: config.cdn, resources }), timeouts.route, 'route');
            page = await step(() => context.newPage(), timeouts.newPage, 'new_page');
            const gotoLimit = Math.max(1, Math.min(timeouts.goto, budget.remaining()));
            const response = await step(() => page.goto(`${origin}/`, { waitUntil: 'load', timeout: gotoLimit }), relaxed(gotoLimit), 'goto');
            if (!response?.ok()) throw new Error('作品页面未成功加载');
            await step(() => page.waitForTimeout(3500), relaxed(3500), 'wait');
            mkdirSync(join(library.mediaDir, work.id), { recursive: true });
            const name = `${prefix}${shot.id}.jpg`;
            const shotLimit = Math.max(1, Math.min(timeouts.screenshot, budget.remaining()));
            await step(() => page.screenshot({ path: join(library.mediaDir, work.id, name), type: 'jpeg', quality: 84, timeout: shotLimit }), relaxed(shotLimit), 'screenshot');
            const text = await step(() => pageText(page), timeouts.text, 'text');
            texts.push(text);
            firstTexts.push(text);
            captures[shot.id] = name;
            try {
              const { width, height } = shot.viewport;
              await step(() => page.mouse.move(width / 2, height / 2), timeouts.input, 'input');
              await step(() => page.mouse.wheel(0, height * 4), timeouts.input, 'input');
              await step(() => page.mouse.click(width / 2, height / 2), timeouts.input, 'input');
              await step(() => page.waitForTimeout(8500), relaxed(8500), 'wait');
              const lateName = `${prefix}${shot.id}-late.jpg`;
              const lateLimit = Math.max(1, Math.min(timeouts.screenshot, budget.remaining()));
              await step(() => page.screenshot({ path: join(library.mediaDir, work.id, lateName), type: 'jpeg', quality: 84, timeout: lateLimit }), relaxed(lateLimit), 'screenshot');
              texts.push(await step(() => pageText(page), timeouts.text, 'text'));
              late[shot.id] = lateName;
            } catch (error) {
              if (error instanceof CaptureTimeout && error.step === 'task') throw error;
              if (error instanceof CaptureTimeout) discardBrowser(owner);
              console.warn(`延迟截图失败 ${work.id} ${shot.id}：${error.message.split('\n')[0]}`);
            }
            break;
          } catch (error) {
            if (error instanceof CaptureTimeout && error.step !== 'task' && owner) discardBrowser(owner);
            if (attempt === 1 || (error instanceof CaptureTimeout && error.step === 'task')) {
              console.warn(`截图失败 ${work.id} ${shot.id}：${error.message.split('\n')[0]}`);
            }
            if (error instanceof CaptureTimeout && error.step === 'task') stop = true;
          } finally {
            await release(page, context, owner);
          }
        }
      }
      if (publish && !closed && Object.keys(captures).length && library.hasDirectory(work.id)) library.setCaptures(work.id, captures);
      return { captures, late, texts, firstTexts, resources: Object.fromEntries([...resources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
    } finally {
      budget.clear();
      if (activeBudget === budget) activeBudget = null;
    }
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
      failActiveStep?.(new Error('截图已关闭'));
      for (const item of queue.splice(0)) item.resolve(null);
      const current = browser;
      if (current) await withTimeout(Promise.resolve().then(() => current.close()).catch(() => {}), timeouts.close, 'close').catch(() => {});
      await running;
      await launching;
      // A launch already in flight can finish after close() starts.
      if (browser && browser !== current) {
        await withTimeout(Promise.resolve().then(() => browser.close()).catch(() => {}), timeouts.close, 'close').catch(() => {});
      }
      browser = null;
      if (networkBlocker?.listening) await new Promise((resolve) => networkBlocker.close(resolve));
    },
  };
}
