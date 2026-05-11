'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CHECKER_KEY = (process.env.CHECKER_KEY || '').trim();
const TRUST_PROXY = (process.env.TRUST_PROXY || 'true') === 'true'; // Railway / nginx in front

// Per-request limits
const MAX_URLS_PER_REQUEST = 500;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB target response cap
const MAX_REDIRECTS = 3;
const ADV_MAX_REDIRECTS = 10;
const FETCH_TIMEOUT_MS = 12000;
const ADV_FETCH_TIMEOUT_MS = 18000;
const GLOBAL_CONCURRENCY = 8;
const PER_HOST_CONCURRENCY = 2;

// Generic UA: do NOT identify the deployer by name.
const USER_AGENT = 'Mozilla/5.0 (compatible; SiteStatusChecker/1.0)';

// =============================================================================
// Production safety: refuse to serve API calls without an auth key in prod.
// We do NOT exit the process so that platform health-checks succeed and the
// operator can see a clear "configure me" response instead of a crash loop.
// =============================================================================

const AUTH_MISCONFIGURED = (NODE_ENV === 'production' && !CHECKER_KEY);
if (AUTH_MISCONFIGURED) {
  console.error('---------------------------------------------------------------');
  console.error('  CHECKER_KEY env var is REQUIRED in production.');
  console.error('  All API endpoints will return 503 until it is set.');
  console.error('  Set CHECKER_KEY to a 16+ character random string and redeploy.');
  console.error('---------------------------------------------------------------');
}
if (CHECKER_KEY && CHECKER_KEY.length < 16) {
  console.error('FATAL: CHECKER_KEY must be at least 16 characters.');
  process.exit(1);
}

// =============================================================================
// Detection patterns
// =============================================================================

const CLOUDFLARE_PATTERNS = [
  /cf-browser-verification/i,
  /cf-challenge-running/i,
  /Just a moment\.\.\./i,
  /Checking your browser before accessing/i,
  /Attention Required! \| Cloudflare/i,
  /__cf_chl_/i,
  /Please enable Cookies and reload the page/i
];

const DOWN_SIGNATURES = [
  { name: '404 page',                    pattern: /<title>[^<]*Page Not Found[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<title>[^<]*404[^<]*Not Found[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<title>[^<]*Error\s*404[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<h1[^>]*>\s*404\s*<\/h1>/i },
  { name: 'Soft 404',                    pattern: /<h1[^>]*>\s*Page Not Found\s*<\/h1>/i },
  { name: 'Nginx default page',          pattern: /<title>\s*Welcome to nginx!?\s*<\/title>/i },
  { name: 'Nginx default page',          pattern: /<h1>\s*Welcome to nginx!?\s*<\/h1>/i },
  { name: 'Apache default page',         pattern: /<title>\s*Apache2 (Ubuntu|Debian|CentOS)? ?Default Page[^<]*<\/title>/i },
  { name: 'Apache default page',         pattern: /<title>\s*Test Page for the Apache HTTP Server[^<]*<\/title>/i },
  { name: 'Apache default page',         pattern: /<h1[^>]*>\s*It works!?\s*<\/h1>/i },
  { name: 'IIS default page',            pattern: /<title>\s*IIS Windows Server\s*<\/title>/i },
  { name: 'IIS default page',            pattern: /<title>[^<]*Welcome to IIS[^<]*<\/title>/i },
  { name: 'LiteSpeed default page',      pattern: /<title>[^<]*LiteSpeed Web Server[^<]*<\/title>/i },
  { name: 'Wix - site not found',        pattern: /<title>[^<]*Wix\.com[^<]*<\/title>[\s\S]{0,400}?(domain is not connected|site is not published|page isn't available)/i },
  { name: 'Wix - site not found',        pattern: />\s*This domain is not connected to a website[^<]*</i },
  { name: 'Squarespace - expired',       pattern: /<title>[^<]*Website Expired[^<]*<\/title>/i },
  { name: 'Squarespace - expired',       pattern: />\s*This site has expired\s*</i },
  { name: 'Squarespace - not found',     pattern: />\s*The page you are looking for does not exist\s*</i },
  { name: 'Vercel - deployment not found', pattern: /<title>[^<]*404[: ]+(NOT[_ ]FOUND|Not Found)[^<]*<\/title>[\s\S]*?vercel/i },
  { name: 'Vercel - deployment not found', pattern: /DEPLOYMENT_NOT_FOUND/ },
  { name: 'Netlify - page not found',    pattern: /<title>[^<]*Page Not Found - Netlify[^<]*<\/title>/i },
  { name: 'Netlify - page not found',    pattern: /Looks like you've followed a broken link[\s\S]{0,200}Netlify/i },
  { name: 'GitHub Pages - 404',          pattern: /<title>\s*Site not found\s*&middot;\s*GitHub Pages\s*<\/title>/i },
  { name: 'GitHub Pages - 404',          pattern: /<title>\s*Site not found\s*·\s*GitHub Pages\s*<\/title>/i },
  { name: 'Heroku - app not found',      pattern: /<title>[^<]*No such app[^<]*<\/title>/i },
  { name: 'Heroku - app not found',      pattern: /no-such-app\.html/i },
  { name: 'Heroku - app crashed',        pattern: /<title>[^<]*Application Error[^<]*<\/title>[\s\S]*?heroku/i },
  { name: 'Render - service not found',  pattern: /<title>[^<]*Not Found - Render[^<]*<\/title>/i },
  { name: 'Fly.io - app not found',      pattern: /<title>[^<]*Fly\.io[^<]*<\/title>[\s\S]*?app[\s\S]{0,40}not found/i },
  { name: 'Account suspended',           pattern: /<title>[^<]*Account Suspended[^<]*<\/title>/i },
  { name: 'Account suspended',           pattern: /<h1[^>]*>\s*Account Suspended\s*<\/h1>/i },
  { name: 'Account suspended',           pattern: />\s*This Account has been suspended\s*</i },
  { name: 'GoDaddy - parked',            pattern: /Future home of something quite cool/i },
  { name: 'GoDaddy - parked',            pattern: /img\.dpbolvw\.net|godaddy\.com\/?utm_source=domainparking/i },
  { name: 'Sedo - parked',               pattern: /sedoparking\.com/i },
  { name: 'Sedo - parked',               pattern: /<title>[^<]*Parked Domain[^<]*<\/title>[\s\S]*?sedo/i },
  { name: 'HugeDomains - for sale',      pattern: /HugeDomains\.com/i },
  { name: 'Bodis - parked',              pattern: /bodis\.com/i },
  { name: 'Domain for sale',             pattern: /<title>[^<]*(domain is for sale|buy this domain)[^<]*<\/title>/i },
  { name: 'Domain for sale',             pattern: /<h1[^>]*>\s*(This domain may be for sale|Buy this domain)/i },
  { name: 'Domain expired',              pattern: /<title>[^<]*Domain Expired[^<]*<\/title>/i },
  { name: 'Domain expired',              pattern: />\s*This domain has expired\s*</i },
  { name: 'Parked domain',               pattern: /<title>[^<]*Parked Domain[^<]*<\/title>/i },
  { name: 'Parked domain',               pattern: />\s*This Web page is parked\s*</i }
];

function classifyByBody(body) {
  if (!body) return null;
  for (const p of CLOUDFLARE_PATTERNS) {
    if (p.test(body)) return { category: 'cloudflare', reason: 'Cloudflare challenge' };
  }
  for (const sig of DOWN_SIGNATURES) {
    if (sig.pattern.test(body)) return { category: 'down', reason: sig.name };
  }
  return null;
}

// =============================================================================
// SSRF protection
// =============================================================================

// RFC1918, loopback, link-local, multicast, broadcast, CGNAT, ULA, etc.
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0) return true;                                // 0.0.0.0/8
    if (p[0] === 10) return true;                               // RFC1918
    if (p[0] === 127) return true;                              // loopback
    if (p[0] === 169 && p[1] === 254) return true;              // link-local (incl. cloud metadata)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;  // RFC1918
    if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true; // IETF / TEST-NET-1
    if (p[0] === 192 && p[1] === 168) return true;              // RFC1918
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmark
    if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true;  // TEST-NET-2
    if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;   // TEST-NET-3
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] >= 224 && p[0] <= 239) return true;                // multicast
    if (p[0] >= 240) return true;                               // reserved + 255.255.255.255 broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase();
    if (lc === '::' || lc === '::1') return true;
    if (lc.startsWith('fe80')) return true;                     // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // ULA
    if (lc.startsWith('ff')) return true;                       // multicast
    if (lc.startsWith('::ffff:')) {                             // IPv4-mapped
      const v4 = lc.split(':').pop();
      if (net.isIPv4(v4)) return isPrivateIp(v4);
      return true;
    }
    if (lc.startsWith('64:ff9b::')) return true;                // NAT64
    if (lc.startsWith('2001:db8')) return true;                 // documentation
    if (lc.startsWith('2002:')) {                               // 6to4 - check encapsulated IPv4
      return true; // conservatively block
    }
    return false;
  }
  return true; // unknown address shape
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'ip-ranges.amazonaws.com'.toLowerCase()
]);

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.lan', '.intranet', '.corp', '.home', '.private'];

async function assertUrlIsPublic(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { return { ok: false, reason: 'invalid URL' }; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme not allowed' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials in URL not allowed' };
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (!host) return { ok: false, reason: 'empty host' };
  if (host.length > 253) return { ok: false, reason: 'hostname too long' };
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'blocked hostname' };
  for (const suf of BLOCKED_HOST_SUFFIXES) {
    if (host === suf.slice(1) || host.endsWith(suf)) return { ok: false, reason: 'internal hostname' };
  }
  // Strip the surrounding brackets for IPv6 literals from URL.hostname (some Node versions leave them off)
  const hostClean = host.replace(/^\[|\]$/g, '');

  if (net.isIP(hostClean)) {
    if (isPrivateIp(hostClean)) return { ok: false, reason: 'private/reserved IP' };
    return { ok: true };
  }

  let addrs;
  try {
    addrs = await dns.lookup(hostClean, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, reason: 'DNS lookup failed' };
  }
  if (!addrs || !addrs.length) return { ok: false, reason: 'DNS returned no results' };
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return { ok: false, reason: 'host resolves to private/reserved IP' };
  }
  return { ok: true };
}

// =============================================================================
// URL helpers
// =============================================================================

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url) return null;
  if (url.length > MAX_URL_LENGTH) return null;
  // Disallow control chars in the input
  if (/[ -]/.test(url)) return null;
  const explicitTrailingSlash = url.endsWith('/');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    let pathname = u.pathname || '/';
    if (pathname !== '/' && pathname.endsWith('/') && !explicitTrailingSlash) {
      pathname = pathname.replace(/\/+$/, '');
    }
    if (pathname === '/' && !explicitTrailingSlash) pathname = '';
    return u.protocol + '//' + u.host + pathname + (u.search || '');
  } catch (e) { return null; }
}

function getDomainVariations(rawUrl) {
  try {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return [];
    const u = new URL(normalized);
    const host = u.host.replace(/^www\./i, '');
    const tail = (u.pathname && u.pathname !== '/' ? u.pathname : '') + (u.search || '');
    return [
      `https://${host}${tail}`,
      `http://${host}${tail}`,
      `https://www.${host}${tail}`,
      `http://www.${host}${tail}`
    ];
  } catch (e) { return []; }
}

function isCloudflareHeader(headers) {
  if (!headers) return false;
  const get = (k) => (headers.get ? headers.get(k) : headers[k]);
  const server = (get('server') || '').toLowerCase();
  if (server.includes('cloudflare')) return true;
  if (get('cf-ray')) return true;
  if (get('cf-mitigated')) return true;
  return false;
}

function classifyByStatus(status) {
  if (status >= 200 && status < 300) return 'up';
  if (status >= 300 && status < 400) return 'redirect';
  return 'down';
}

function resolveLocation(loc, base) {
  try { return new URL(loc, base).toString(); } catch (e) { return null; }
}

// =============================================================================
// Capped fetch (native fetch + AbortController + body size cap)
// =============================================================================

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    redirect: 'manual',
    signal: controller.signal,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  }).finally(() => clearTimeout(timer));
}

async function readBodyCapped(res, maxBytes) {
  try {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text') && !ct.includes('html') && !ct.includes('json') && !ct.includes('xml')) {
      try { await res.body?.cancel(); } catch {}
      return '';
    }
    if (!res.body || !res.body.getReader) {
      const txt = await res.text();
      return txt.length > maxBytes ? txt.slice(0, maxBytes) : txt;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
          try { reader.cancel(); } catch {}
          break;
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
  } catch (e) {
    return '';
  }
}

// =============================================================================
// Per-host concurrency throttle
// =============================================================================

const hostQueues = new Map(); // host -> { active: number, waiters: Function[] }

function hostFromUrl(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}

async function acquireHost(host) {
  if (!host) return () => {};
  let q = hostQueues.get(host);
  if (!q) { q = { active: 0, waiters: [] }; hostQueues.set(host, q); }
  if (q.active < PER_HOST_CONCURRENCY) {
    q.active++;
  } else {
    await new Promise(resolve => q.waiters.push(resolve));
    q.active++;
  }
  return () => {
    q.active--;
    if (q.waiters.length) q.waiters.shift()();
    if (q.active === 0 && q.waiters.length === 0) hostQueues.delete(host);
  };
}

// =============================================================================
// Single URL check (with SSRF-safe redirect following)
// =============================================================================

async function followAndCheck(startUrl, opts) {
  const maxRedirects = opts.advanced ? ADV_MAX_REDIRECTS : MAX_REDIRECTS;
  const timeout = opts.advanced ? ADV_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;

  const chain = [];
  const startedAt = Date.now();
  let currentUrl = startUrl;
  let firstStatus = 0;
  let lastStatus = 0;
  let lastBody = '';
  let lastFinalUrl = startUrl;
  let cloudflareSeen = false;
  let error = null;

  for (let i = 0; i <= maxRedirects; i++) {
    // SSRF-safe gate on EVERY hop (including the original URL).
    const safe = await assertUrlIsPublic(currentUrl);
    if (!safe.ok) {
      error = `blocked: ${safe.reason}`;
      break;
    }

    const release = await acquireHost(hostFromUrl(currentUrl));
    let res;
    try {
      res = await fetchWithTimeout(currentUrl, timeout);
    } catch (e) {
      release();
      error = (e && e.name === 'AbortError')
        ? `Unreachable (network timeout)`
        : `request failed`;
      break;
    }

    if (i === 0) firstStatus = res.status;
    lastStatus = res.status;
    lastFinalUrl = currentUrl;
    if (isCloudflareHeader(res.headers)) cloudflareSeen = true;

    if (res.status >= 300 && res.status < 400 && i < maxRedirects) {
      const loc = res.headers.get('location');
      try { await res.body?.cancel(); } catch {}
      release();
      if (!loc) { break; }
      const next = resolveLocation(loc, currentUrl);
      if (!next) break;
      chain.push({ status: res.status });
      currentUrl = next;
      continue;
    }

    lastBody = await readBodyCapped(res, MAX_BODY_BYTES);
    release();
    break;
  }

  const timingMs = Date.now() - startedAt;
  const bodyClass = classifyByBody(lastBody);
  let downReason = null;
  if (bodyClass && bodyClass.category === 'cloudflare') cloudflareSeen = true;

  let category;
  if (error) {
    category = chain.length ? 'redirect-down' : 'down';
    downReason = error.startsWith('Unreachable') ? 'Network unreachable'
      : error.startsWith('blocked:') ? error : 'Connection failed';
  } else if ((bodyClass && bodyClass.category === 'cloudflare') || (cloudflareSeen && lastStatus >= 400)) {
    category = chain.length ? 'redirect-down' : 'cloudflare';
    if (!chain.length && cloudflareSeen) category = 'cloudflare';
    downReason = (bodyClass && bodyClass.reason) || 'Cloudflare block';
  } else if (bodyClass && bodyClass.category === 'down') {
    category = chain.length ? 'redirect-down' : 'down';
    downReason = bodyClass.reason;
  } else {
    const statusCat = classifyByStatus(lastStatus);
    if (chain.length) {
      category = (statusCat === 'up') ? 'redirect-up' : 'redirect-down';
    } else {
      category = statusCat === 'redirect' ? 'redirect-down' : statusCat;
    }
    if (category === 'down' || category === 'redirect-down') {
      downReason = lastStatus ? `HTTP ${lastStatus}` : 'No response';
    }
  }

  return {
    finalUrl: lastFinalUrl,
    firstStatus,
    finalStatus: lastStatus,
    chain,
    timingMs,
    error,
    cloudflareSeen,
    category,
    downReason
  };
}

async function checkSingleUrl(rawUrl, opts) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return {
      input: typeof rawUrl === 'string' ? rawUrl.slice(0, MAX_URL_LENGTH) : '',
      url: '',
      category: 'down',
      firstStatus: 0, finalStatus: 0,
      chain: [], timingMs: 0,
      error: 'invalid url',
      downReason: 'Invalid URL'
    };
  }

  const main = await followAndCheck(normalized, opts);

  const result = {
    input: rawUrl.length > MAX_URL_LENGTH ? rawUrl.slice(0, MAX_URL_LENGTH) : rawUrl,
    url: normalized,
    finalUrl: main.finalUrl,
    firstStatus: main.firstStatus,
    finalStatus: main.finalStatus,
    chain: main.chain,
    redirected: main.chain.length > 0,
    timingMs: main.timingMs,
    cloudflareSeen: main.cloudflareSeen,
    error: main.error || null,
    category: main.category,
    downReason: main.downReason || null
  };

  if (opts.variations) {
    const variations = getDomainVariations(normalized);
    result.variations = await Promise.all(variations.map(async (v) => {
      try {
        const r = await followAndCheck(v, opts);
        return { url: v, finalUrl: r.finalUrl, status: r.finalStatus, category: r.category, redirected: r.chain.length > 0 };
      } catch (e) {
        return { url: v, status: 0, category: 'down', error: 'check failed' };
      }
    }));
  }

  return result;
}

function markUniqueRedirects(results) {
  const counts = new Map();
  for (const r of results) {
    if (!r || !r.redirected || !r.finalUrl) continue;
    const key = canonicalKey(r.finalUrl);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const r of results) {
    if (!r) continue;
    if (!r.redirected || !r.finalUrl) { r.uniqueRedirect = false; continue; }
    r.uniqueRedirect = (counts.get(canonicalKey(r.finalUrl)) === 1);
  }
}

function canonicalKey(u) {
  try {
    const x = new URL(u);
    return x.host.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '');
  } catch (e) { return String(u).toLowerCase().slice(0, MAX_URL_LENGTH); }
}

// =============================================================================
// Express setup + middleware
// =============================================================================

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

// Strict, default-deny CSP. All assets are first-party.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'form-action': ["'self'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false
}));

// Hard-coded CORS: same-origin only.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  next();
});

// Body parser with a tight limit + strict type
app.use(express.json({ limit: '256kb', type: 'application/json', strict: true }));

// =============================================================================
// Auth gate (constant-time comparison)
// =============================================================================

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still run a comparison to keep timing constant-ish.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req, res, next) {
  if (AUTH_MISCONFIGURED) {
    return res.status(503).json({ error: 'service not configured: CHECKER_KEY env var must be set' });
  }
  if (!CHECKER_KEY) return next(); // local/dev only
  const hdr = req.get('x-checker-key') || '';
  if (!constantTimeEq(hdr, CHECKER_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// =============================================================================
// Rate limiting
// =============================================================================

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, slow down' }
});

const checkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many checks, slow down' }
});

// Apply to all API surfaces.
app.use('/api/', apiLimiter);

// =============================================================================
// Routes
// =============================================================================

// Health is intentionally unauthenticated so deployment platforms can probe it.
// It returns no internal state.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Whether auth is required - lets the frontend show a key prompt.
app.get('/api/auth-required', (req, res) => {
  res.json({
    required: !!CHECKER_KEY,
    misconfigured: AUTH_MISCONFIGURED
  });
});

// Lightweight auth verify - used by the frontend when the user enters a key.
app.post('/api/auth-verify', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// Diagnostic endpoint: minimal info, gated behind auth.
// Crucially, we do NOT expose error stacks or recent error messages here.
const startTs = Date.now();
app.get('/api/diag', requireAuth, (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    startedAt: startTs,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
  });
});

app.post('/api/check', checkLimiter, requireAuth, async (req, res) => {
  let aborted = false;
  let heartbeat = null;

  try {
    const body = req.body || {};
    let urls = body.urls;
    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'urls must be an array' });
    }
    if (urls.length === 0) {
      return res.status(400).json({ error: 'urls must not be empty' });
    }
    if (urls.length > MAX_URLS_PER_REQUEST) {
      return res.status(400).json({ error: `too many URLs (max ${MAX_URLS_PER_REQUEST})` });
    }

    // Sanitise + size-cap each entry
    urls = urls
      .filter(u => typeof u === 'string')
      .map(u => u.length > MAX_URL_LENGTH ? u.slice(0, MAX_URL_LENGTH) : u)
      .filter(u => u.trim().length > 0);

    if (urls.length === 0) {
      return res.status(400).json({ error: 'no valid urls' });
    }

    const opts = {
      redirects: body.redirects !== false,
      variations: !!body.variations,
      unique: !!body.unique,
      advanced: !!body.advanced
    };

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform, private');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(' '.repeat(2048) + '\n');

    const send = (obj) => {
      try {
        res.write(JSON.stringify(obj) + '\n');
        if (typeof res.flush === 'function') res.flush();
      } catch (e) { /* socket gone */ }
    };

    const startedAt = Date.now();
    send({ type: 'start', total: urls.length, startedAt });

    heartbeat = setInterval(() => send({ type: 'ping', ts: Date.now() }), 3000);

    const results = new Array(urls.length);
    let idx = 0;
    let completed = 0;

    res.on('close', () => { if (!res.writableEnded) aborted = true; });

    async function worker() {
      while (!aborted) {
        const i = idx++;
        if (i >= urls.length) return;
        let r;
        try {
          r = await checkSingleUrl(urls[i], opts);
        } catch (workerErr) {
          // Do not echo internal error messages to clients.
          console.error('worker error', workerErr && workerErr.code ? workerErr.code : 'unknown');
          r = {
            input: urls[i].slice(0, MAX_URL_LENGTH),
            url: '',
            finalUrl: '',
            firstStatus: 0,
            finalStatus: 0,
            chain: [],
            redirected: false,
            timingMs: 0,
            cloudflareSeen: false,
            error: 'check failed',
            category: 'down',
            downReason: 'Check error'
          };
        }
        results[i] = r;
        completed++;
        send({ type: 'result', index: i, completed, total: urls.length, result: r });
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(GLOBAL_CONCURRENCY, urls.length); i++) workers.push(worker());
    try { await Promise.all(workers); } finally { clearInterval(heartbeat); heartbeat = null; }

    if (aborted) { res.end(); return; }

    if (opts.unique) markUniqueRedirects(results);
    else for (const r of results) if (r) r.uniqueRedirect = false;

    const uniqueIndexes = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].uniqueRedirect) uniqueIndexes.push(i);
    }

    send({ type: 'done', elapsedMs: Date.now() - startedAt, uniqueIndexes });
    res.end();
  } catch (e) {
    if (heartbeat) clearInterval(heartbeat);
    console.error('check handler error', e && e.code ? e.code : 'unknown');
    if (!res.headersSent) {
      res.status(500).json({ error: 'server error' });
    } else {
      try { res.write(JSON.stringify({ type: 'error', error: 'server error' }) + '\n'); } catch {}
      res.end();
    }
  }
});

// Reject any unexpected verb on the API surface.
app.all('/api/*', (req, res) => res.status(405).json({ error: 'method not allowed' }));

// =============================================================================
// Static assets (served after the API surface so /api/* doesn't fall through)
// =============================================================================

app.use(express.static(path.join(__dirname, 'public'), {
  fallthrough: true,
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// JSON 404 for anything not matched.
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Global JSON error handler. Never leak the error.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('express error', err && err.code ? err.code : 'unknown');
  if (res.headersSent) return res.end();
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
  res.status(500).json({ error: 'server error' });
});

// =============================================================================
// Process-level error containment (no leaks to client)
// =============================================================================

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err && err.code ? err.code : (err && err.name) || 'unknown');
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.code ? err.code : (err && err.name) || 'unknown');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Site Status Checker listening on :${PORT} (NODE_ENV=${NODE_ENV}, auth=${CHECKER_KEY ? 'on' : 'OFF'})`);
  });
}

module.exports = app;
