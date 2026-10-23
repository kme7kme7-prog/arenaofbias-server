import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureOptionsConfig, captureTimeoutConfig } from '../server/config.mjs';
import { createCapturer, frameGuard } from '../server/capture.mjs';
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
    const frame = (value) => ({ locator: () => ({ innerText: async () => value }),
      evaluate: async (expression) => {
        (options.evaluated ??= []).push(expression);
        if (/\.webgl === true$/.test(expression)) options.onProbe?.();
        return /\.webgl === true$/.test(expression) ? Boolean(options.webgl) : undefined;
      } });
    context.newPage = async () => ({
      waitForLoadState: async (state, settings) => {
        context.load = { state, settings };
        if (options.loadTimeout) throw Object.assign(new Error('load timeout'), { name: 'TimeoutError' });
      },
      goto: async (_url, navigation) => {
        context.navigation = navigation;
        if (consumeHang(options, 'goto')) await new Promise(() => {});
        if (options.fail?.(settings, attempt)) throw new Error('page failed');
        return { ok: () => true };
      },
      waitForTimeout: async ms => { (context.waits ??= []).push(ms); },
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
  browser.close = async () => { f.closes = (f.closes ?? 0) + 1; browser.emit('disconnected'); };
  const library = { mediaDir, publicContent: () => true, originOf: () => 'http://work.localhost',
    hasDirectory: () => true, setCaptures: (id, captures) => saved.push({ id, captures }), ...options.library };
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

test('private job dimensions and bounded wait are applied without late input or public publication', async t => {
  const f=fixture(t,{config:{captureSandbox:true}}), directory=join(f.mediaDir,'private-job');
  const result=await f.capturer.enqueue(f.work,{publish:false,outputDir:directory,late:false,detailed:true,
    shots:[{id:'first',viewport:{width:800,height:600},mobile:false},{id:'mobile',viewport:{width:360,height:640},mobile:true}],wait:{load:'domcontentloaded',settleMs:25}});
  assert.deepEqual(result.captures,{first:'first.jpg',mobile:'mobile.jpg'}); assert.deepEqual(result.late,{}); assert.equal(f.saved.length,0);
  assert.deepEqual(f.contexts.map(context=>context.settings.viewport),[{width:800,height:600},{width:360,height:640}]);
  assert.ok(f.contexts.every(context=>context.shots.length===1&&context.shots[0].startsWith(directory)&&!context.load&&context.waits.join(',')==='25'));
  assert.equal(f.launches[0].chromiumSandbox,true);
});

test('cancelling a private job in the shared queue leaves earlier normal capture untouched', async t => {
  const f=fixture(t), controller=new AbortController();
  const normal=f.capturer.enqueue(f.work);
  const privateJob=f.capturer.enqueue({...f.work,id:'private'},{publish:false,detailed:true,signal:controller.signal,beforeCapture:()=>assert.fail('cancelled queued work must not execute')});
  controller.abort();
  assert.equal((await privateJob).error.code,'capture_cancelled'); assert.equal((await normal).captures.first,'first.jpg'); assert.equal(f.contexts.length,2);
});

test('private authority is checked again after connecting and cannot capture a stale work', async t => {
  const f=fixture(t); t.mock.method(console,'warn',()=>{}); let checked=0;
  const result=await f.capturer.enqueue(f.work,{publish:false,detailed:true,beforeCapture:()=>{if(++checked===2) throw Object.assign(new Error('revoked'),{code:'scope_required'});return f.work;}});
  assert.equal(result.error.code,'scope_required'); assert.equal(f.contexts.length,0); assert.equal(f.saved.length,0);
});

test('recovered viewport retry clears only its own detailed error', async t => {
  const f=fixture(t,{fail:(_settings,attempt)=>attempt===0}); t.mock.method(console,'warn',()=>{});
  const recovered=await f.capturer.enqueue(f.work,{publish:false,detailed:true,late:false});
  assert.deepEqual(Object.keys(recovered.captures),['first','mobile']); assert.equal(Object.hasOwn(recovered,'error'),false);
  const g=fixture(t,{fail:(settings,attempt)=>!settings.isMobile||attempt===0});
  const partial=await g.capturer.enqueue(g.work,{publish:false,detailed:true,late:false});
  assert.deepEqual(Object.keys(partial.captures),['mobile']); assert.equal(partial.error.code,'page_failed');
});

test('abort during a WebGL probe never starts a screenshot afterwards', async t => {
  const controller=new AbortController(),f=fixture(t,{onProbe:()=>controller.abort()});t.mock.method(console,'warn',()=>{});
  const result=await f.capturer.enqueue(f.work,{publish:false,detailed:true,late:false,signal:controller.signal});
  assert.equal(result.error.code,'capture_cancelled');assert.ok(f.contexts.every(context=>!context.shots?.length));
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

const RETRY = { retryBase: 20, retryMax: 40, unavailable: 60_000 };

for (const failure of ['missing endpoint', 'connection']) {
  test(`remote ${failure} failure waits and retries without a cooldown or logging the endpoint token`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
    const endpointFile = join(directory, 'endpoint');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (failure === 'connection') writeFileSync(endpointFile, 'ws://127.0.0.1:1234/private-token\n');
    let attempts = 0;
    let browser;
    const f = fixture(t, { timeouts: RETRY, config: { captureEndpointFile: endpointFile }, loadChromium: async () => ({
      launch: async () => assert.fail('remote failure must not launch locally'),
      connect: async () => {
        attempts++;
        if (attempts < 3) throw new Error('Failed ws://127.0.0.1:1234/private-token');
        return browser;
      },
    }) });
    browser = f.browser;
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal(await f.capturer.initialize(), false);
    assert.equal(f.capturer.available, false);
    if (failure === 'missing endpoint') {
      attempts = 1;
      setTimeout(() => writeFileSync(endpointFile, 'ws://127.0.0.1:1234/private-token\n'), 10);
    }
    const result = await f.capturer.enqueue(f.work);
    assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
    assert.equal(attempts, 3);
    assert.equal(f.capturer.available, true);
    assert.equal(warn.mock.callCount(), 1);
    assert.doesNotMatch(warn.mock.calls[0].arguments[0], /private-token/);
  });
}

test('a long outage gives up per item, then capture resumes when the service returns', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
  const endpointFile = join(directory, 'endpoint');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let up = false;
  let browser;
  const f = fixture(t, { timeouts: { ...RETRY, unavailable: 80 }, config: { captureEndpointFile: endpointFile }, loadChromium: async () => ({
    connect: async () => { if (!up) throw new Error('refused'); return browser; },
  }) });
  browser = f.browser;
  t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  const first = await f.capturer.enqueue(f.work);
  assert.equal(first.unavailable, true);
  assert.ok(Date.now() - started >= 60, 'the item waited before giving up');
  assert.equal((await f.capturer.enqueue({ ...f.work, id: 'next' })).unavailable, true);
  writeFileSync(endpointFile, 'ws://127.0.0.1:1234/token\n');
  up = true;
  assert.equal((await f.capturer.enqueue({ ...f.work, id: 'later' })).captures.first, 'first.jpg');
});

test('a disconnect from a restarting service mid-item waits and redoes the item', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-endpoint-'));
  const endpointFile = join(directory, 'endpoint');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(endpointFile, 'ws://127.0.0.1:1234/token\n');
  let f;
  let connects = 0;
  f = fixture(t, {
    timeouts: { ...RETRY, task: 10_000, goto: 5000, close: 100 },
    hang: 'goto', hangCount: 1,
    onHang: () => setImmediate(() => {
      rmSync(endpointFile);
      f.browser.emit('disconnected');
      setTimeout(() => writeFileSync(endpointFile, 'ws://127.0.0.1:2345/token\n'), 30);
    }),
    config: { captureEndpointFile: endpointFile },
    loadChromium: async () => ({ connect: async () => { connects++; return f.browser; } }),
  });
  t.mock.method(console, 'warn', () => {});
  const result = await f.capturer.enqueue(f.work);
  assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
  assert.equal(connects, 2);
});

test('a WebGL page gets the longer limits and its frames pause around each screenshot', async (t) => {
  const options = { webgl: true, timeouts: { screenshot: 1111, webglScreenshot: 2222 } };
  const f = fixture(t, options);
  const result = await f.capturer.enqueue(f.work);
  assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
  assert.ok(f.contexts.every((context) => context.screenshotTimeout === 2222));
  const actions = options.evaluated.map((expression) => /\.(pause|resume)\(\)$/.exec(expression)?.[1]).filter(Boolean);
  assert.deepEqual(actions, Array(6).fill(['pause', 'resume']).flat());
  const plain = { timeouts: { screenshot: 1111, webglScreenshot: 2222 } };
  const g = fixture(t, plain);
  await g.capturer.enqueue(g.work);
  assert.ok(g.contexts.every((context) => context.screenshotTimeout === 1111));
  assert.equal(plain.evaluated.some((expression) => /pause/.test(expression)), false);
});

test('a WebGL page extends the job limit so its second viewport still runs', async (t) => {
  const timeouts = { task: 60, webglTask: 5000, goto: 1000, newContext: 1000, newPage: 1000, screenshot: 1000, close: 100, connect: 1000 };
  const slow = (options) => fixture(t, { ...options, timeouts });
  const f = slow({ webgl: true });
  const g = slow({ webgl: false });
  for (const item of [f, g]) {
    const contexts = item.contexts;
    item.browser.newContext = ((original) => async (settings) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return original(settings);
    })(item.browser.newContext);
    void contexts;
  }
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(Object.keys((await f.capturer.enqueue(f.work)).captures), ['first', 'mobile']);
  assert.notDeepEqual(Object.keys((await g.capturer.enqueue(g.work)).captures), ['first', 'mobile']);
});

test('a page whose load event never fires is shot as it stands', async (t) => {
  const f = fixture(t, { loadTimeout: true });
  const warn = t.mock.method(console, 'warn', () => {});
  const result = await f.capturer.enqueue(f.work);
  assert.deepEqual(result.captures, { first: 'first.jpg', mobile: 'mobile.jpg' });
  assert.ok(f.contexts.every((context) => context.navigation.waitUntil === 'domcontentloaded' && context.load.state === 'load'));
  assert.ok(warn.mock.calls.some((call) => /未在时限内加载完/.test(call.arguments[0])));
});

test('the frame guard throttles animation frames only after a WebGL context and can pause them', async () => {
  let clock = 0;
  const queued = [];
  const canvas = function HTMLCanvasElement() {};
  canvas.prototype.getContext = function getContext(type) { return { type }; };
  const scope = { requestAnimationFrame: (callback) => { queued.push(callback); return queued.length; }, HTMLCanvasElement: canvas,
    setTimeout };
  const run = new Function('globalThis', frameGuard(10));
  run(scope);
  const tick = () => { clock += 1000 / 60; const batch = queued.splice(0); for (const callback of batch) callback(clock); };
  let calls = 0;
  const loop = () => { calls++; scope.requestAnimationFrame(loop); };
  scope.requestAnimationFrame(loop);
  for (let i = 0; i < 30; i++) tick();
  assert.equal(calls, 30);
  new canvas().getContext('webgl2');
  calls = 0;
  for (let i = 0; i < 60; i++) tick();
  assert.ok(calls >= 9 && calls <= 11, `throttled to about 10 fps, got ${calls}`);
  const control = scope[Symbol.for('aob.capture.frames')];
  assert.equal(control.webgl, true);
  control.pause();
  calls = 0;
  for (let i = 0; i < 30; i++) tick();
  assert.equal(calls, 0);
  control.resume();
  for (let i = 0; i < 30; i++) tick();
  assert.ok(calls > 0);
  const id = scope.requestAnimationFrame(() => assert.fail('cancelled callback ran'));
  scope.cancelAnimationFrame(id);
});

test('an oversized entry page skips the screenshot queue and moderation sends it to people', async (t) => {
  const f = fixture(t, { config: { captureOptions: { maxPageBytes: 100 } }, loadChromium: async () => assert.fail('no browser for oversized work') });
  t.mock.method(console, 'warn', () => {});
  writeFileSync(join(f.mediaDir, 'big.html'), 'x'.repeat(101));
  writeFileSync(join(f.mediaDir, 'small.html'), 'x'.repeat(100));
  const big = { ...f.work, dir: f.mediaDir, entry: 'big.html' };
  assert.equal(await f.capturer.enqueue(big), null);
  let captured = 0;
  const works = [{ ...big, id: 'big' }, { ...big, id: 'gone', entry: 'gone.html' }].map((work) => ({
    ...work, moderation: { status: 'pending' }, title: '标题', summary: '', note: '', modelName: '', modelId: 'm',
    vendor: '', effort: '', harnessOther: '', providerOther: '',
  }));
  const results = [];
  const moderator = createModerator({
    config: { captureOptions: { maxPageBytes: 100 }, moderation: { enabled: true, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-6-luna' } },
    library: { uploads: () => works, uploadById: (id) => works.find((work) => work.id === id),
      finishModeration: (work, result) => { results.push([work.id, result.status, result.error]); return true; } },
    capturer: { enqueue: async () => { captured++; return null; } },
  });
  t.after(() => moderator.close());
  await new Promise((resolve) => setImmediate(resolve));
  await moderator.idle();
  assert.deepEqual(results, [['big', 'review', 'page_too_large'], ['gone', 'review', 'page_missing']]);
  assert.equal(captured, 0);
  assert.equal(captureOptionsConfig({ CAPTURE_MAX_PAGE_BYTES: '1048576' }).maxPageBytes, 1048576);
  assert.equal(captureOptionsConfig({}).maxPageBytes, 5 * 1024 * 1024);
});

test('moderation records capture_unavailable when the service stays down', async (t) => {
  const results = [];
  const work = { id: 'w', moderation: { status: 'pending' }, title: '', dir: tmpdir(), entry: '.' };
  const moderator = createModerator({
    config: { moderation: { enabled: true, apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } },
    library: { uploads: () => [work], uploadById: () => work, finishModeration: (_work, result) => { results.push(result.error); return true; } },
    capturer: { enqueue: async () => ({ unavailable: true, captures: {}, late: {}, texts: [] }) },
  });
  t.after(() => moderator.close());
  await new Promise((resolve) => setImmediate(resolve));
  await moderator.idle();
  assert.deepEqual(results, ['capture_unavailable']);
});

test('capture timeout configuration keeps positive overrides and falls back otherwise', () => {
  assert.deepEqual(captureTimeoutConfig({}), {
    task: 180_000, newContext: 45_000, newPage: 30_000, goto: 45_000, screenshot: 60_000, close: 15_000, connect: 30_000,
    webglTask: 300_000, webglScreenshot: 120_000, retryBase: 5_000, retryMax: 60_000, unavailable: 1_800_000,
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
    vendor: '', effort: '', harnessOther: '', providerOther: '', dir: f.mediaDir, entry: 'index.html', contentKey: 'key',
  }));
  writeFileSync(join(f.mediaDir, 'index.html'), '<p>ok</p>');
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

test('a work without a capture address is skipped before the browser starts', async (t) => {
  const f = fixture(t, { library: { captureOrigin: () => null } });
  assert.equal(await f.capturer.enqueue(f.work), null);
  assert.deepEqual((await f.capturer.enqueue(f.work, { detailed: true })).error, { code: 'not_found', stage: 'initialize' });
  assert.deepEqual([f.launches.length, f.contexts.length, f.saved.length], [0, 0, 0]);
});
