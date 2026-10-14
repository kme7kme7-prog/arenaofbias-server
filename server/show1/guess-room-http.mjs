import { assertSameOrigin, fail, rateLimit, readJson } from '../http.mjs';
import { createGuessRooms } from './guess-rooms.mjs';

export function registerGuessRooms(router, { db, auth, config }) {
  const rooms = createGuessRooms({ db });
  const streams = new Set();
  const createUser = rateLimit(600000, 6, '创建房间太频繁，请稍后再试。');
  const createIp = rateLimit(600000, 20);
  const joinUser = rateLimit(60000, 12, '房间码尝试太多，请一分钟后再试。');
  const joinIp = rateLimit(60000, 40);
  const commandUser = rateLimit(60000, 60);
  const commandIp = rateLimit(60000, 180);
  const readUser = rateLimit(60000, 90);
  const userOf = ctx => ctx.user ?? fail(401, '登录后才能进入好友房。', 'login_required');
  function readGate(ctx) {
    const user = userOf(ctx);
    if (ctx.req.headers.origin) assertSameOrigin(ctx.req, config);
    else if (ctx.req.headers['sec-fetch-site'] && ctx.req.headers['sec-fetch-site'] !== 'same-origin') fail(403, '请求来源无效');
    readUser(user.id);
    return user;
  }
  async function command(ctx, keys) {
    assertSameOrigin(ctx.req, config);
    const user = userOf(ctx);
    commandUser(user.id); commandIp(ctx.ip);
    const body = await readJson(ctx.req, 1024);
    if (Object.keys(body).some(key => !keys.includes(key))) fail(400, '请求包含不支持的字段。');
    return { user, body };
  }
  router.on('GET', '/api/guess/friends/current', ctx => ({ room: rooms.current(readGate(ctx)) }));
  router.on('GET', '/api/guess/friends/catalog', ctx => { readGate(ctx); return rooms.catalog(); });
  router.on('GET', '/api/guess/friends/:code/state', ctx => ({ room: rooms.sync(readGate(ctx), ctx.params.code) }));
  router.on('POST', '/api/guess/friends/create', async ctx => {
    const { user, body } = await command(ctx, ['difficulty']);
    createUser(user.id); createIp(ctx.ip);
    return { room: rooms.create(user, body.difficulty) };
  });
  router.on('POST', '/api/guess/friends/join', async ctx => {
    const { user, body } = await command(ctx, ['code']);
    joinUser(user.id); joinIp(ctx.ip);
    return { room: rooms.join(user, body.code) };
  });
  router.on('POST', '/api/guess/friends/:code/ready', async ctx => {
    const { user, body } = await command(ctx, ['ready']);
    return { room: rooms.ready(user, ctx.params.code, body.ready) };
  });
  router.on('POST', '/api/guess/friends/:code/guess', async ctx => {
    const { user, body } = await command(ctx, ['round', 'guessId', 'requestId']);
    return { room: rooms.guess(user, ctx.params.code, body) };
  });
  router.on('POST', '/api/guess/friends/:code/leave', async ctx => {
    const { user } = await command(ctx, []);
    return rooms.leave(user, ctx.params.code);
  });
  function push(stream) {
    try {
      const user = auth.userFrom(stream.req);
      if (!user || user.id !== stream.user.id) return stream.close();
      const view = rooms.read(user, stream.code);
      // A slow reader must not accumulate an unbounded event queue.
      if (stream.res.writableLength > 65536) return stream.close();
      stream.res.write(`event: room\ndata: ${JSON.stringify(view)}\n\n`);
    } catch { stream.close(); }
  }
  const unsubscribe = rooms.subscribe(code => {
    for (const stream of streams) if (stream.code === code) push(stream);
  });
  router.on('GET', '/api/guess/friends/:code/events', ctx => {
    if (ctx.req.method !== 'GET') fail(405, '不支持这个操作');
    const user = readGate(ctx);
    if (streams.size >= 512 || [...streams].filter(s => s.user.id === user.id).length >= 2) fail(429, '好友房连接过多，请关闭其他好友房标签页。');
    rooms.sync(user, ctx.params.code);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin, Cookie',
    });
    ctx.res.write('retry: 3000\n\n');
    const stream = { req: ctx.req, res: ctx.res, user, code: ctx.params.code, close: () => {} };
    stream.close = () => { streams.delete(stream); ctx.res.end(); };
    ctx.res.on('close', () => streams.delete(stream));
    streams.add(stream);
    push(stream);
  });
  let pulse = 0;
  const timer = setInterval(() => {
    try {
      rooms.tick();
      if (++pulse % 5 !== 0) return;
      const touched = new Set();
      for (const stream of streams) {
        const user = auth.userFrom(stream.req);
        if (!user || user.id !== stream.user.id) { stream.close(); continue; }
        const key = `${stream.code}:${user.id}`;
        if (touched.has(key)) continue;
        touched.add(key);
        try { rooms.sync(user, stream.code); } catch { stream.close(); }
      }
    } catch (error) { console.error('[guess-friends]', error); }
  }, 1000);
  timer.unref();
  return {
    close() { clearInterval(timer); unsubscribe(); for (const stream of streams) stream.close(); },
  };
}
