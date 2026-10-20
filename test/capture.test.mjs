import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTimeoutConfig } from '../server/config.mjs';
import { createCapturer } from '../server/capture.mjs';
import { createModerator } from '../server/moderation.mjs';

function consumeHang(options, step) {
  if (options.hang !== step) return false;
  const used = options.hangs ?? 0;
  const limit = options.hangCount ?? Number.POSITIVE_INFINITY;
  if (used >= limit) return false;
  options.hangs = used + 1;
  options.onHang?.(step);
  return true;
}

function fixture(t, options = {}) {
  // Keep routine capability logs out of the concurrent test runner's output.
  t.mock.method(console, 'info', () => {});
  const mediaDir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  const contexts = [];
  const saved = [];
  const browser = new EventEmitter();
  browser.newContext = async (settings) => {
    if (consumeHang(options, 'newContext')) return new Promise((resolve) => { (options.pendingContexts ??= []).push(resolve); });
    const context = { settings, closed: false, scripts: [], route: async () => {}, routeWebSocket: async () => {},
      addInitScript: async (script) => { context.scripts.push(script); }, close: async () => {
        context.closed = true;
        if (consumeHang(options, 'close')) await new Promise(() => {});
      } };
    const attempt = contexts.filter((item) => item.settings.isMobile === settings.isMobile).length;
    contexts.push(context);
    const text = settings.isMobile ? 'mobile text' : 'desktop text';
    const frame = (value) => ({ locator: () => ({ innerText: async () => value }) });
    context.newPage = async () => ({
      goto: async (_url, navigation) => {
        context.navigation = navigation;
        if (consumeHang(options, 'goto')) await new Promise(() => {});
        if (options.fail?.(settings, attempt)) throw new Error('page failed');
        return { ok: () => true };
      },
      waitForTimeout: async () => {},
      screenshot: async ({ path, timeout }) => {
        context.screenshotTimeout = timeout;
        if (consumeHang(options, 'screenshot')) await new Promise(() => {});
        context.shots = [...(context.shots ?? []), path];
      },
      mouse: { move: async () => {}, wheel: async () => {},
        click: async () => { if (options.lateFail) throw new Error('click failed'); } },
      frames: () => [frame(text), ...(options.frameText ? [frame(options.frameText)] : [])],
    });
    return context;
  };
  browser.close = async () => browser.emit('disconnected');
  const library = { mediaDir, publicContent: () => true, originOf: () => 'http://work.localhost',
    hasDirectory: () => true, setCaptures: (id, captures) => saved.push({ id, captures }) };
  let f;
  const capturer = createCapturer({ config: { capture: true, cdn: [], ...options.config, ...(options.timeouts ? { captureTimeouts: options.timeouts } : {}) }, library,
    loadChromium: options.loadChromium ?? (async () => ({ launch: async (settings) => { f.launches.push(settings); return browser; } })), now: options.now });
  t.after(async () => { await capturer.close(); rmSync(mediaDir, { recursive: true, force: true }); });
  f = { capturer, browser, mediaDir, contexts, saved, launches: [], work: { id: 'work', contentKey: 'key' } };
  return f;
}

for (const failure of ['import', 'launch']) {
  test(`startup ${failure} failure recovers on new work after five-minute cooldown`, async (t) => {
    let time = 100;
    let attempts = 0;
    let browser;
    const f = fixture(t, { now: () => time, loadChromium: async () => {
      attempts++;
      if (failure === 'import' && attempts === 1) throw new Error('Playwright missing');
      return { launch: async () => {
        if (attempts === 1) throw new Error('Chrome missing');
        return browser;
      } };
    } });
    browser = f.browser;
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal(f.capturer.available, false);
    assert.equal(await f.capturer.initialize(), false);
    assert.equal(f.capturer.available, false);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], failure === 'import' ? /Playwright missing/ : /Chrome missing/);
    time += 5 * 60e3 - 1;
    assert.equal(await f.capturer.enqueue(f.work), null);
    assert.equal(attempts, 1);
    time++;
    assert.deepEqual((await f.capturer.enqueue(f.work)).captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
    assert.equal(attempts, 2);
    assert.equal(f.capturer.available, true);
  });
}

test('each viewport retries once in a fresh context', async (t) => {
  const f = fixture(t, { fail: (_settings, attempt) => attempt === 0 });
  assert.equal(await f.capturer.initialize(), true);
  assert.deepEqual(await f.capturer.enqueue(f.work), {
    captures: { first: 'first.jpg', mobile: 'mobile.jpg' }, late: { first: 'first-late.jpg', mobile: 'mobile-late.jpg' },
    texts: ['desktop text', 'desktop text', 'mobile text', 'mobile text'], firstTexts: ['desktop text', 'mobile text'], resources: {},
  });
  assert.deepEqual(f.contexts.map((context) => context.settings.isMobile), [false, false, true, true]);
  assert.ok(f.contexts.every((context) => context.closed));
  assert.equal(f.saved.length, 1);
});

test('a viewport gives up after its second failure while the other viewport completes', async (t) => {
  const f = fixture(t, { fail: (settings) => !settings.isMobile });
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.capturer.enqueue(f.work), { captures: { mobile: 'mobile.jpg' }, late: { mobile: 'mobile-late.jpg' },
    texts: ['mobile text', 'mobile text'], firstTexts: ['mobile text'], resources: {} });
  assert.equal(f.contexts.length, 3);
  assert.ok(f.contexts.every((context) => context.closed));
});

test('disabled capture never imports or launches the browser', async (t) => {
  const f = fixture(t, { config: { capture: false }, loadChromium: async () => assert.fail('unexpected import') });
  const info = t.mock.method(console, 'info', () => {});
  assert.equal(await f.capturer.initialize(), false);
  assert.equal(await f.capturer.initialize(), false);
  assert.equal(await f.capturer.enqueue(f.work), null);
  assert.equal(f.capturer.available, false);
  assert.equal(info.mock.callCount(), 1);
});

test('startup initialization shares its launch with queued work and tracks disconnection', async (t) => {
  let release;
  let attempts = 0;
  let browser;
  const f = fixture(t, { loadChromium: async () => {
    attempts++;
    await new Promise((resolve) => { release = resolve; });
    return { launch: async () => browser };
  } });
  browser = f.browser;
  const startup = f.capturer.initialize();
  const capture = f.capturer.enqueue(f.work);
  release();
  assert.equal(await startup, true);
  assert.ok((await capture).captures.first);
  assert.equal(attempts, 1);
  browser.emit('disconnected');
  assert.equal(f.capturer.available, false);
  const recovered = f.capturer.enqueue(f.work);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.ok((await recovered).captures.mobile);
  assert.equal(attempts, 2);
  assert.equal(f.capturer.available, true);
});

test('review shots disguise automation, read every frame and stay out of public captures when asked', async (t) => {
  const f = fixture(t, { frameText: 'frame text', config: { captureSandbox: true } });
  const result = await f.capturer.enqueue(f.work, { prefix: 'recheck-', publish: false });
  assert.deepEqual(result.captures, { first: 'recheck-first.jpg', mobile: 'recheck-mobile.jpg' });
  assert.deepEqual(result.late, { first: 'recheck-first-late.jpg', mobile: 'recheck-mobile-late.jpg' });
  assert.equal(result.texts[0], 'desktop text\nframe text');
  assert.equal(f.saved.length, 0);
  assert.equal(f.launches[0].chromiumSandbox, true);
  assert.ok(f.contexts.every((context) => context.scripts.length === 1 && /webdriver/.test(context.scripts[0]) && /HeadlessChrome/.test(context.scripts[0])));
});

test('a failed late shot keeps the public capture and leaves the review material incomplete', async (t) => {
  const f = fixture(t, { lateFail: true });
  t.mock.method(console, 'warn', () => {});
  const result = await f.capturer.enqueue(f.work);
  assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
  assert.deepEqual(result.late, {});
  assert.equal(f.saved.length, 1);
  assert.equal(f.launches[0].chromiumSandbox, false);
});

test('remote capture rereads the endpoint after disconnect and writes screenshots on the platform', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
  const endpointFile = join(directory, 'endpoint');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(endpointFile, 'ws://127.0.0.1:1234/first-token\n');
  const connections = [];
  let browser;
  const f = fixture(t, { config: { captureEndpointFile: endpointFile }, loadChromium: async () => ({
    launch: async () => assert.fail('remote capture must not launch locally'),
    connect: async (endpoint, settings) => { connections.push({ endpoint, settings }); return browser; },
  }) });
  browser = f.browser;
  assert.deepEqual((await f.capturer.enqueue(f.work)).captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
  assert.ok(f.contexts.every((context) => context.shots.every((path) => path.startsWith(join(f.mediaDir, 'work')))));
  assert.equal(f.saved.length, 1);
  writeFileSync(endpointFile, 'ws://127.0.0.1:2345/second-token\n');
  browser.emit('disconnected');
  assert.equal(await f.capturer.initialize(), true);
  assert.deepEqual(connections, [
    { endpoint: 'ws://127.0.0.1:1234/first-token', settings: { timeout: 30000 } },
    { endpoint: 'ws://127.0.0.1:2345/second-token', settings: { timeout: 30000 } },
  ]);
});

for (const failure of ['missing endpoint', 'connection']) {
  test(`remote ${failure} failure does not fall back to local Chrome or log the endpoint token`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
    const endpointFile = join(directory, 'endpoint');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (failure === 'connection') writeFileSync(endpointFile, 'ws://127.0.0.1:1234/private-token\n');
    const f = fixture(t, { config: { captureEndpointFile: endpointFile }, loadChromium: async () => ({
      launch: async () => assert.fail('remote failure must not launch locally'),
      connect: async () => { throw new Error('Failed ws://127.0.0.1:1234/private-token'); },
    }) });
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal(await f.capturer.initialize(), false);
    assert.equal(await f.capturer.enqueue(f.work), null);
    assert.equal(f.capturer.available, false);
    assert.equal(warn.mock.callCount(), 1);
    assert.doesNotMatch(warn.mock.calls[0].arguments[0], /private-token/);
  });
}

test('capture timeout configuration keeps positive overrides and falls back otherwise', () => {
  assert.deepEqual(captureTimeoutConfig({}), {
    task: 180_000, newContext: 45_000, newPage: 30_000, goto: 45_000, screenshot: 60_000, close: 15_000, connect: 30_000,
  });
  assert.equal(captureTimeoutConfig({ CAPTURE_TASK_TIMEOUT_MS: '0' }).task, 180_000);
  assert.equal(captureTimeoutConfig({ CAPTURE_GOTO_TIMEOUT_MS: 'soon' }).goto, 45_000);
  assert.equal(captureTimeoutConfig({ CAPTURE_SCREENSHOT_TIMEOUT_MS: '90000' }).screenshot, 90_000);
  assert.equal(captureTimeoutConfig({ CAPTURE_NEW_CONTEXT_TIMEOUT_MS: '' }).newContext, 45_000);
});

test('navigation and screenshot calls receive the configured timeouts', async (t) => {
  const f = fixture(t, { timeouts: { goto: 12345, screenshot: 23456 } });
  await f.capturer.enqueue(f.work);
  assert.ok(f.contexts.length >= 2);
  assert.ok(f.contexts.every((context) => context.navigation.timeout === 12345 && context.screenshotTimeout === 23456));
});

test('a hung newContext drops the connection, rereads the endpoint and the queue continues', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
  const endpointFile = join(directory, 'endpoint');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(endpointFile, 'ws://127.0.0.1:1234/first-token\n');
  const connections = [];
  const pendingContexts = [];
  let browser;
  const f = fixture(t, {
    hang: 'newContext', hangCount: 1, pendingContexts,
    onHang: () => writeFileSync(endpointFile, 'ws://127.0.0.1:2345/second-token\n'),
    timeouts: { task: 10_000, newContext: 40, close: 40, connect: 1000, newPage: 1000, goto: 1000, screenshot: 1000, route: 1000, input: 1000, text: 1000 },
    config: { captureEndpointFile: endpointFile },
    loadChromium: async () => ({
      launch: async () => assert.fail('remote capture must not launch locally'),
      connect: async (endpoint) => { connections.push(endpoint); return browser; },
    }),
  });
  browser = f.browser;
  const started = Date.now();
  const [first, second] = await Promise.all([
    f.capturer.enqueue(f.work),
    f.capturer.enqueue({ ...f.work, id: 'next' }),
  ]);
  assert.ok(Date.now() - started < 5000);
  assert.equal(first.captures.first, 'first.jpg');
  assert.equal(second.captures.mobile, 'mobile.jpg');
  assert.deepEqual(connections, ['ws://127.0.0.1:1234/first-token', 'ws://127.0.0.1:2345/second-token']);
  const leaked = { closed: false, close: async () => { leaked.closed = true; } };
  pendingContexts[0](leaked);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(leaked.closed, true);
});

test('a disconnect during navigation fails that attempt and the retry reconnects', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let f;
  f = fixture(t, {
    hang: 'goto', hangCount: 1,
    onHang: () => setImmediate(() => f.browser.emit('disconnected')),
    timeouts: { task: 10_000, goto: 5000, newContext: 1000, newPage: 1000, screenshot: 1000, close: 100, connect: 1000, route: 1000, input: 1000, text: 1000 },
  });
  const started = Date.now();
  const result = await f.capturer.enqueue(f.work);
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.captures.first, 'first.jpg');
  assert.equal(result.captures.mobile, 'mobile.jpg');
  assert.equal(f.launches.length, 2);
  assert.ok(f.contexts.every((context) => context.closed));
});

for (const step of ['goto', 'screenshot']) {
  test(`a hung ${step} fails inside the task budget and the next item still runs`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const started = Date.now();
    const f = fixture(t, {
      hang: step,
      timeouts: { task: 180, screenshot: 5000, goto: 5000, newContext: 500, newPage: 500, close: 40, connect: 500, route: 500, input: 500, text: 500 },
    });
    const [first, second] = await Promise.all([
      f.capturer.enqueue(f.work),
      f.capturer.enqueue({ ...f.work, id: 'next' }),
    ]);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
    assert.deepEqual(first.captures, {});
    assert.deepEqual(second.captures, {});
    assert.ok(f.launches.length >= 2);
    assert.ok(f.contexts.every((context) => context.closed));
  });
}

test('a hung context close is abandoned and later work reconnects', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  const f = fixture(t, {
    hang: 'close', hangCount: 1,
    timeouts: { task: 10_000, close: 50, newContext: 1000, newPage: 1000, goto: 1000, screenshot: 1000, connect: 1000, route: 1000, input: 1000, text: 1000 },
  });
  const result = await f.capturer.enqueue(f.work);
  const next = await f.capturer.enqueue({ ...f.work, id: 'next' });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.captures.first, 'first.jpg');
  assert.equal(result.captures.mobile, 'mobile.jpg');
  assert.equal(next.captures.first, 'first.jpg');
  assert.ok(f.launches.length >= 2);
  assert.ok(f.contexts.every((context) => context.closed));
});

test('moderation records an incomplete capture and continues when the browser hangs', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(t, {
    hang: 'newContext',
    timeouts: { task: 200, newContext: 40, close: 40, connect: 200, newPage: 200, goto: 200, screenshot: 200, route: 200, input: 200, text: 200 },
  });
  const works = ['a', 'b'].map((id) => ({
    id, moderation: { status: 'pending' }, title: '标题', summary: '', note: '', modelName: '', modelId: 'm',
    vendor: '', effort: '', harnessOther: '', providerOther: '', dir: f.mediaDir, entry: 'missing.html', contentKey: 'key',
  }));
  const results = [];
  const moderator = createModerator({
    config: { moderation: { enabled: true, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-6-luna' } },
    library: {
      uploads: () => works,
      uploadById: (id) => works.find((work) => work.id === id),
      finishModeration: (work, result) => { results.push({ id: work.id, status: result.status, error: result.error }); return true; },
    },
    capturer: f.capturer,
  });
  t.after(() => moderator.close());
  await new Promise((resolve) => setImmediate(resolve));
  await moderator.idle();
  assert.deepEqual(results.map((item) => item.error), ['capture_incomplete', 'capture_incomplete']);
  assert.ok(results.every((item) => item.status === 'review'));
});
