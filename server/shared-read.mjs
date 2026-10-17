// Share public read work, never user-specific response fields. Recheck the revision
// after yielding so a withdrawal during a build cannot publish the old result.
export function createSharedRead({ revision, read, ttl = 5000, now = Date.now }) {
  const pending = new Map();
  let cached;
  return async () => {
    for (;;) {
      const key = revision();
      if (cached?.key === key && now() - cached.at < ttl) return cached.value;
      if (!pending.has(key)) {
        const promise = Promise.resolve().then(read).then((value) => ({ key, value, at: now() }))
          .finally(() => pending.delete(key));
        pending.set(key, promise);
      }
      const entry = await pending.get(key);
      if (revision() !== key) continue;
      cached = entry;
      return entry.value;
    }
  };
}
