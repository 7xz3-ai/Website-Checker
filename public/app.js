(() => {
  const $ = (id) => document.getElementById(id);
  const urlsEl = $('urls');
  const optVar = $('optVariations');
  const optScrape = $('optScrape');
  const checkBtn = $('checkBtn');
  const clearBtn = $('clearBtn');
  const spinner = $('spinner');
  const timerEl = $('timer');
  const warningEl = $('warning');
  const dupNotice = $('dupNotice');
  const resultsPanel = $('resultsPanel');
  const tablesEl = $('tables');
  const donut = $('donut');
  const legend = $('legend');

  const STORAGE_KEY = 'website-checker-state-v1';

  const CATEGORIES = [
    { key: 'up', label: 'Up', color: '#3fb950' },
    { key: 'redirect-up', label: 'Redirect Up', color: '#56d364' },
    { key: 'redirect', label: 'Redirect', color: '#d29922' },
    { key: 'redirect-down', label: 'Redirect Down', color: '#ff7b72' },
    { key: 'cloudflare', label: 'Cloudflare', color: '#f78166' },
    { key: 'down', label: 'Down', color: '#f85149' }
  ];
  const CAT_COLOR = Object.fromEntries(CATEGORIES.map(c => [c.key, c.color]));
  const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

  function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function init() {
    const s = loadState();
    if (s) {
      urlsEl.value = s.urlsText || '';
      optVar.checked = !!s.variations;
      optScrape.checked = !!s.scrape;
      if (s.results && Array.isArray(s.results) && s.results.length) {
        renderResults(s.results, s.elapsedMs || 0);
      }
    }
    updateWarning();
  }

  urlsEl.addEventListener('input', () => {
    persist();
    updateWarning();
  });
  optVar.addEventListener('change', persist);
  optScrape.addEventListener('change', persist);

  function persist(extra = {}) {
    const cur = loadState() || {};
    saveState({
      urlsText: urlsEl.value,
      variations: optVar.checked,
      scrape: optScrape.checked,
      results: extra.results !== undefined ? extra.results : cur.results || [],
      elapsedMs: extra.elapsedMs !== undefined ? extra.elapsedMs : cur.elapsedMs || 0
    });
  }

  function updateWarning() {
    const lines = parseUrlLines(urlsEl.value);
    warningEl.classList.toggle('hidden', lines.length < 200);
  }

  function parseUrlLines(text) {
    return (text || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function dedupe(arr) {
    const seen = new Set();
    const unique = [];
    let dups = 0;
    for (const x of arr) {
      const key = x.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (seen.has(key)) { dups++; continue; }
      seen.add(key);
      unique.push(x);
    }
    return { unique, dups };
  }

  function formatElapsed(ms) {
    if (!ms) return '';
    const s = ms / 1000;
    if (s < 60) return `Took ${s.toFixed(2)}s`;
    const m = s / 60;
    if (m < 60) return `Took ${m.toFixed(2)}m`;
    const h = m / 60;
    return `Took ${h.toFixed(2)}h`;
  }

  let timerInterval = null;
  function startTimer(startTime) {
    timerEl.textContent = '0.0s';
    timerInterval = setInterval(() => {
      const e = Date.now() - startTime;
      timerEl.textContent = formatElapsed(e).replace('Took ', '');
    }, 100);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  checkBtn.addEventListener('click', async () => {
    const lines = parseUrlLines(urlsEl.value);
    if (!lines.length) {
      alert('Please enter at least one URL.');
      return;
    }
    const { unique, dups } = dedupe(lines);
    if (dups > 0) {
      dupNotice.textContent = `Removed ${dups} duplicate URL${dups === 1 ? '' : 's'}.`;
      dupNotice.classList.remove('hidden');
    } else {
      dupNotice.classList.add('hidden');
    }

    spinner.classList.remove('hidden');
    checkBtn.disabled = true;
    const start = Date.now();
    startTimer(start);

    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: unique,
          variations: optVar.checked,
          scrape: optScrape.checked
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const elapsed = Date.now() - start;
      stopTimer();
      timerEl.textContent = formatElapsed(elapsed);
      renderResults(data.results || [], elapsed);
      persist({ results: data.results || [], elapsedMs: elapsed });
    } catch (e) {
      stopTimer();
      timerEl.textContent = '';
      alert('Check failed: ' + e.message);
    } finally {
      spinner.classList.add('hidden');
      checkBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all URLs, results, and settings?')) return;
    localStorage.removeItem(STORAGE_KEY);
    urlsEl.value = '';
    optVar.checked = false;
    optScrape.checked = false;
    timerEl.textContent = '';
    dupNotice.classList.add('hidden');
    warningEl.classList.add('hidden');
    resultsPanel.classList.add('hidden');
    tablesEl.innerHTML = '';
    legend.innerHTML = '';
    const ctx = donut.getContext('2d');
    ctx.clearRect(0, 0, donut.width, donut.height);
  });

  function renderResults(results, elapsedMs) {
    if (!results.length) {
      resultsPanel.classList.add('hidden');
      return;
    }
    resultsPanel.classList.remove('hidden');
    timerEl.textContent = formatElapsed(elapsedMs);

    const counts = {};
    for (const r of results) {
      const k = r.category || 'down';
      counts[k] = (counts[k] || 0) + 1;
    }
    drawDonut(counts);
    renderLegend(counts, results.length);

    tablesEl.innerHTML = '';
    for (const cat of CATEGORIES) {
      const items = results.filter(r => (r.category || 'down') === cat.key);
      if (!items.length) continue;
      tablesEl.appendChild(buildTable(cat, items));
    }
  }

  function drawDonut(counts) {
    const ctx = donut.getContext('2d');
    const w = donut.width, h = donut.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const outer = Math.min(w, h) / 2 - 6;
    const inner = outer * 0.6;

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return;

    let start = -Math.PI / 2;
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      if (!v) continue;
      const angle = (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outer, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = cat.color;
      ctx.fill();
      start += angle;
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(total), cx, cy - 6);
    ctx.font = '11px -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('total', cx, cy + 14);
  }

  function renderLegend(counts, total) {
    legend.innerHTML = '';
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      if (!v) continue;
      const pct = ((v / total) * 100).toFixed(1);
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="swatch" style="background:${cat.color}"></span>
        <span>${cat.label}</span>
        <span class="count">${v} (${pct}%)</span>`;
      legend.appendChild(row);
    }
  }

  function buildTable(cat, items) {
    const wrap = document.createElement('div');
    wrap.className = 'cat-section';

    const title = document.createElement('h3');
    title.className = 'cat-title';
    title.innerHTML = `<span class="dot" style="background:${cat.color}"></span>
      ${cat.label} <span class="count" style="color:#8b949e;font-weight:400;font-size:13px">(${items.length})</span>`;
    wrap.appendChild(title);

    const table = document.createElement('table');
    table.className = 'results';
    const variationsEnabled = items.some(x => Array.isArray(x.variations) && x.variations.length);
    const scrapeEnabled = items.some(x => typeof x.scraped === 'string' && x.scraped);

    let header = '<tr><th>URL</th><th>Status</th><th>Final URL</th>';
    if (variationsEnabled) header += '<th>Variations</th>';
    if (scrapeEnabled) header += '<th>Scraped</th>';
    header += '</tr>';
    table.innerHTML = `<thead>${header}</thead>`;

    const tbody = document.createElement('tbody');
    for (const r of items) {
      const tr = document.createElement('tr');

      const tdUrl = document.createElement('td');
      tdUrl.innerHTML = `<a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.input || r.url)}</a>`;
      tr.appendChild(tdUrl);

      const tdStatus = document.createElement('td');
      const statusText = r.status ? r.status : (r.error ? 'ERR' : '—');
      tdStatus.innerHTML = `<span class="badge ${r.category}">${CAT_LABEL[r.category] || r.category}</span>
        <div class="count" style="color:#8b949e;font-size:11.5px;margin-top:3px;">${statusText}${r.error ? ' · ' + escapeHtml(r.error) : ''}</div>`;
      tr.appendChild(tdStatus);

      const tdFinal = document.createElement('td');
      if (r.finalUrl && r.finalUrl !== r.url) {
        tdFinal.innerHTML = `<a href="${escapeAttr(r.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(r.finalUrl)}</a>`;
      } else {
        tdFinal.innerHTML = `<span style="color:#8b949e">—</span>`;
      }
      tr.appendChild(tdFinal);

      if (variationsEnabled) {
        const tdVar = document.createElement('td');
        const vs = r.variations || [];
        const div = document.createElement('div');
        div.className = 'variations';
        for (const v of vs) {
          const a = document.createElement('a');
          a.className = 'var-badge';
          a.href = v.url;
          a.target = '_blank';
          a.rel = 'noopener';
          const color = CAT_COLOR[v.category] || '#8b949e';
          a.innerHTML = `<span class="vdot" style="background:${color}"></span>${escapeHtml(shortVariant(v.url))}`;
          a.title = `${v.url}\nStatus: ${v.status || 'ERR'} (${CAT_LABEL[v.category] || v.category})`;
          div.appendChild(a);
        }
        tdVar.appendChild(div);
        tr.appendChild(tdVar);
      }

      if (scrapeEnabled) {
        const tdScrape = document.createElement('td');
        tdScrape.innerHTML = r.scraped
          ? `<span class="scraped">${escapeHtml(r.scraped)}</span>`
          : `<span style="color:#8b949e">—</span>`;
        tr.appendChild(tdScrape);
      }

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function shortVariant(u) {
    try {
      const p = new URL(u);
      const proto = p.protocol === 'https:' ? 'https' : 'http';
      const www = p.host.startsWith('www.') ? 'www' : '@';
      return `${proto}/${www}`;
    } catch (e) {
      return u;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  init();
})();
