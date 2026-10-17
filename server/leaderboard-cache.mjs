// Public boards share one calculation for ten minutes, including across new votes.
// Internal match sampling keeps its own live ranking cache.
export const LEADERBOARD_INTERVAL_MS = 10 * 60_000;

export function createLeaderboardCache({ now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key, calculate) {
      const at = now();
      for (const [name, entry] of entries) if (entry.expiresAt <= at) entries.delete(name);
      if (entries.has(key)) return entries.get(key).promise;
      const entry = { expiresAt: Infinity };
      entry.promise = Promise.resolve().then(calculate).then((data) => {
        if (entries.get(key) !== entry) return this.get(key, calculate);
        entry.expiresAt = now() + LEADERBOARD_INTERVAL_MS;
        return { ...data, refreshIntervalSeconds: LEADERBOARD_INTERVAL_MS / 1000,
          nextUpdateAt: new Date(entry.expiresAt).toISOString() };
      }).catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    clear() { entries.clear(); },
  };
}
