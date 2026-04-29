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
  const resultsCard = $('resultsCard');
  const stackBar = $('stackBar');
  const stackChips = $('stackChips');
  const viewToggle = $('viewToggle');
  const filterHint = $('filterHint');
  const streamView = $('streamView');
  const groupedView = $('groupedView');
  const chartView = $('chartView');
  const donut = $('donut');
  const legend = $('legend');
  const howBtn = $('howBtn');
  const howModal = $('howModal');
  const howClose = $('howClose');

  const STORAGE_KEY = 'site-checker-state-v3';

  const CATEGORIES = [
    { key: 'up',            label: 'Up',            short: 'Up',     color: '#22d172' },
    { key: 'redirect-up',   label: 'Redirect Up',   short: 'R-Up',   color: '#14d2c4' },
    { key: 'redirect-down', label: 'Redirect Down', short: 'R-Down', color: '#ff8a3d' },
    { key: 'unique',        label: 'Unique',        short: 'Unique', color: '#a78bfa' },
    { key: 'cloudflare',    label: 'Cloudflare',    short: 'CF',     color: '#c084fc' },
    { key: 'down',          label: 'Down',          short: 'Down',   color: '#ff5470' }
  ];
  const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

  const state = {
    results: [],
    elapsedMs: 0,
    activeFilter: null,
    view: 'stream'
  };

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        urlsText: urlsEl.value,
        opts: getOpts(),
        results: state.results,
        elapsedMs: state.elapsedMs,
        view: state.view
      }));
    } catch (e) {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
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
      if (s.view) state.view = s.view;
      if (Array.isArray(s.results) && s.results.length) {
        state.results = s.results;
        state.elapsedMs = s.elapsedMs || 0;
        renderAll();
      }
    }
    setView(state.view);
    updateUrlCount();
    updateWarning();
  }

  urlsEl.addEventListener('input', () => { updateUrlCount(); updateWarning(); saveState(); });
  [optRedirects, optVar, optUnique, optAdvanced].forEach(el => el.addEventListener('change', saveState));

  function updateUrlCount() {
    urlCountEl.textContent = String(parseUrlLines(urlsEl.value).length);
  }
  function updateWarning() {
    warningEl.classList.toggle('hidden', parseUrlLines(urlsEl.value).length < 200);
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
    if (ms == null) return '0.0s';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(2)}m`;
    return `${(m / 60).toFixed(2)}h`;
  }

  let timerInterval = null;
  function startTimer(start) {
    timerEl.textContent = '0.0s';
    timerInterval = setInterval(() => { timerEl.textContent = formatElapsed(Date.now() - start); }, 100);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

  checkBtn.addEventListener('click', async () => {
    const lines = parseUrlLines(urlsEl.value);
    if (!lines.length) { alert('Please enter at least one URL.'); return; }
    const { unique, dups } = dedupe(lines);
    if (dups > 0) {
      dupNotice.textContent = `Removed ${dups} duplicate URL${dups === 1 ? '' : 's'}.`;
      dupNotice.classList.remove('hidden');
    } else dupNotice.classList.add('hidden');

    state.results = [];
    state.activeFilter = null;
    resultsCard.classList.remove('hidden');
    streamView.innerHTML = ''; groupedView.innerHTML = '';
    stackBar.innerHTML = ''; stackChips.innerHTML = '';
    checkedCountEl.textContent = '0';

    checkBtn.disabled = true;
    const origLabel = checkBtn.querySelector('span:last-child').textContent;
    checkBtn.querySelector('span:last-child').textContent = 'Checking...';

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
      renderAll();
      saveState();
    } catch (e) {
      stopTimer();
      alert('Check failed: ' + e.message);
    } finally {
      checkBtn.disabled = false;
      checkBtn.querySelector('span:last-child').textContent = origLabel;
    }
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all URLs, results, and settings?')) return;
    localStorage.removeItem(STORAGE_KEY);
    urlsEl.value = '';
    optRedirects.checked = true; optVar.checked = false;
    optUnique.checked = false; optAdvanced.checked = false;
    timerEl.textContent = '0.0s';
    checkedCountEl.textContent = '0';
    dupNotice.classList.add('hidden'); warningEl.classList.add('hidden');
    resultsCard.classList.add('hidden');
    streamView.innerHTML = ''; groupedView.innerHTML = '';
    stackBar.innerHTML = ''; stackChips.innerHTML = '';
    state.results = []; state.elapsedMs = 0; state.activeFilter = null;
    updateUrlCount();
  });

  viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-btn');
    if (!btn) return;
    setView(btn.dataset.view);
    saveState();
  });
  function setView(v) {
    state.view = v;
    [...viewToggle.querySelectorAll('.view-btn')].forEach(b => {
      b.classList.toggle('active', b.dataset.view === v);
    });
    streamView.classList.toggle('hidden', v !== 'stream');
    groupedView.classList.toggle('hidden', v !== 'grouped');
    chartView.classList.toggle('hidden', v !== 'chart');
  }

  stackChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.schip');
    if (!chip) return;
    const cat = chip.dataset.cat;
    state.activeFilter = (state.activeFilter === cat) ? null : cat;
    renderStream();
    renderGrouped();
    renderChips();
    renderHint();
  });
  stackBar.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    const cat = seg.dataset.cat;
    state.activeFilter = (state.activeFilter === cat) ? null : cat;
    renderStream();
    renderGrouped();
    renderChips();
    renderHint();
  });
  filterHint.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-clear]');
    if (!a) return;
    state.activeFilter = null;
    renderStream();
    renderGrouped();
    renderChips();
    renderHint();
  });

  function countByCategory() {
    const counts = {};
    for (const r of state.results) {
      counts[r.category] = (counts[r.category] || 0) + 1;
      if (r.uniqueRedirect) counts.unique = (counts.unique || 0) + 1;
    }
    return counts;
  }

  function renderAll() {
    if (!state.results.length) { resultsCard.classList.add('hidden'); return; }
    resultsCard.classList.remove('hidden');
    timerEl.textContent = formatElapsed(state.elapsedMs);
    checkedCountEl.textContent = String(state.results.length);
    renderStackBar();
    renderChips();
    renderHint();
    renderStream();
    renderGrouped();
    renderChart();
  }

  function renderStackBar() {
    stackBar.innerHTML = '';
    const counts = countByCategory();
    const total = CATEGORIES.filter(c => c.key !== 'unique').reduce((s, c) => s + (counts[c.key] || 0), 0);
    if (!total) return;
    for (const cat of CATEGORIES) {
      if (cat.key === 'unique') continue;
      const v = counts[cat.key] || 0;
      if (!v) continue;
      const seg = document.createElement('div');
      seg.className = `seg ${cat.key}`;
      seg.dataset.cat = cat.key;
      seg.style.flex = `${v} 0 0`;
      seg.title = `${cat.label}: ${v} (${((v/total)*100).toFixed(1)}%)`;
      stackBar.appendChild(seg);
    }
  }

  function renderChips() {
    stackChips.innerHTML = '';
    const counts = countByCategory();
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      const chip = document.createElement('button');
      chip.className = 'schip';
      chip.dataset.cat = cat.key;
      if (!v) chip.classList.add('dim');
      if (state.activeFilter === cat.key) chip.classList.add('active');
      chip.innerHTML = `<span class="sdot"></span>${cat.short} <span class="schip-num">${v}</span>`;
      stackChips.appendChild(chip);
    }
  }

  function renderHint() {
    if (state.activeFilter) {
      filterHint.innerHTML = `Filtered to <strong>${CAT_LABEL[state.activeFilter]}</strong> &middot; <a data-clear>clear</a>`;
    } else {
      filterHint.textContent = '';
    }
  }

  function matchesFilter(r) {
    if (!state.activeFilter) return true;
    if (state.activeFilter === 'unique') return !!r.uniqueRedirect;
    return r.category === state.activeFilter;
  }

  function renderStream() {
    streamView.innerHTML = '';
    const items = state.results.filter(matchesFilter);
    if (!items.length) {
      streamView.innerHTML = `<div style="padding:32px 14px;text-align:center;color:#666;font-size:13px;">No results in this category.</div>`;
      return;
    }
    for (const r of items) streamView.appendChild(buildRow(r));
  }

  function buildRow(r) {
    const row = document.createElement('div');
    row.className = `row cat-${r.category}`;

    const bar = document.createElement('div'); bar.className = 'bar';
    row.appendChild(bar);

    const body = document.createElement('div'); body.className = 'body';

    const urlLine = document.createElement('div');
    urlLine.className = 'url-line';
    const a = document.createElement('a');
    a.href = r.url || r.input; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = r.url || r.input;
    urlLine.appendChild(a);
    if (r.uniqueRedirect) {
      const u = document.createElement('span'); u.className = 'uniq-badge'; u.textContent = 'UNIQUE';
      urlLine.appendChild(u);
    }
    body.appendChild(urlLine);

    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.innerHTML = formatChainDetail(r);
    body.appendChild(detail);

    if (Array.isArray(r.variations) && r.variations.length) {
      const vw = document.createElement('div'); vw.className = 'vars';
      for (const v of r.variations) {
        const vb = document.createElement('a');
        vb.className = `vbadge ${v.category || 'down'}`;
        vb.href = v.url; vb.target = '_blank'; vb.rel = 'noopener';
        vb.title = `${v.url}\n${CAT_LABEL[v.category] || v.category} (${v.status || 'ERR'})`;
        vb.innerHTML = `<span class="vd"></span>${shortVariant(v.url)}`;
        vw.appendChild(vb);
      }
      body.appendChild(vw);
    }
    row.appendChild(body);

    const pill = document.createElement('span');
    pill.className = `pill ${r.category}`;
    pill.textContent = CAT_LABEL[r.category] || r.category;
    row.appendChild(pill);

    return row;
  }

  function formatChainDetail(r) {
    const out = [];
    out.push(`HTTP ${r.firstStatus || 0}`);
    if (r.chain && r.chain.length) {
      for (const _ of r.chain) out.push(`<span class="arr">&rarr;</span>Redirect`);
    }
    if (r.error) {
      out.push(`<span class="arr">&rarr;</span>${escapeHtml(r.error)}`);
    } else if (r.finalStatus && (r.chain && r.chain.length || r.firstStatus !== r.finalStatus)) {
      const cf = r.cloudflareSeen ? ` <span class="cf-mark">(Cloudflare)</span>` : '';
      out.push(`<span class="arr">&rarr;</span>HTTP ${r.finalStatus}${cf}`);
    } else if (r.cloudflareSeen) {
      out.push(` <span class="cf-mark">(Cloudflare)</span>`);
    }
    if (r.timingMs != null) out.push(` <span class="ms">&middot; ${r.timingMs}ms</span>`);
    if (r.finalUrl && r.finalUrl !== r.url) {
      const suffix = r.finalStatus ? ` (${r.finalStatus})` : '';
      out.push(`<br/><span class="arr">&rarr;</span><a href="${escapeAttr(r.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(r.finalUrl)}</a>${suffix}`);
    }
    return out.join('');
  }

  function shortVariant(u) {
    try {
      const p = new URL(u);
      const proto = p.protocol === 'https:' ? 'https' : 'http';
      const www = p.host.toLowerCase().startsWith('www.') ? 'www' : '@';
      return `${proto}/${www}`;
    } catch (e) { return u; }
  }

  function renderGrouped() {
    groupedView.innerHTML = '';
    let any = false;
    for (const cat of CATEGORIES) {
      const items = state.results.filter(r => {
        if (state.activeFilter && state.activeFilter !== cat.key) return false;
        return cat.key === 'unique' ? !!r.uniqueRedirect : r.category === cat.key;
      });
      if (!items.length) continue;
      any = true;
      groupedView.appendChild(buildGroupCard(cat, items));
    }
    if (!any) {
      groupedView.innerHTML = `<div style="padding:32px 14px;text-align:center;color:#666;font-size:13px;">No groups to show.</div>`;
    }
  }

  function buildGroupCard(cat, items) {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.dataset.cat = cat.key;

    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<div class="group-title"><span class="gdot"></span>${cat.label}<span class="gcount">${items.length}</span></div>`;

    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const text = items.map(i => i.url || i.input).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copy.classList.add('copied'); copy.textContent = 'Copied';
        setTimeout(() => { copy.classList.remove('copied'); copy.textContent = 'Copy'; }, 1300);
      } catch (e) { alert('Copy failed'); }
    });
    head.appendChild(copy);
    card.appendChild(head);

    const rows = document.createElement('div'); rows.className = 'group-rows';
    for (const r of items) {
      const a = document.createElement('a');
      a.className = 'group-row';
      a.href = r.url || r.input; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = r.url || r.input;
      rows.appendChild(a);
    }
    card.appendChild(rows);
    return card;
  }

  function renderChart() {
    const counts = countByCategory();
    const ctx = donut.getContext('2d');
    const w = donut.width, h = donut.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const outer = Math.min(w, h) / 2 - 8;
    const inner = outer * 0.66;
    const drawCats = CATEGORIES.filter(c => c.key !== 'unique');
    const total = drawCats.reduce((s, c) => s + (counts[c.key] || 0), 0);

    if (!total) {
      ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('No data', cx, cy);
    } else {
      let start = -Math.PI / 2;
      for (const cat of drawCats) {
        const v = counts[cat.key] || 0;
        if (!v) continue;
        const angle = (v / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy); ctx.arc(cx, cy, outer, start, start + angle); ctx.closePath();
        ctx.fillStyle = cat.color; ctx.fill();
        start += angle;
      }
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 28px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(String(total), cx, cy - 6);
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = '#888';
      ctx.fillText('total', cx, cy + 16);
    }

    legend.innerHTML = '';
    for (const cat of CATEGORIES) {
      const v = counts[cat.key] || 0;
      if (!v) continue;
      const denom = cat.key === 'unique' ? state.results.length : total;
      const pct = denom ? ((v / denom) * 100).toFixed(1) : '0.0';
      const row = document.createElement('div');
      row.className = 'lrow';
      row.innerHTML = `<span class="swatch" style="background:${cat.color}"></span>
        <span>${cat.label}</span>
        <span class="lcount">${v} &middot; ${pct}%</span>`;
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
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  init();
})();
