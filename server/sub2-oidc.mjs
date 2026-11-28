import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { clientIp, rateLimit, readBody, sendJson } from './http.mjs';

export const SUB2_OIDC_PATH = '/api/sso/sub2api';
const random = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest();
const jwtPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const one = (params, key) => params.getAll(key).length === 1 ? params.get(key) : '';
const urlToken = /^[A-Za-z0-9._~-]{1,256}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;

function expiringStore(limit, ttl) {
  const entries = new Map();
  return {
    put(value) {
      const now = Date.now();
      for (const [key, item] of entries) {
        if (item.expiresAt > now) break;
        entries.delete(key);
      }
      if (entries.size >= limit) return null;
      const key = random();
      entries.set(key, { value, expiresAt: now + ttl });
      return key;
    },
    get(key) {
      const item = entries.get(key);
      if (!item || item.expiresAt <= Date.now()) return null;
      return item.value;
    },
    delete(key) { entries.delete(key); },
  };
}

function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('Sub2API OIDC URLs must be HTTPS without userinfo, query or fragment');
  }
  return url;
}

function claims(user) {
  if (!user?.email || !user.email_verified_at) return null;
  return {
    sub: String(user.id),
    email: user.email,
    email_verified: true,
    preferred_username: user.name,
    name: user.nickname || user.name,
  };
}

export function createSub2OIDC({ auth, trustProxy, filename = process.env.ARENA_SUB2_OIDC_CONFIG }) {
  if (!filename) return null;
  const { issuer: issuerValue, redirectUri, loginUrl, clientId, clientSecret, privateKey } = JSON.parse(readFileSync(filename, 'utf8'));
  const issuer = secureUrl(issuerValue).href;
  const callback = secureUrl(redirectUri).href;
  const loginPage = secureUrl(loginUrl).href;
  if (!issuer.endsWith(SUB2_OIDC_PATH) || !urlToken.test(clientId) || !challengePattern.test(clientSecret)) {
    throw new Error('Invalid Sub2API OIDC configuration');
  }
  const signingKey = createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'rsa' || signingKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('Sub2API OIDC requires an RSA signing key of at least 2048 bits');
  }
  const jwk = createPublicKey(signingKey).export({ format: 'jwk' });
  const kid = digest(jwk.n).toString('base64url');
  const discovery = {
    issuer,
    authorization_endpoint: issuer + '/authorize',
    token_endpoint: issuer + '/token',
    userinfo_endpoint: issuer + '/userinfo',
    jwks_uri: issuer + '/jwks',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'email', 'email_verified', 'preferred_username', 'name'],
  };
  const requests = expiringStore(2048, 15 * 60_000);
  const codes = expiringStore(2048, 90_000);
  const tokens = expiringStore(2048, 120_000);
  const authorizeLimit = rateLimit(60_000, 40);
  const tokenLimit = rateLimit(60_000, 100);
  const invalidRequest = (res) => sendJson(res, 400, { error: 'invalid_request' });
  const busy = (res) => sendJson(res, 503, { error: 'temporarily_unavailable' });
  const redirect = (res, location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  };

  function authorize(req, res, params) {
    authorizeLimit(clientIp(req, trustProxy));
    const requestId = one(params, 'request');
    let request = requestId ? requests.get(requestId) : null;
    if (!requestId && !params.has('request')) {
      const state = one(params, 'state');
      const nonce = one(params, 'nonce');
      const challenge = one(params, 'code_challenge');
      const scope = one(params, 'scope').split(/ +/);
      if (one(params, 'client_id') !== clientId || one(params, 'redirect_uri') !== callback
        || one(params, 'response_type') !== 'code' || !scope.includes('openid')
        || scope.some((value) => !discovery.scopes_supported.includes(value))
        || one(params, 'code_challenge_method') !== 'S256' || !challengePattern.test(challenge)
        || !urlToken.test(state) || !urlToken.test(nonce)) return invalidRequest(res);
      request = { state, nonce, challenge };
    }
    if (!request) return sendJson(res, 400, { error: 'invalid_request', error_description: '请返回 Sub2API 重新发起登录。' });
    const user = auth.userFrom(req);
    const identity = claims(user);
    if (!identity) {
      const pending = requestId || requests.put(request);
      if (!pending) return busy(res);
      const target = new URL(loginPage);
      target.searchParams.set('request', pending);
      target.searchParams.set('mode', user ? 'bind' : 'login');
      return redirect(res, target.href);
    }
    const code = codes.put({ ...request, identity });
    if (!code) return busy(res);
    if (requestId) requests.delete(requestId);
    const target = new URL(callback);
    target.searchParams.set('state', request.state);
    target.searchParams.set('code', code);
    return redirect(res, target.href);
  }

  async function exchange(req, res) {
    tokenLimit(clientIp(req, trustProxy));
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
      return invalidRequest(res);
    }
    const params = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
    if (one(params, 'client_id') !== clientId || !timingSafeEqual(digest(one(params, 'client_secret')), digest(clientSecret))) {
      return sendJson(res, 401, { error: 'invalid_client' });
    }
    const code = one(params, 'code');
    const grant = codes.get(code);
    const verifier = one(params, 'code_verifier');
    if (!grant || one(params, 'grant_type') !== 'authorization_code' || one(params, 'redirect_uri') !== callback
      || !verifierPattern.test(verifier) || digest(verifier).toString('base64url') !== grant.challenge) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }
    codes.delete(code);
    const current = claims(auth.byId(grant.identity.sub));
    if (!current || current.email !== grant.identity.email) return sendJson(res, 400, { error: 'invalid_grant' });
    const accessToken = tokens.put(current);
    if (!accessToken) return busy(res);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = jwtPart({ alg: 'RS256', typ: 'JWT', kid }) + '.' + jwtPart({
      ...current, iss: issuer, aud: clientId, iat: now, exp: now + 120, nonce: grant.nonce,
    });
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), signingKey).toString('base64url');
    return sendJson(res, 200, {
      access_token: accessToken, token_type: 'Bearer', expires_in: 120, id_token: unsigned + '.' + signature,
    }, { Pragma: 'no-cache' });
  }

  return function handle(req, res, url) {
    const path = url.pathname.slice(SUB2_OIDC_PATH.length);
    if (req.method === 'GET' && path === '/authorize') return authorize(req, res, url.searchParams);
    if (req.method === 'POST' && path === '/token') return exchange(req, res);
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') return sendJson(res, 200, discovery);
    if (req.method === 'GET' && path === '/jwks') return sendJson(res, 200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    if (req.method === 'GET' && path === '/userinfo') {
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(String(req.headers.authorization ?? ''));
      const identity = bearer && tokens.get(bearer[1]);
      if (!identity) return sendJson(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer' });
      return sendJson(res, 200, identity);
    }
    return sendJson(res, 404, { error: 'not_found' });
  };
}
