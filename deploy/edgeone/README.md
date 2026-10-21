# Public artwork conditional proxy

`public-content-proxy.js` restores browser conditional requests that the normal
EdgeOne cache layer consumes. It is deployed in EdgeOne, not loaded by the Node
service. Do not replace VPS runtime files to install it.

## Scope and access

Attach only to host `w.arenaofbias.icu`, URL path `/c/w*` or `/c/c*`. The function
additionally requires a complete lowercase public key and GET/HEAD. `/v/`, `p/d/m/e`,
OPTIONS and other requests keep their existing CDN path. Unmatched/default function
hosts return local 404 to prevent recursive invocation.

Every eligible read goes to the existing origin, including requests with an ETag.
The origin checks current visibility before deciding 200/304/410. No Cache API,
edge ETag comparison, offline/stale reuse or shared artwork cache is introduced.
Cookies, authorization and client-provided forwarding headers are not forwarded.
CSP, CORS, opaque sandbox, artwork bytes and origin responses are preserved.
Existing reverse-proxy rate limits remain enabled; this change does not introduce
a new trusted client-IP header. Those existing limits still identify the proxy
egress rather than trusting arbitrary browser-supplied IPs.

## Transport

The fixed HTTPS target uses the existing `api.arenaofbias.icu` certificate, fixed
`resolveOverride` origin IP, and HTTP Host `w.arenaofbias.icu`. Both names already
exist on that server. Keeping the fetch URL on the incoming work host would send
the request back through the CDN cache layer and lose the conditional header.
If the origin IP or TLS hostname changes, update this configuration and repeat
the HTTPS, Host routing and conditional tests before changing the trigger.

Connect/read/write timeouts are 10 seconds. A transport exception falls back once
to the ordinary same-host CDN download. Origin errors are returned directly;
there is no fallback to stale bytes or a fabricated 304.

Return the original fetch Response object. On the actual EdgeOne runtime,
reconstructing it from `upstream.body` and original headers broke gzip metadata.
Do not buffer/recompress large bodies or force identity encoding as a workaround.

## Release and rollback

1. Run `node --test test/edgeone-content-proxy.test.mjs` and `npm run check`.
2. Create/update the function from this exact source. Review the affected triggers.
3. Start with a small public w/c allowlist. Check plain/gzip bytes against the
   direct origin, conditional GET/HEAD, folded/framed queries and resource URLs.
4. In a real browser, verify two trusted shells and their opaque work frames;
   the second read must receive network 304. Playwright routing disables HTTP
   cache, so a routed parent fixture cannot prove normal browser revalidation.
5. Expand to the two public path patterns only after the canary passes. Wait for
   rule propagation and check additional works outside the initial allowlist.
6. Roll back by deleting only this function's public-content trigger. Requests
   resume ordinary CDN downloads; do not disable the whole domain or restore a
   database. Keep the source-side public revalidation implementation installed.

Production registration on 2026-10-22: zone `zone-3wb5tl3hq9ed`, function
`ef-00wtb0hf`, trigger `rule-67yp26w0`, name `Public artwork conditional proxy`.
The earlier failed gzip canary trigger `rule-m6sska32` was removed.

## Usage budget

The user approved additional function charges with a 10 CNY/month warning budget.
This is not an automatic hard cap or an installed recurring monitor. The console
reports approximately three hours of usage delay. Do not use the domain-wide
traffic cap as a function-only rollback: it can stop the entire website.

The personal plan includes 3 million invocations and 3 million CPU milliseconds
per plan cycle. Current extra rates are 1.7 CNY/million invocations and 0.11
CNY/million CPU milliseconds; existing CDN traffic/request charges are separate.
[Official pricing](https://cloud.tencent.com/document/product/1552/116698).

Origin logs on October 20/21 recorded 3,810/3,893 public-path requests per day,
approximately 117,000 per 30 days at the latter rate. This is a source-log estimate,
not the delayed EdgeOne bill. Growth, bots and CPU time remain uncertain.
At release the console reported 76.4 GB content traffic and 1.2353 million HTTP
requests for the displayed period; the plan's existing 50 GB traffic quota was
already consumed. Do not describe those existing CDN overages as new function fees.
