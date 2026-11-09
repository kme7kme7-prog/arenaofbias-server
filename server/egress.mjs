// Shared egress check for anything that connects to a name the upload can influence.
// Capture uses it before every hop. A private, link-local, metadata or documentation
// address is refused, including when only one of a name's records is private.
// Connections that do happen are pinned to the addresses this check just accepted.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
const ban = (network, prefix, family = 'ipv4') => blocked.addSubnet(network, prefix, family);
ban('0.0.0.0', 8);
ban('10.0.0.0', 8);
ban('100.64.0.0', 10);
ban('127.0.0.0', 8);
ban('169.254.0.0', 16);
ban('172.16.0.0', 12);
ban('192.0.0.0', 24);
ban('192.0.2.0', 24);
ban('192.168.0.0', 16);
ban('198.18.0.0', 15);
ban('198.51.100.0', 24);
ban('203.0.113.0', 24);
ban('224.0.0.0', 4);
ban('240.0.0.0', 4);
ban('::', 128, 'ipv6');
ban('::1', 128, 'ipv6');
ban('fc00::', 7, 'ipv6');
ban('fe80::', 10, 'ipv6');
ban('ff00::', 8, 'ipv6');
ban('2001:db8::', 32, 'ipv6');

const BAD_HOST = /^(localhost|metadata|metadata\.google|metadata\.google\.internal|metadata\.aws|instance-data)$/i;
const BAD_SUFFIX = /(\.localhost|\.local|\.localdomain|\.internal|\.alt)$/i;

function mappedV4(address) {
  const text = String(address).toLowerCase();
  if (text.startsWith('::ffff:')) {
    const rest = text.slice(7);
    if (isIP(rest) === 4) return rest;
  }
  return null;
}

// allowLoopback is only for the capture worker's explicit connect to 127.0.0.1
// after it has already rewritten the work's own *.localhost host. It does not
// permit a CDN name, a redirect, or any other loopback address.
export function isBlockedAddress(address, { allowLoopback = false } = {}) {
  const text = String(address ?? '').trim().toLowerCase();
  if (!text) return true;
  if (allowLoopback && (text === '127.0.0.1' || text === '::1')) return false;
  const v4 = mappedV4(text);
  if (v4) return isBlockedAddress(v4, { allowLoopback: false });
  const family = isIP(text);
  if (family !== 4 && family !== 6) return true;
  return blocked.check(text, family === 4 ? 'ipv4' : 'ipv6');
}

export function isBlockedHostname(hostname) {
  const host = String(hostname ?? '').replace(/\.$/, '').toLowerCase();
  if (!host || BAD_HOST.test(host) || BAD_SUFFIX.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

export async function resolvePublic(hostname, { lookup = defaultLookup, allowLoopback = false } = {}) {
  const host = String(hostname ?? '').replace(/\.$/, '').toLowerCase();
  if (isBlockedHostname(host)) return { ok: false, reason: 'hostname' };
  if (isIP(host)) {
    if (isBlockedAddress(host, { allowLoopback })) return { ok: false, reason: 'address' };
    return { ok: true, addresses: [{ address: host, family: isIP(host) }] };
  }
  let rows;
  try { rows = await lookup(host); }
  catch { return { ok: false, reason: 'dns' }; }
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'dns' };
  const addresses = rows.map((row) => ({ address: row.address, family: row.family || isIP(row.address) }));
  if (addresses.some((row) => !row.address || isBlockedAddress(row.address, { allowLoopback: false }))) {
    return { ok: false, reason: 'address' };
  }
  // Loopback is never accepted from DNS. allowLoopback applies only to an IP literal
  // the capture worker chose itself.
  if (!allowLoopback && addresses.some((row) => row.address === '127.0.0.1' || row.address === '::1')) {
    return { ok: false, reason: 'address' };
  }
  return { ok: true, addresses };
}

export function screenEgress(url, options) {
  let parsed = url;
  try { if (!(url instanceof URL)) parsed = new URL(url); }
  catch { return Promise.resolve({ ok: false, reason: 'url' }); }
  if (parsed.username || parsed.password) return Promise.resolve({ ok: false, reason: 'url' });
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve({ ok: false, reason: 'url' });
  return resolvePublic(parsed.hostname, options);
}

function defaultLookup(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const family = options?.family;
    const list = addresses.filter((row) => !family || row.family === family);
    if (!list.length) {
      const error = new Error('egress blocked');
      error.code = 'ENETUNREACH';
      callback(error);
      return;
    }
    if (options?.all) callback(null, list.map((row) => ({ address: row.address, family: row.family })));
    else callback(null, list[0].address, list[0].family);
  };
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

// One hop. Does not follow redirects. Pins DNS to the vetted addresses.
export function guardedRequest(url, { method = 'GET', headers = {}, lookup, allowLoopback = false, timeout = 15000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const target = url instanceof URL ? url : new URL(url);
  return screenEgress(target, { lookup, allowLoopback }).then((verdict) => {
    if (!verdict.ok) {
      const error = new Error('egress blocked');
      error.code = 'EGRESS_BLOCKED';
      throw error;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers, host: headers.host || target.host };
    delete requestHeaders.authorization;
    delete requestHeaders.Authorization;
    delete requestHeaders.cookie;
    delete requestHeaders.Cookie;
    return new Promise((resolve, reject) => {
      const req = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        lookup: pinnedLookup(verdict.addresses),
        servername: target.hostname,
        timeout,
        rejectUnauthorized: true,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            req.destroy(Object.assign(new Error('egress body too large'), { code: 'EGRESS_BLOCKED' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = res.headers;
          const safe = {};
          for (const [key, value] of Object.entries(raw)) {
            if (HOP_HEADERS.has(key.toLowerCase())) continue;
            safe[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          }
          resolve({ status: res.statusCode, headers: safe, body: Buffer.concat(chunks) });
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('egress timeout'), { code: 'EGRESS_BLOCKED' })));
      req.on('error', reject);
      req.end();
    });
  });
}
