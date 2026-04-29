const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; WebsiteChecker/1.0; +https://example.com/bot)';

const CLOUDFLARE_PATTERNS = [
  /cf-browser-verification/i,
  /cf-challenge-running/i,
  /Just a moment\.\.\./i,
  /Checking your browser before accessing/i,
  /Attention Required! \| Cloudflare/i,
  /__cf_chl_/i,
  /Please enable Cookies and reload the page/i
];

const PAGE_NOT_FOUND_PATTERNS = [
  /<title>[^<]*Page Not Found[^<]*<\/title>/i,
  /<title>[^<]*404[^<]*Not Found[^<]*<\/title>/i,
  />\s*Page Not Found\s*</i
];

const NGINX_DEFAULT_PATTERNS = [
  /<title>\s*Welcome to nginx!?\s*<\/title>/i,
  />\s*Welcome to nginx!?\s*</i
];

function normalizeUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;

  const explicitTrailingSlash = url.endsWith('/');

  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    const u = new URL(url);
    let pathname = u.pathname || '/';
    if (pathname !== '/' && pathname.endsWith('/') && !explicitTrailingSlash) {
      pathname = pathname.replace(/\/+$/, '');
    }
    if (pathname === '/' && !explicitTrailingSlash) {
      pathname = '';
    }
    let result = u.protocol + '//' + u.host + pathname + (u.search || '');
    return result;
  } catch (e) {
    return null;
  }
}

function getDomainVariations(rawUrl) {
  try {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return [];
    const u = new URL(normalized);
    let host = u.host.replace(/^www\./i, '');
    const pathPart = (u.pathname && u.pathname !== '/' ? u.pathname : '') + (u.search || '');
    return [
      `https://${host}${pathPart}`,
      `http://${host}${pathPart}`,
      `https://www.${host}${pathPart}`,
      `http://www.${host}${pathPart}`
    ];
  } catch (e) {
    return [];
  }
}

function classifyByBody(body) {
  if (!body) return null;
  for (const p of CLOUDFLARE_PATTERNS) {
    if (p.test(body)) return 'cloudflare';
  }
  for (const p of PAGE_NOT_FOUND_PATTERNS) {
    if (p.test(body)) return 'down';
  }
  for (const p of NGINX_DEFAULT_PATTERNS) {
    if (p.test(body)) return 'down';
  }
  return null;
}

function classifyByStatus(status) {
  if (status >= 200 && status < 300) return 'up';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400) return 'down';
  return 'down';
}

function fetchWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    fetch(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...(options.headers || {})
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
    if (ct && !ct.includes('text') && !ct.includes('html') && !ct.includes('json') && !ct.includes('xml')) {
      return '';
    }
    const text = await res.text();
    return text || '';
  } catch (e) {
    return '';
  }
}

function scrapeText(html, wordCount = 18) {
  if (!html) return '';
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean);
  return words.slice(0, wordCount).join(' ');
}

function resolveLocation(location, baseUrl) {
  try {
    return new URL(location, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

async function followAndCheck(startUrl, opts) {
  const chain = [];
  let currentUrl = startUrl;
  let redirects = 0;
  let lastStatus = 0;
  let lastBody = '';
  let lastFinalUrl = startUrl;
  let cloudflareSeen = false;

  while (true) {
    let res;
    try {
      res = await fetchWithTimeout(currentUrl);
    } catch (e) {
      return {
        finalUrl: currentUrl,
        status: 0,
        category: 'down',
        error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch error'),
        chain,
        body: '',
        redirected: redirects > 0
      };
    }

    lastStatus = res.status;
    lastFinalUrl = currentUrl;

    if (res.status >= 300 && res.status < 400 && redirects < MAX_REDIRECTS) {
      const loc = res.headers.get('location');
      if (!loc) {
        lastBody = await readBodySafe(res);
        break;
      }
      const next = resolveLocation(loc, currentUrl);
      chain.push({ from: currentUrl, to: next, status: res.status });
      if (!next) break;
      currentUrl = next;
      redirects++;
      continue;
    }

    lastBody = await readBodySafe(res);
    break;
  }

  const bodyClass = classifyByBody(lastBody);
  if (bodyClass === 'cloudflare') cloudflareSeen = true;

  let category;
  if (bodyClass === 'cloudflare') {
    category = 'cloudflare';
  } else if (bodyClass === 'down') {
    category = 'down';
  } else if (lastStatus >= 300 && lastStatus < 400) {
    category = 'redirect';
  } else {
    category = classifyByStatus(lastStatus);
  }

  if (redirects > 0) {
    if (category === 'up') category = 'redirect-up';
    else if (category === 'down') category = 'redirect-down';
    else if (category === 'redirect') category = 'redirect-down';
  }

  return {
    finalUrl: lastFinalUrl,
    status: lastStatus,
    category,
    chain,
    body: lastBody,
    redirected: redirects > 0,
    cloudflareSeen
  };
}

async function checkSingleUrl(rawUrl, opts) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return {
      input: rawUrl,
      url: rawUrl,
      category: 'down',
      status: 0,
      error: 'invalid url'
    };
  }

  const main = await followAndCheck(normalized, opts);

  const result = {
    input: rawUrl,
    url: normalized,
    finalUrl: main.finalUrl,
    status: main.status,
    category: main.category,
    redirected: main.redirected,
    chain: main.chain,
    error: main.error || null
  };

  if (opts.scrape) {
    result.scraped = scrapeText(main.body || '', 18);
  }

  if (opts.variations) {
    const variations = getDomainVariations(normalized);
    const variationResults = await Promise.all(
      variations.map(async v => {
        try {
          const r = await followAndCheck(v, opts);
          return {
            url: v,
            finalUrl: r.finalUrl,
            status: r.status,
            category: r.category,
            redirected: r.redirected
          };
        } catch (e) {
          return { url: v, status: 0, category: 'down', error: e.message };
        }
      })
    );
    result.variations = variationResults;
  }

  return result;
}

app.post('/api/check', async (req, res) => {
  try {
    const { urls, variations, scrape } = req.body || {};
    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'urls must be an array' });
    }

    const opts = { variations: !!variations, scrape: !!scrape };

    const concurrency = 8;
    const results = new Array(urls.length);
    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= urls.length) return;
        results[i] = await checkSingleUrl(urls[i], opts);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) workers.push(worker());
    await Promise.all(workers);

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Website Checker running on http://localhost:${port}`));
}

module.exports = app;
