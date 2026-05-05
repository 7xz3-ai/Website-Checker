const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FETCH_TIMEOUT_MS = 12000;
const ADV_FETCH_TIMEOUT_MS = 18000;
const MAX_REDIRECTS = 3;
const ADV_MAX_REDIRECTS = 10;
const USER_AGENT = 'Mozilla/5.0 (compatible; OmairCheckerBot/1.0; +https://example.com/bot)';

const CLOUDFLARE_PATTERNS = [
  /cf-browser-verification/i,
  /cf-challenge-running/i,
  /Just a moment\.\.\./i,
  /Checking your browser before accessing/i,
  /Attention Required! \| Cloudflare/i,
  /__cf_chl_/i,
  /Please enable Cookies and reload the page/i
];

// Body patterns that mean the site is effectively down.
// Order matters only loosely - the first match wins for naming the reason.
const DOWN_SIGNATURES = [
  // Generic 404 / not found
  { name: '404 page',                    pattern: /<title>[^<]*Page Not Found[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<title>[^<]*404[^<]*Not Found[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<title>[^<]*Error\s*404[^<]*<\/title>/i },
  { name: '404 page',                    pattern: /<h1[^>]*>\s*404\s*<\/h1>/i },
  { name: 'Soft 404',                    pattern: /<h1[^>]*>\s*Page Not Found\s*<\/h1>/i },

  // Default server pages
  { name: 'Nginx default page',          pattern: /<title>\s*Welcome to nginx!?\s*<\/title>/i },
  { name: 'Nginx default page',          pattern: /<h1>\s*Welcome to nginx!?\s*<\/h1>/i },
  { name: 'Apache default page',         pattern: /<title>\s*Apache2 (Ubuntu|Debian|CentOS)? ?Default Page[^<]*<\/title>/i },
  { name: 'Apache default page',         pattern: /<title>\s*Test Page for the Apache HTTP Server[^<]*<\/title>/i },
  { name: 'Apache default page',         pattern: /<h1[^>]*>\s*It works!?\s*<\/h1>/i },
  { name: 'IIS default page',            pattern: /<title>\s*IIS Windows Server\s*<\/title>/i },
  { name: 'IIS default page',            pattern: /<title>[^<]*Welcome to IIS[^<]*<\/title>/i },
  { name: 'LiteSpeed default page',      pattern: /<title>[^<]*LiteSpeed Web Server[^<]*<\/title>/i },

  // Hosting-platform "not found" pages
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

  // Suspensions
  { name: 'Account suspended',           pattern: /<title>[^<]*Account Suspended[^<]*<\/title>/i },
  { name: 'Account suspended',           pattern: /<h1[^>]*>\s*Account Suspended\s*<\/h1>/i },
  { name: 'Account suspended',           pattern: />\s*This Account has been suspended\s*</i },

  // Parking & for-sale
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

function normalizeUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;
  const explicitTrailingSlash = url.endsWith('/');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
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

function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })
      .then(res => resolve(res))
      .catch(err => reject(err))
      .finally(() => clearTimeout(timer));
  });
}

async function readBodySafe(res) {
  try {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text') && !ct.includes('html') && !ct.includes('json') && !ct.includes('xml')) return '';
    return (await res.text()) || '';
  } catch (e) { return ''; }
}

function resolveLocation(loc, base) {
  try { return new URL(loc, base).toString(); } catch (e) { return null; }
}

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
    let res;
    try {
      res = await fetchWithTimeout(currentUrl, timeout);
    } catch (e) {
      error = e.name === 'AbortError'
        ? `Unreachable (network timeout at: ${currentUrl})`
        : `request to ${currentUrl} failed, reason: ${e.message || e.code || 'fetch error'}`;
      break;
    }

    if (i === 0) firstStatus = res.status;
    lastStatus = res.status;
    lastFinalUrl = currentUrl;

    if (isCloudflareHeader(res.headers)) cloudflareSeen = true;

    if (res.status >= 300 && res.status < 400 && i < maxRedirects) {
      const loc = res.headers.get('location');
      if (!loc) { lastBody = await readBodySafe(res); break; }
      const next = resolveLocation(loc, currentUrl);
      chain.push({ from: currentUrl, to: next, status: res.status });
      if (!next) break;
      currentUrl = next;
      continue;
    }

    lastBody = await readBodySafe(res);
    break;
  }

  const timingMs = Date.now() - startedAt;
  const bodyClass = classifyByBody(lastBody);
  let downReason = null;
  if (bodyClass && bodyClass.category === 'cloudflare') cloudflareSeen = true;

  let category;
  if (error) {
    category = chain.length ? 'redirect-down' : 'down';
    downReason = error.startsWith('Unreachable') ? 'Network unreachable' : 'Connection failed';
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

function scrapeText(html, wordCount = 18) {
  if (!html) return '';
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
  return cleaned.split(' ').filter(Boolean).slice(0, wordCount).join(' ');
}

async function checkSingleUrl(rawUrl, opts) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return {
      input: rawUrl, url: rawUrl,
      category: 'down', firstStatus: 0, finalStatus: 0,
      chain: [], timingMs: 0, error: 'invalid url'
    };
  }

  const main = await followAndCheck(normalized, opts);

  const result = {
    input: rawUrl,
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
        return { url: v, status: 0, category: 'down', error: e.message };
      }
    }));
  }

  return result;
}

function markUniqueRedirects(results) {
  const counts = new Map();
  for (const r of results) {
    if (!r.redirected || !r.finalUrl) continue;
    const key = canonicalKey(r.finalUrl);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const r of results) {
    if (!r.redirected || !r.finalUrl) { r.uniqueRedirect = false; continue; }
    r.uniqueRedirect = (counts.get(canonicalKey(r.finalUrl)) === 1);
  }
}

function canonicalKey(u) {
  try {
    const x = new URL(u);
    let host = x.host.toLowerCase().replace(/^www\./, '');
    let p = x.pathname.replace(/\/+$/, '');
    return host + p;
  } catch (e) { return String(u).toLowerCase(); }
}

app.post('/api/check', async (req, res) => {
  try {
    const { urls, redirects, variations, unique, advanced } = req.body || {};
    if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls must be an array' });

    const opts = {
      redirects: redirects !== false,
      variations: !!variations,
      unique: !!unique,
      advanced: !!advanced
    };

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
      if (typeof res.flush === 'function') res.flush();
    };

    const startedAt = Date.now();
    send({ type: 'start', total: urls.length, startedAt });

    const concurrency = 8;
    const results = new Array(urls.length);
    let idx = 0;
    let completed = 0;
    let aborted = false;

    res.on('close', () => {
      if (!res.writableEnded) aborted = true;
    });

    async function worker() {
      while (!aborted) {
        const i = idx++;
        if (i >= urls.length) return;
        const r = await checkSingleUrl(urls[i], opts);
        results[i] = r;
        completed++;
        send({ type: 'result', index: i, completed, total: urls.length, result: r });
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) workers.push(worker());
    await Promise.all(workers);

    if (aborted) { res.end(); return; }

    if (opts.unique) markUniqueRedirects(results);
    else for (const r of results) r.uniqueRedirect = false;

    const uniqueIndexes = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].uniqueRedirect) uniqueIndexes.push(i);
    }

    send({ type: 'done', elapsedMs: Date.now() - startedAt, uniqueIndexes });
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || 'server error' });
    } else {
      try { res.write(JSON.stringify({ type: 'error', error: e.message || 'server error' }) + '\n'); } catch {}
      res.end();
    }
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Website Checker running on http://localhost:${port}`));
}

module.exports = app;
