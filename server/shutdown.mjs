// Stop accepting connections and wait for open responses. After forceAfterMs the
// remaining connections are closed, so a stuck stream cannot hold a restart.
export function drainServers(servers, { forceAfterMs } = {}) {
  const force = forceAfterMs === undefined ? null
    : setTimeout(() => { for (const server of servers) server.closeAllConnections?.(); }, forceAfterMs);
  force?.unref();
  return Promise.all(servers.map((server) => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))).finally(() => clearTimeout(force));
}
