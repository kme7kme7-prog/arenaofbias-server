// Warm only the four common public boards, one at a time. The public cache still
// owns its ten-minute boundary and moderation invalidation; no stale response is served.
import { LEADERBOARD_INTERVAL_MS } from './leaderboard-cache.mjs';

export const WARM_BOARDS = [{ by: 'config' }, { by: 'model' },
  { board: 'frontend', by: 'config' }, { board: 'frontend', by: 'model' }];

export function startLeaderboardWarmup({ read, schedule = setTimeout, cancel = clearTimeout,
  onError = () => console.warn('排行榜后台预热失败，下次请求将重试。') }) {
  let closed = false, timer = null, running = null;
  const later = (delay) => {
    timer = schedule(() => {
      timer = null;
      running = (async () => {
        for (const options of WARM_BOARDS) {
          if (closed) break;
          try { await read(options); } catch { onError(); }
        }
      })().finally(() => {
        running = null;
        if (!closed) later(LEADERBOARD_INTERVAL_MS);
      });
      return running;
    }, delay);
    timer.unref?.();
  };
  later(0);
  return {
    async close() {
      closed = true;
      if (timer !== null) cancel(timer);
      await running;
    },
  };
}
