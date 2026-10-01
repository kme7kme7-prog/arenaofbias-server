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
    const context = { settings, closed: false, route: async () => {}, routeWebSocket: async () => {},
      close: async () => { context.closed = true; } };
    const attempt = contexts.filter((item) => item.settings.isMobile === settings.isMobile).length;
    contexts.push(context);
    context.newPage = async () => ({
      goto: async () => {
        if (options.fail?.(settings, attempt)) throw new Error('page failed');
        return { ok: () => true };
      },
      waitForTimeout: async () => {}, screenshot: async () => {},
      locator: () => ({ innerText: async () => settings.isMobile ? 'mobile text' : 'desktop text' }),
    });
    return context;
  };
  browser.close = async () => browser.emit('disconnected');
  const library = { mediaDir, contentAllowed: () => true, originOf: () => 'http://work.localhost',
    hasDirectory: () => true, setCaptures: (id, captures) => saved.push({ id, captures }) };
  const capturer = createCapturer({ config: { capture: true, cdn: [], ...options.config }, library,
    loadChromium: options.loadChromium ?? (async () => ({ launch: async () => browser })), now: options.now });
  t.after(async () => { await capturer.close(); rmSync(mediaDir, { recursive: true, force: true }); });
  return { capturer, browser, contexts, saved, work: { id: 'work', contentKey: 'key' } };
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
    captures: { first: 'first.jpg', mobile: 'mobile.jpg' }, texts: ['desktop text', 'mobile text'],
  });
  assert.deepEqual(f.contexts.map((context) => context.settings.isMobile), [false, false, true, true]);
  assert.ok(f.contexts.every((context) => context.closed));
  assert.equal(f.saved.length, 1);
});

test('a viewport gives up after its second failure while the other viewport completes', async (t) => {
  const f = fixture(t, { fail: (settings) => !settings.isMobile });
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.capturer.enqueue(f.work), { captures: { mobile: 'mobile.jpg' }, texts: ['mobile text'] });
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
