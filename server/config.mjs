// Platform configuration. Every value can be overridden with an environment variable;
// the defaults suit a single machine running `npm start` after `npm run build`.
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateContentOrigin } from './content-path.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const int = (value, fallback) => (/^\d+$/.test(value ?? '') ? Number(value) : fallback);
const list = (value, fallback) => (value ?? fallback).split(',').map((item) => item.trim()).filter(Boolean);

export function parseTrustProxy(value = '') {
  if (['1', 'loopback'].includes(value)) return true;
  if (['', '0'].includes(value)) return false;
  throw new Error('TRUST_PROXY must be 0, 1, or loopback');
}

// Positive overrides. Zero, blank and non-digits keep the default so a bad value
// cannot turn the capture queue's safety limits off.
function positive(source, name, fallback) {
  const raw = source[name];
  if (raw == null || raw === '' || !/^\d+$/.test(String(raw))) return fallback;
  const value = Number(raw);
  return value > 0 ? value : fallback;
}

export function captureTimeoutConfig(source = {}) {
  const ms = (name, fallback) => positive(source, name, fallback);
  return {
    task: ms('CAPTURE_TASK_TIMEOUT_MS', 180_000),
    newContext: ms('CAPTURE_NEW_CONTEXT_TIMEOUT_MS', 45_000),
    newPage: ms('CAPTURE_NEW_PAGE_TIMEOUT_MS', 30_000),
    goto: ms('CAPTURE_GOTO_TIMEOUT_MS', 45_000),
    screenshot: ms('CAPTURE_SCREENSHOT_TIMEOUT_MS', 60_000),
    close: ms('CAPTURE_CLOSE_TIMEOUT_MS', 15_000),
    connect: ms('CAPTURE_CONNECT_TIMEOUT_MS', 30_000),
    // A page that creates a WebGL context gets a longer job and screenshot limit.
    webglTask: ms('CAPTURE_WEBGL_TASK_TIMEOUT_MS', 300_000),
    webglScreenshot: ms('CAPTURE_WEBGL_SCREENSHOT_TIMEOUT_MS', 120_000),
    // While the capture service cannot be reached the queue waits and retries.
    retryBase: ms('CAPTURE_RETRY_BASE_MS', 5_000),
    retryMax: ms('CAPTURE_RETRY_MAX_MS', 60_000),
    unavailable: ms('CAPTURE_UNAVAILABLE_MAX_MS', 1_800_000),
  };
}

// WebGL frame cap and the entry page size that skips screenshots.
export function captureOptionsConfig(source = {}) {
  return {
    webglFps: positive(source, 'CAPTURE_WEBGL_FPS', 8),
    maxPageBytes: positive(source, 'CAPTURE_MAX_PAGE_BYTES', 5 * 1024 * 1024),
  };
}

const port = int(env.PORT, 5173);
const contentPort = int(env.CONTENT_PORT, 5180);

// Only the verified Three.js release is allowed from this package mirror.
export const THREE_MIRROR_PATH = '/three/0.170.0/files/';

export const config = {
  host: env.HOST || '127.0.0.1',
  port,
  contentPort,
  dist: resolve(env.DIST_DIR || (existsSync(join(ROOT, '.datapack', 'current')) ? join(ROOT, '.datapack', 'current') : join(ROOT, 'dist'))),
  // The admin web app: static files served under /admin/, checked into this repo.
  admin: resolve(env.ADMIN_DIR || join(ROOT, 'admin')),
  dataDir: resolve(env.DATA_DIR || join(ROOT, '.data')),
  // Every work is served from its own origin: {token} must fill a whole host label.
  // Locally *.localhost resolves to this machine; production needs a wildcard domain
  // on a registrable domain separate from the site (see docs/ARCHITECTURE.md).
  contentTemplate: env.CONTENT_ORIGIN_TEMPLATE || `http://{token}.localhost:${contentPort}`,
  // Opt-in fixed-host transport. A trusted shell isolates each opaque work frame.
  contentPathOrigin: validateContentOrigin(env.CONTENT_PATH_ORIGIN || '', list(env.SITE_ORIGINS, `http://localhost:${port},http://127.0.0.1:${port}`)),
  // Trusted frontend origins: credentialed API access and work framing.
  siteOrigins: list(env.SITE_ORIGINS, `http://localhost:${port},http://127.0.0.1:${port}`),
  // Usernames that always hold the admin role; `npm run admin -- <name>` also promotes.
  admins: list(env.ADMIN_USERNAMES, '').map((name) => name.normalize('NFKC').toLowerCase()),
  // Public CDNs a work may load scripts, styles, fonts and data from. Everything else is blocked.
  cdn: list(env.CONTENT_CDN_ALLOWLIST, 'cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com,esm.sh,fonts.googleapis.com,fonts.gstatic.com,registry.npmmirror.com'),
  // Headless screenshots of submitted works (Playwright + a local Chrome); off with CAPTURE=0.
  capture: env.CAPTURE !== '0',
  captureChannel: env.CAPTURE_BROWSER ?? 'chrome',
  // A separate capture service publishes its loopback Playwright endpoint here.
  captureEndpointFile: env.CAPTURE_ENDPOINT_FILE || '',
  // Chromium's OS sandbox for captures; needs the service to run as a non-root user.
  captureSandbox: env.CAPTURE_SANDBOX === '1',
  // Per-step and per-job capture limits. See captureTimeoutConfig for names and defaults.
  captureTimeouts: captureTimeoutConfig(env),
  captureOptions: captureOptionsConfig(env),
  leaderboardWarmup: env.LEADERBOARD_WARMUP !== '0',
  // New uploads stay private until the Flex check passes, and off the public work host until a human review.
  moderation: {
    enabled: env.CONTENT_MODERATION === '1',
    apiKey: env.MODERATION_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: env.MODERATION_BASE_URL || 'https://api.openai.com/v1',
    model: env.MODERATION_MODEL || 'gpt-6-luna',
  },
  secureCookies: env.COOKIE_SECURE === '1',
  cookieSameSite: env.COOKIE_SAME_SITE || 'Lax',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  readLimits: {
    api: Math.max(1, int(env.READ_API_PER_MIN, 180)),
    catalog: Math.max(1, int(env.READ_CATALOG_PER_MIN, 30)),
    files: Math.max(1, int(env.READ_FILES_PER_MIN, 1200)),
    pages: Math.max(1, int(env.READ_PAGES_PER_MIN, 60)),
  },
  // Longest a cached signed-out bootstrap outlives changes no write counter sees.
  bootstrapCacheMs: Math.max(1000, int(env.BOOTSTRAP_CACHE_MS, 15_000)),
};

export const limits = {
  uploadBytes: 30 * 1024 * 1024,
  unpackedBytes: 150 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  files: 2000,
  coverBytes: 3 * 1024 * 1024,
  referenceCount: 8,
  referenceBytes: 5 * 1024 * 1024,
  pendingPerUser: Math.max(1, int(env.PENDING_PER_USER, 8)),
  trustedPendingPerUser: Math.max(1, int(env.TRUSTED_PENDING_PER_USER, 20)),
  trustedMinVerified: Math.max(1, int(env.TRUSTED_MIN_VERIFIED, 3)),
  draftsPerUser: 3,
  draftTtl: 24 * 3600e3,
  matchTtl: 3 * 3600e3,
  sessionTtl: 30 * 24 * 3600e3,
  provisionalGames: 30,
};

// Effort levels offered on the upload form; curated works keep their own labels.
export const EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra', 'Ultracode'];
// Gallery reaction sticker ids; each frontend ships the art. Show1's legacy 👍/👀/🤯 votes share
// the reactions table but are not in this list, so Gallery neither accepts nor counts them.
export const EMOJIS = ['lick', 'lol', 'press', 'luck', 'yes', 'drool', 'knock', 'stare', 'no'];
// Avatar ids; each frontend ships an image per id. Append new ones only: an account that has
// not picked one gets a default hashed over the first 16, so that set must never change.
export const AVATARS = ['teapot', 'bunny', 'cube', 'cursor', 'ghost', 'donut', 'brackets', 'frame',
  'seal', 'moon', 'robot', 'cat', 'plant', 'bulb', 'dice', 'planet'];
