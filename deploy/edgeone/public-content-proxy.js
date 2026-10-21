// Public artwork revalidation only. The origin owns access checks and validators.
// Deploy on w.arenaofbias.icu /c/w* and /c/c*; never attach to /v/ or private keys.
const PUBLIC_CONTENT_PROXY = {
  host: 'w.arenaofbias.icu',
  originTlsHost: 'api.arenaofbias.icu',
  originIp: '114.66.27.88',
  timeout: 10000,
};
const FORWARD_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'User-Agent', 'Referer', 'Origin',
  'If-None-Match', 'If-Modified-Since', 'Range', 'If-Range', 'Cache-Control', 'Pragma',
];

async function publicContentProxy(request) {
  const url = new URL(request.url);
  // Default function domains have no CDN passthrough. Reject them locally so a
  // fetch of this function's own default URL cannot create recursive invocations.
  if (url.host !== PUBLIC_CONTENT_PROXY.host) {
    return new Response('Not found', { status: 404, headers: {
      'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    } });
  }
  const eligible = url.protocol === 'https:'
    && /^\/c\/[wc][0-9a-f]{32}\//.test(url.pathname)
    && ['GET', 'HEAD'].includes(request.method);
  // Same-host fetch resumes the existing CDN path; it does not re-enter this event.
  if (!eligible) return fetch(request);

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Host', PUBLIC_CONTENT_PROXY.host);
  // A different, verified TLS hostname avoids the same-host CDN cache layer,
  // which otherwise consumes If-None-Match before forwarding to the origin.
  const target = `https://${PUBLIC_CONTENT_PROXY.originTlsHost}${url.pathname}${url.search}`;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      eo: {
        resolveOverride: PUBLIC_CONTENT_PROXY.originIp,
        timeoutSetting: {
          connectTimeout: PUBLIC_CONTENT_PROXY.timeout,
          readTimeout: PUBLIC_CONTENT_PROXY.timeout,
          writeTimeout: PUBLIC_CONTENT_PROXY.timeout,
        },
      },
    });
  } catch {
    // A transport failure falls back to today's normal download path, never to
    // stale data or a locally fabricated 304. Origin 4xx/5xx are not retried.
    return fetch(request);
  }
  // Return the original runtime response. Re-wrapping its body in new Response
  // loses the runtime's compressed-body metadata and can double-decode gzip.
  // The origin already supplies correct HEAD/304 bodies and all security headers.
  // No Cache API, body buffering, cookie forwarding, or authorization decisions.
  return upstream;
}

addEventListener('fetch', event => {
  event.respondWith(publicContentProxy(event.request));
});
