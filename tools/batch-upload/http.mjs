// Fixed production origin. Redirects are refused so Authorization cannot leave this host.
import https from 'node:https';
import { parseStrictJson } from './json.mjs';

export const ORIGIN = 'https://api.arenaofbias.icu';

// The confirmation page is printed for a person to open. It must stay on ORIGIN.
export function assertVerificationUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw Object.assign(new Error('确认页地址无效'), { status: 0 });
  }
  let page;
  try { page = new URL(value, ORIGIN); }
  catch { throw Object.assign(new Error('确认页地址无效'), { status: 0 }); }
  if (page.origin !== ORIGIN || page.protocol !== 'https:' || page.username || page.password) {
    throw Object.assign(new Error('确认页地址无效'), { status: 0 });
  }
  return page;
}

export function endpoint(path) {
  if (typeof path !== 'string' || path.startsWith('http:') || path.startsWith('https:') || !path.startsWith('/')) {
    throw Object.assign(new Error('拒绝绝对地址'), { status: 0 });
  }
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw Object.assign(new Error('拒绝跨主机请求'), { status: 0 });
  return url;
}

function nodeTransport({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers,
      timeout: 60_000,
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { status: 0 })));
    req.on('error', reject);
    req.end(body);
  });
}

export async function apiRequest(method, path, { headers = {}, body = null, transport = nodeTransport } = {}) {
  const url = endpoint(path);
  const response = await transport({ method, url, headers, body });
  if (response.status >= 300 && response.status < 400) {
    throw Object.assign(new Error('redirect_refused'), { status: response.status });
  }
  return response;
}

export async function apiJson(method, path, { headers, body, transport } = {}) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const response = await apiRequest(method, path, {
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...headers,
    },
    body: payload,
    transport,
  });
  let data = {};
  try { data = parseStrictJson(response.body.toString('utf8') || '{}'); }
  catch (error) {
    if (error.message === '拒绝特殊字段名') throw error;
    data = {};
  }
  return { status: response.status, headers: response.headers, data };
}
