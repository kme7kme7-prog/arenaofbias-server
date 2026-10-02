// Platform configuration. Every value can be overridden with an environment variable;
// the defaults suit a single machine running `npm start` after `npm run build`.
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const int = (value, fallback) => (/^\d+$/.test(value ?? '') ? Number(value) : fallback);
const list = (value, fallback) => (value ?? fallback).split(',').map((item) => item.trim()).filter(Boolean);

const port = int(env.PORT, 5173);
const contentPort = int(env.CONTENT_PORT, 5180);

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
  // Trusted frontend origins: credentialed API access and work framing.
  siteOrigins: list(env.SITE_ORIGINS, `http://localhost:${port},http://127.0.0.1:${port}`),
  // Usernames that always hold the admin role; `npm run admin -- <name>` also promotes.
  admins: list(env.ADMIN_USERNAMES, '').map((name) => name.normalize('NFKC').toLowerCase()),
  // Public CDNs a work may load scripts, styles, fonts and data from. Everything else is blocked.
  cdn: list(env.CONTENT_CDN_ALLOWLIST, 'cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com,esm.sh,fonts.googleapis.com,fonts.gstatic.com'),
  // Headless screenshots of submitted works (Playwright + a local Chrome); off with CAPTURE=0.
  capture: env.CAPTURE !== '0',
  captureChannel: env.CAPTURE_BROWSER ?? 'chrome',
  // A separate capture service publishes its loopback Playwright endpoint here.
  captureEndpointFile: env.CAPTURE_ENDPOINT_FILE || '',
  // Chromium's OS sandbox for captures; needs the service to run as a non-root user.
  captureSandbox: env.CAPTURE_SANDBOX === '1',
  // New uploads stay private until the Flex check passes, and off the public work host until a human review.
  moderation: {
    enabled: env.CONTENT_MODERATION === '1',
    apiKey: env.MODERATION_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: env.MODERATION_BASE_URL || 'https://api.openai.com/v1',
    model: env.MODERATION_MODEL || 'gpt-6-luna',
    // Hours between rechecks of public uploads for changed text or CDN content; 0 turns them off.
    recheckHours: int(env.CONTENT_RECHECK_HOURS, 24),
  },
  secureCookies: env.COOKIE_SECURE === '1',
  cookieSameSite: env.COOKIE_SAME_SITE || 'Lax',
  trustProxy: env.TRUST_PROXY === '1',
  readLimits: {
    api: Math.max(1, int(env.READ_API_PER_MIN, 180)),
    catalog: Math.max(1, int(env.READ_CATALOG_PER_MIN, 30)),
    files: Math.max(1, int(env.READ_FILES_PER_MIN, 1200)),
    pages: Math.max(1, int(env.READ_PAGES_PER_MIN, 60)),
  },
};

export const limits = {
  uploadBytes: 30 * 1024 * 1024,
  unpackedBytes: 150 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  files: 2000,
  coverBytes: 3 * 1024 * 1024,
  pendingPerUser: Math.max(1, int(env.PENDING_PER_USER, 5)),
  trustedPendingPerUser: Math.max(1, int(env.TRUSTED_PENDING_PER_USER, 20)),
  trustedMinVerified: Math.max(1, int(env.TRUSTED_MIN_VERIFIED, 3)),
  draftsPerUser: 3,
  draftTtl: 24 * 3600e3,
  matchTtl: 3 * 3600e3,
  sessionTtl: 30 * 24 * 3600e3,
  provisionalGames: 30,
};

// Effort levels offered on the upload form; curated works keep their own labels.
export const EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max'];
export const EMOJIS = ['👍', '❤️', '🔥', '🤯', '👏', '👀'];
// Avatar ids; each frontend ships an image per id. Append new ones only: an account that has
// not picked one gets a default hashed over the first 16, so that set must never change.
export const AVATARS = ['teapot', 'bunny', 'cube', 'cursor', 'ghost', 'donut', 'brackets', 'frame',
  'seal', 'moon', 'robot', 'cat', 'plant', 'bulb', 'dice', 'planet'];
