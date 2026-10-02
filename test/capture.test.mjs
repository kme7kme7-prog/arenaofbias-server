import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapturer } from '../server/capture.mjs';

function fixture(t, options = {}) {
  // Keep routine capability logs out of the concurrent test runner's output.
  t.mock.method(console, 'info', () => {});
  const mediaDir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  const contexts = [];
  const saved = [];
  const browser = new EventEmitter();
  browser.newContext = async (settings) => {
    const context = { settings, closed: false, scripts: [], route: async () => {}, routeWebSocket: async () => {},
      addInitScript: async (script) => { context.scripts.push(script); }, close: async () => { context.closed = true; } };
    const attempt = contexts.filter((item) => item.settings.isMobile === settings.isMobile).length;
    contexts.push(context);
    const text = settings.isMobile ? 'mobile text' : 'desktop text';
    const frame = (value) => ({ locator: () => ({ innerText: async () => value }) });
    context.newPage = async () => ({
      goto: async () => {
        if (options.fail?.(settings, attempt)) throw new Error('page failed');
        return { ok: () => true };
      },
      waitForTimeout: async () => {}, screenshot: async ({ path }) => { context.shots = [...(context.shots ?? []), path]; },
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
  const capturer = createCapturer({ config: { capture: true, cdn: [], ...options.config }, library,
    loadChromium: options.loadChromium ?? (async () => ({ launch: async (settings) => { f.launches.push(settings); return browser; } })), now: options.now });
  t.after(async () => { await capturer.close(); rmSync(mediaDir, { recursive: true, force: true }); });
  f = { capturer, browser, contexts, saved, launches: [], work: { id: 'work', contentKey: 'key' } };
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
