(() => {
  const $ = (id) => document.getElementById(id);
  const urlsEl = $('urls');
  const urlCountEl = $('urlCount');
  const optRedirects = $('optRedirects');
  const optVar = $('optVariations');
  const optUnique = $('optUnique');
  const optAdvanced = $('optAdvanced');
  const checkBtn = $('checkBtn');
  const clearBtn = $('clearBtn');
  const timerEl = $('timer');
  const checkedCountEl = $('checkedCount');
  const warningEl = $('warning');
  const dupNotice = $('dupNotice');
  const liveResultsPanel = $('liveResultsPanel');
  const liveList = $('liveList');
  const tablesPanel = $('tablesPanel');
  const tablesGrid = $('tablesGrid');
  const breakdownPanel = $('breakdownPanel');
  const breakdownChips = $('breakdownChips');
  const donut = $('donut');
  const legend = $('legend');
  const filterPills = $('filterPills');
  const howBtn = $('howBtn');
  const howModal = $('howModal');
  const howClose = $('howClose');

  const STORAGE_KEY = 'omair-checker-state-v2';

  const CATEGORIES = [
    { key: 'up',            label: 'Up',            color: '#10b981' },
    { key: 'redirect-up',   label: 'Redirect Up',   color: '#14b8a6' },
    { key: 'redirect-down', label: 'Redirect Down', color: '#f97316' },
    { key: 'unique',        label: 'Unique',        color: '#8b5cf6' },
    { key: 'cloudflare',    label: 'Cloudflare',    color: '#a855f7' },
    { key: 'down',          label: 'Down',          color: '#ef4444' }
  ];
  const CAT_COLOR = Object.fromEntries(CATEGORIES.map(c => [c.key, c.color]));
  const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
  const SHORT_LABEL = { up: 'Up', 'redirect-up': 'Redirect Up', 'redirect-down': 'Redirect Down', unique: 'Unique', cloudflare: 'CF', down: 'Down' };

  const state = {
    results: [],
    elapsedMs: 0,
    activeFilter: null
  };

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        urlsText: urlsEl.value,
        opts: getOpts(),
        results: state.results,
        elapsedMs: state.elapsedMs
      }));
    } catch (e) {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function getOpts() {
    return {
      redirects: optRedirects.checked,
      variations: optVar.checked,
      unique: optUnique.checked,
      advanced: optAdvanced.checked
    };
  }

  function init() {
    const s = loadState();
    if (s) {
      urlsEl.value = s.urlsText || '';
      if (s.opts) {
        optRedirects.checked = s.opts.redirects !== false;
        optVar.checked = !!s.opts.variations;
        optUnique.checked = !!s.opts.unique;
        optAdvanced.checked = !!s.opts.advanced;
      }
      if (Array.isArray(s.results) && s.results.length) {
        state.results = s.results;
        state.elapsedMs = s.elapsedMs || 0;
        renderAll();
      }
    }
    updateUrlCount();
    updateWarning();
  }

  urlsEl.addEventListener('input', () => {
    updateUrlCount();
    updateWarning();
    saveState();
  });
  [optRedirects, optVar, optUnique, optAdvanced].forEach(el => el.addEventListener('change', saveState));

  function updateUrlCount() {
    const n = parseUrlLines(urlsEl.value).length;
    urlCountEl.textContent = String(n);
  }
  function updateWarning() {
    const n = parseUrlLines(urlsEl.value).length;
    warningEl.classList.toggle('hidden', n < 200);
  }

  function parseUrlLines(text) {
    return (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  function dedupe(arr) {
    const seen = new Set(); const unique = []; let dups = 0;
    for (const x of arr) {
      const key = x.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (seen.has(key)) { dups++; continue; }
      seen.add(key); unique.push(x);
    }
    return { unique, dups };
  }

  function formatElapsed(ms) {
    if (!ms && ms !== 0) return '';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(2)}m`;
    return `${(m / 60).toFixed(2)}h`;
  }

  let timerInterval = null;
  function startTimer(startTime) {
    timerEl.textContent = '0.0s';
    timerInterval = setInterval(() => {
      timerEl.textContent = formatElapsed(Date.now() - startTime);
    }, 100);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  checkBtn.addEventListener('click', async () => {
    const lines = parseUrlLines(urlsEl.value);
    if (!lines.length) { alert('Please enter at least one URL.'); return; }
    const { unique, dups } = dedupe(lines);
    if (dups > 0) {
      dupNotice.textContent = `Removed ${dups} duplicate URL${dups === 1 ? '' : 's'}.`;
      dupNotice.classList.remove('hidden');
    } else {
      dupNotice.classList.add('hidden');
    }

    state.results = [];
    state.activeFilter = null;
    liveResultsPanel.classList.remove('hidden');
    tablesPanel.classList.add('hidden');
    breakdownPanel.classList.add('hidden');
    liveList.innerHTML = '';
    checkedCountEl.textContent = '0';

    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking...';
    const start = Date.now();
    startTimer(start);

    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: unique, ...getOpts() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const elapsed = Date.now() - start;
      stopTimer();
      timerEl.textContent = formatElapsed(elapsed);
      state.results = data.results || [];
      state.elapsedMs = elapsed;
      checkedCountEl.textContent = String(state.results.length);
      renderAll();
      saveState();
    } catch (e) {
      stopTimer();
      alert('Check failed: ' + e.message);
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check Status';
    }
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all URLs, results, and settings?')) return;
    localStorage.removeItem(STORAGE_KEY);
    urlsEl.value = '';
    optRedirects.checked = true;
    optVar.checked = false;
    optUnique.checked = false;
    optAdvanced.checked = false;
    timerEl.textContent = '0s';
    checkedCountEl.textContent = '0';
    dupNotice.classList.add('hidden');
    warningEl.classList.add('hidden');
    liveResultsPanel.classList.add('hidden');
    tablesPanel.classList.add('hidden');
    breakdownPanel.classList.add('hidden');
    liveList.innerHTML = '';
    tablesGrid.innerHTML = '';
    state.results = [];
    state.elapsedMs = 0;
    state.activeFilter = null;
    updateUrlCount();
  });

  filterPills.addEventListener('click', (e) => {
    const btn = e.target.closest('.fpill');
    if (!btn) return;
    const cat = btn.dataset.cat;
    state.activeFilter = (state.activeFilter === cat) ? null : cat;
    renderLiveList();
    renderFilterPills();
  });

  function renderAll() {
    if (!state.results.length) {
      liveResultsPanel.classList.add('hidden');
      tablesPanel.classList.add('hidden');
      breakdownPanel.classList.add('hidden');
      return;
    }
    liveResultsPanel.classList.remove('hidden');
    tablesPanel.classList.remove('hidden');
    breakdownPanel.classList.remove('hidden');
    timerEl.textContent = formatElapsed(state.elapsedMs);
    checkedCountEl.textContent = String(state.results.length);

    renderFilterPills();
    renderLiveList();
    renderTables();
    renderBreakdown();
  }

  function renderFilterPills() {
    const counts = countByCategory();
    [...filterPills.querySelectorAll('.fpill')].forEach(b => {
      const c = b.dataset.cat;
      b.classList.toggle('dim', !(counts[c] > 0));
      b.classList.toggle('active', state.activeFilter === c);
      b.textContent = `${CAT_LABEL[c]}${counts[c] ? ` (${counts[c]})` : ''}`;
    });
  }

  function countByCategory() {
    const counts = {};
    for (const r of state.results) {
      counts[r.category] = (counts[r.category] || 0) + 1;
      if (r.uniqueRedirect) counts.unique = (counts.unique || 0) + 1;
    }
    return counts;
  }

  function renderLiveList() {
    liveList.innerHTML = '';
    const items = state.results.filter(r => {
      if (!state.activeFilter) return true;
      if (state.activeFilter === 'unique') return !!r.uniqueRedirect;
      return r.category === state.activeFilter;
    });
    for (const r of items) liveList.appendChild(buildLiveRow(r));
  }

  function buildLiveRow(r) {
    const row = document.createElement('div');
    row.className = `live-row cat-${r.category}`;

    const main = document.createElement('div');
    main.className = 'live-main';

    const link = document.createElement('a');
    link.className = 'live-url';
    link.href = r.url || r.input;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = r.url || r.input;
    main.appendChild(link);

    const detail = document.createElement('div');
    detail.className = 'live-detail';
    detail.innerHTML = formatChainDetail(r);
    main.appendChild(detail);

    if (Array.isArray(r.variations) && r.variations.length) {
      const vw = document.createElement('div');
      vw.className = 'var-badges';
      for (const v of r.variations) {
        const a = document.createElement('a');
        a.className = `var-badge ${v.category || 'down'}`;
        a.href = v.url; a.target = '_blank'; a.rel = 'noopener';
        a.title = `${v.url}\n${CAT_LABEL[v.category] || v.category} (${v.status || 'ERR'})`;
        a.innerHTML = `<span class="vdot"></span>${shortVariant(v.url)}`;
        vw.appendChild(a);
      }
      main.appendChild(vw);
    }

    row.appendChild(main);

    const badge = document.createElement('span');
    badge.className = `badge ${r.category}`;
    badge.textContent = CAT_LABEL[r.category] || r.category;
    row.appendChild(badge);

    return row;
  }

  function formatChainDetail(r) {
    const parts = [];
    const firstStatus = r.firstStatus || 0;
    parts.push(`HTTP ${firstStatus || 0}`);

    if (r.chain && r.chain.length) {
      for (const hop of r.chain) {
        parts.push(` <span class="arrow">&rarr;</span> Redirect`);
      }
    }

    if (r.error) {
      parts.push(` <span class="arrow">&rarr;</span> ${escapeHtml(r.error)}`);
    } else if (r.finalStatus) {
      const cfNote = r.cloudflareSeen ? ' with Cloudflare headers' : '';
      parts.push(` <span class="arrow">&rarr;</span> HTTP ${r.finalStatus}${cfNote}`);
    } else if (firstStatus && (!r.chain || !r.chain.length)) {
      // single-hop already shown
    }

    if (r.timingMs != null) {
      parts.push(`<span class="ms"> &middot; ${r.timingMs}ms</span>`);
    }

    if (r.finalUrl && r.finalUrl !== r.url) {
      const statusSuffix = r.finalStatus ? ` (${r.finalStatus})` : '';
      parts.push(` <span class="arrow">&rarr;</span> <a href="${escapeAttr(r.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(r.finalUrl)}</a>${statusSuffix}`);
    }

    return parts.join('');
  }

  function shortVariant(u) {
    try {
      const p = new URL(u);
      const proto = p.protocol === 'https:' ? 'https' : 'http';
      const www = p.host.toLowerCase().startsWith('www.') ? 'www' : '@';
      return `${proto}/${www}`;
    } catch (e) { return u; }
  }

  function renderTables() {
    tablesGrid.innerHTML = '';
    for (const cat of CATEGORIES) {
      const items = state.results.filter(r =>
        cat.key === 'unique'
          ? !!r.uniqueRedirect
          : r.category === cat.key
      );
      if (!items.length) continue;
      tablesGrid.appendChild(buildTableCard(cat, items));
    }
  }

  function buildTableCard(cat, items) {
    const card = document.createElement('div');
    card.className = `table-card cat-${cat.key}`;

    const head = document.createElement('div');
    head.className = 'table-head';
    head.innerHTML = `<div class="table-title">${cat.label}</div>`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy List';
    copyBtn.addEventListener('click', async () => {
      const text = items.map(i => i.url || i.input).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.classList.add('copied');
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.textContent = 'Copy List'; }, 1300);
      } catch (e) { alert('Copy failed'); }
    });
    head.appendChild(copyBtn);
    card.appendChild(head);

    const rows = document.createElement('div');
    rows.className = 'table-rows';
    for (const r of items) {
      const a = document.createElement('a');
      a.className = 'table-row';
      a.href = r.url || r.input;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.url || r.input;
      rows.appendChild(a);
    }
    card.appendChild(rows);
    return card;
  }

  function renderBreakdown() {
    const counts = countByCategory();
    breakdownChips.innerHTML = '';
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      const chip = document.createElement('span');
      chip.className = 'bchip';
      chip.dataset.cat = cat.key;
      chip.textContent = `${SHORT_LABEL[cat.key]}: ${v}`;
      breakdownChips.appendChild(chip);
    }
    drawDonut(counts);
    renderLegend(counts);
  }

  function drawDonut(counts) {
    const ctx = donut.getContext('2d');
    const w = donut.width, h = donut.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const outer = Math.min(w, h) / 2 - 6;
    const inner = outer * 0.62;

    const drawCats = CATEGORIES.filter(c => c.key !== 'unique');
    const total = drawCats.reduce((sum, c) => sum + (counts[c.key] || 0), 0);
    if (total === 0) {
      ctx.fillStyle = '#8b95a7';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '13px -apple-system, Segoe UI, sans-serif';
      ctx.fillText('No data', cx, cy);
      return;
    }

    let start = -Math.PI / 2;
    for (const cat of drawCats) {
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
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(total), cx, cy - 6);
    ctx.font = '11px -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = '#8b95a7';
    ctx.fillText('total', cx, cy + 16);
  }

  function renderLegend(counts) {
    legend.innerHTML = '';
    const total = CATEGORIES.filter(c => c.key !== 'unique').reduce((s, c) => s + (counts[c.key] || 0), 0);
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      if (!v) continue;
      const denom = cat.key === 'unique' ? state.results.length : total;
      const pct = denom ? ((v / denom) * 100).toFixed(1) : '0.0';
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="swatch" style="background:${cat.color}"></span>
        <span>${cat.label}</span>
        <span class="count">${v} (${pct}%)</span>`;
      legend.appendChild(row);
    }
  }

  howBtn.addEventListener('click', () => howModal.classList.remove('hidden'));
  howClose.addEventListener('click', () => howModal.classList.add('hidden'));
  howModal.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) howModal.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') howModal.classList.add('hidden');
  });

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  init();
})();
