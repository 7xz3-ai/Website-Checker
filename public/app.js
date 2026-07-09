(() => {
  // =========================================================================
  // Auth
  // =========================================================================
  const AUTH_SESSION_KEY = 'site-checker-key-v1';
  function getAuthKey() {
    try { return sessionStorage.getItem(AUTH_SESSION_KEY) || ''; } catch (e) { return ''; }
  }
  function setAuthKey(v) {
    try {
      if (v) sessionStorage.setItem(AUTH_SESSION_KEY, v);
      else sessionStorage.removeItem(AUTH_SESSION_KEY);
    } catch (e) {}
  }
  function authHeaders() {
    const k = getAuthKey();
    return k ? { 'x-checker-key': k } : {};
  }
  // All API calls go through here so we never forget the auth header.
  async function api(path, init) {
    const opts = init || {};
    const headers = Object.assign({}, opts.headers || {}, authHeaders());
    const resp = await fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
    return resp;
  }

  // =========================================================================
  // Safe URL helpers (defence in depth - server also enforces these)
  // =========================================================================
  // Extracts URLs from arbitrary pasted text. Tolerant of prose, markdown,
  // chat exports, etc. Drops emails, version strings, and obviously bad tokens.
  function extractUrls(text) {
    if (typeof text !== 'string' || !text) return [];
    const out = [];
    const seen = new Set();
    // Markdown link [label](url) -> keep url
    text = text.replace(/\[[^\]]*\]\(([^)\s]+)\)/g, ' $1 ');
    // Split on whitespace and a few separators almost never seen inside URLs
    const tokens = text.split(/[\s,;<>|`"]+/);
    for (let t of tokens) {
      if (!t) continue;
      // Strip wrapping/trailing punctuation that hangs on URLs in prose
      t = t.replace(/^[(\[{<'"]+/, '').replace(/[.,;:!?'")\]\}>]+$/, '');
      if (!t || t.length < 4) continue;
      if (t.includes('@')) continue;                 // emails
      if (/^mailto:/i.test(t)) continue;
      if (/^tel:/i.test(t)) continue;
      if (/^[\d.]+$/.test(t)) continue;              // 1.2.3 version-style
      let candidate = t;
      const isAbsolute = /^https?:\/\//i.test(candidate);
      if (!isAbsolute) {
        // Bare domain or domain/path: must contain a dot and end with a TLD-like label
        if (!/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,24}(?::\d+)?(?:\/.*)?$/i.test(candidate)) continue;
      } else {
        // For absolute URLs, demand at least one dot in the host
        try {
          const u = new URL(candidate);
          if (!u.hostname.includes('.')) continue;
        } catch (e) { continue; }
      }
      const key = candidate.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  }

  function safeHttpHref(value) {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (!v) return '';
    // Reject anything that isn't an http(s) absolute URL.
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (u.username || u.password) return '';
      return u.toString();
    } catch (e) {
      return '';
    }
  }

  const $ = (id) => document.getElementById(id);
  const urlsEl = $('urls');
  const urlCountEl = $('urlCount');
  const optRedirects = $('optRedirects');
  const optVar = $('optVariations');
  const optUnique = $('optUnique');
  const optAdvanced = $('optAdvanced');
  const checkBtn = $('checkBtn');
  const clearBtn = $('clearBtn');
  const cleanBtn = $('cleanBtn');
  const timerEl = $('timer');
  const checkedCountEl = $('checkedCount');
  const warningEl = $('warning');
  const dupNotice = $('dupNotice');
  const resultsCard = $('resultsCard');
  const progressBar = $('progressBar');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');
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
  const hideVisitedEl = $('hideVisited');
  const visitedCountEl = $('visitedCount');
  const notesView = $('notesView');
  const generalNotesEl = $('generalNotes');
  const notesAutosaveEl = $('notesAutosave');
  const savedSitesListEl = $('savedSitesList');
  const savedSitesEmptyEl = $('savedSitesEmpty');
  const savedSitesCountEl = $('savedSitesCount');
  const addSiteInput = $('addSiteInput');
  const addSiteBtn = $('addSiteBtn');
  const exportNotesBtn = $('exportNotesBtn');
  const clearNotesBtn = $('clearNotesBtn');
  const notesBadge = $('notesBadge');

  const STORAGE_KEY = 'site-checker-state-v3';
  const VISITED_KEY = 'site-checker-visited-v1';
  const NOTES_KEY = 'site-checker-notes-v1';

  function loadVisited() {
    try {
      const arr = JSON.parse(localStorage.getItem(VISITED_KEY)) || [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  }
  function saveVisited() {
    try { localStorage.setItem(VISITED_KEY, JSON.stringify([...visited])); } catch (e) {}
  }
  function visitedKey(url) {
    try {
      const u = new URL(url);
      return u.host.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch (e) { return String(url || '').toLowerCase(); }
  }
  function isVisited(url) { return visited.has(visitedKey(url)); }
  function markVisited(url, on) {
    const k = visitedKey(url);
    if (on) visited.add(k); else visited.delete(k);
    saveVisited();
  }
  const visited = loadVisited();
  let hideVisited = false;

  function loadNotes() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTES_KEY));
      if (!raw || typeof raw !== 'object') return { general: '', sites: {} };
      return { general: String(raw.general || ''), sites: raw.sites && typeof raw.sites === 'object' ? raw.sites : {} };
    } catch (e) { return { general: '', sites: {} }; }
  }
  let notesSaveTimer = null;
  function saveNotes(immediate) {
    const doSave = () => {
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
      if (notesAutosaveEl) {
        notesAutosaveEl.textContent = 'Saved';
        clearTimeout(notesAutosaveEl._t);
        notesAutosaveEl._t = setTimeout(() => { notesAutosaveEl.textContent = 'Auto-saved'; }, 1200);
      }
    };
    if (immediate) doSave();
    else { clearTimeout(notesSaveTimer); notesSaveTimer = setTimeout(doSave, 250); }
  }
  function notesKey(url) { return visitedKey(url); }
  function isNoted(url) { return !!notes.sites[notesKey(url)]; }
  function addSiteToNotes(url, source) {
    const k = notesKey(url);
    if (notes.sites[k]) return false;
    notes.sites[k] = {
      url: url,
      addedAt: Date.now(),
      category: source && source.category ? source.category : null,
      finalStatus: source && source.finalStatus != null ? source.finalStatus : null,
      downReason: source && source.downReason ? source.downReason : null,
      note: ''
    };
    saveNotes(true);
    updateNotesBadge();
    return true;
  }
  function removeSiteFromNotes(url) {
    const k = notesKey(url);
    if (!notes.sites[k]) return false;
    delete notes.sites[k];
    saveNotes(true);
    updateNotesBadge();
    return true;
  }
  function setSiteNote(url, text) {
    const k = notesKey(url);
    if (!notes.sites[k]) return;
    notes.sites[k].note = String(text || '');
    saveNotes();
  }
  function updateNotesBadge() {
    const n = Object.keys(notes.sites).length;
    if (n > 0) {
      notesBadge.textContent = String(n);
      notesBadge.classList.remove('hidden');
    } else notesBadge.classList.add('hidden');
  }
  const notes = loadNotes();

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
        view: state.view,
        hideVisited: hideVisited
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
      if (typeof s.hideVisited === 'boolean') hideVisited = s.hideVisited;
      if (Array.isArray(s.results) && s.results.length) {
        state.results = s.results;
        state.elapsedMs = s.elapsedMs || 0;
        renderAll();
      }
    }
    setView(state.view);
    hideVisitedEl.checked = hideVisited;
    generalNotesEl.value = notes.general || '';
    updateUrlCount();
    updateWarning();
    updateVisitedCount();
    updateNotesBadge();
    if (Object.keys(notes.sites).length || (notes.general && notes.general.length)) {
      resultsCard.classList.remove('hidden');
      if (state.view === 'notes') renderNotes();
    }
  }

  generalNotesEl.addEventListener('input', () => {
    notes.general = generalNotesEl.value;
    saveNotes();
  });
  addSiteBtn.addEventListener('click', () => {
    let v = (addSiteInput.value || '').trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    const safe = safeHttpHref(v);
    if (!safe) {
      alert('Please enter a valid http:// or https:// URL.');
      return;
    }
    addSiteToNotes(safe, null);
    addSiteInput.value = '';
    renderNotes();
    refreshAllRowsNoteState();
  });
  addSiteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSiteBtn.click(); });
  exportNotesBtn.addEventListener('click', exportNotes);
  clearNotesBtn.addEventListener('click', () => {
    if (!Object.keys(notes.sites).length && !notes.general) return;
    if (!confirm('Clear all notes (general + saved sites)?')) return;
    notes.general = '';
    notes.sites = {};
    saveNotes(true);
    generalNotesEl.value = '';
    renderNotes();
    refreshAllRowsNoteState();
  });

  function exportNotes() {
    const lines = [];
    lines.push('# Notes export');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('');
    if (notes.general && notes.general.trim()) {
      lines.push('## General');
      lines.push(notes.general.trim());
      lines.push('');
    }
    const sites = Object.values(notes.sites).sort((a, b) => a.addedAt - b.addedAt);
    if (sites.length) {
      lines.push('## Saved sites (' + sites.length + ')');
      for (const s of sites) {
        const status = s.category ? ` [${s.category}${s.finalStatus ? ' ' + s.finalStatus : ''}]` : '';
        lines.push('- ' + s.url + status);
        if (s.downReason) lines.push('  reason: ' + s.downReason);
        if (s.note && s.note.trim()) {
          for (const ln of s.note.split('\n')) lines.push('  ' + ln);
        }
      }
    }
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'notes-' + new Date().toISOString().slice(0, 10) + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function renderNotes() {
    savedSitesCountEl.textContent = String(Object.keys(notes.sites).length);
    savedSitesListEl.innerHTML = '';
    const sites = Object.values(notes.sites).sort((a, b) => a.addedAt - b.addedAt);
    savedSitesEmptyEl.classList.toggle('hidden', sites.length > 0);
    for (const s of sites) savedSitesListEl.appendChild(buildSavedSiteCard(s));
  }

  function buildSavedSiteCard(s) {
    const card = document.createElement('div');
    card.className = 'saved-site';
    if (s.category) card.classList.add('cat-' + s.category);

    const head = document.createElement('div');
    head.className = 'saved-site-head';

    const link = document.createElement('a');
    link.className = 'saved-site-url';
    const safeHref = safeHttpHref(s.url);
    if (safeHref) {
      link.href = safeHref; link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
    link.textContent = s.url;
    head.appendChild(link);

    const meta = document.createElement('div');
    meta.className = 'saved-site-meta';
    if (s.category) {
      const badge = document.createElement('span');
      badge.className = 'pill ' + s.category;
      badge.textContent = CAT_LABEL[s.category] || s.category;
      meta.appendChild(badge);
    }
    if (s.downReason) {
      const r = document.createElement('span');
      r.className = 'reason-tag';
      r.textContent = s.downReason;
      meta.appendChild(r);
    }
    const ago = document.createElement('span');
    ago.className = 'saved-site-when';
    ago.textContent = 'Added ' + timeAgo(s.addedAt);
    meta.appendChild(ago);
    head.appendChild(meta);

    const remove = document.createElement('button');
    remove.className = 'saved-site-remove';
    remove.title = 'Remove from notes';
    remove.innerHTML = '&times;';
    remove.addEventListener('click', () => {
      removeSiteFromNotes(s.url);
      renderNotes();
      refreshAllRowsNoteState();
    });
    head.appendChild(remove);
    card.appendChild(head);

    const ta = document.createElement('textarea');
    ta.className = 'saved-site-note';
    ta.placeholder = 'Note for this site...';
    ta.value = s.note || '';
    ta.addEventListener('input', () => setSiteNote(s.url, ta.value));
    card.appendChild(ta);

    return card;
  }

  function timeAgo(ts) {
    if (!ts) return 'just now';
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + 'm ago';
    if (d < 86400) return Math.round(d / 3600) + 'h ago';
    return Math.round(d / 86400) + 'd ago';
  }

  function refreshAllRowsNoteState() {
    streamView.querySelectorAll('.note-toggle').forEach(btn => {
      const url = btn.dataset.url;
      btn.classList.toggle('on', isNoted(url));
    });
    groupedView.querySelectorAll('.note-toggle').forEach(btn => {
      const url = btn.dataset.url;
      btn.classList.toggle('on', isNoted(url));
    });
  }

  hideVisitedEl.addEventListener('change', () => {
    hideVisited = hideVisitedEl.checked;
    saveState();
    renderStream();
    renderGrouped();
  });

  const deselectAllBtn = $('deselectAllBtn');
  deselectAllBtn.addEventListener('click', () => {
    if (!visited.size) return;
    if (!confirm('Clear all visited checkmarks?')) return;
    visited.clear();
    saveVisited();
    updateVisitedCount();
    renderStream();
    renderGrouped();
  });

  function updateVisitedCount() {
    if (!state.results.length) { visitedCountEl.textContent = ''; return; }
    const n = state.results.filter(r => isVisited(r.url || r.input)).length;
    visitedCountEl.textContent = n ? `(${n}/${state.results.length})` : '';
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

  let activeAbort = null;

  checkBtn.addEventListener('click', async () => {
    if (activeAbort) { activeAbort.abort(); activeAbort = null; return; }

    const lines = parseUrlLines(urlsEl.value);
    if (!lines.length) { alert('Please enter at least one URL.'); return; }
    const { unique, dups } = dedupe(lines);
    if (dups > 0) {
      dupNotice.textContent = `Removed ${dups} duplicate URL${dups === 1 ? '' : 's'}.`;
      dupNotice.classList.remove('hidden');
    } else dupNotice.classList.add('hidden');

    state.results = [];
    state.activeFilter = null;
    state.streaming = true;
    state.total = unique.length;
    resultsCard.classList.remove('hidden');
    streamView.innerHTML = ''; groupedView.innerHTML = '';
    stackBar.innerHTML = ''; stackChips.innerHTML = '';
    setTallyText(0, unique.length);
    setProgress(0, unique.length);
    showProgressBar(true);
    if (state.view !== 'stream') setView('stream');

    setRunButton('cancel');

    const start = Date.now();
    startTimer(start);

    activeAbort = new AbortController();

    try {
      const res = await api('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: unique, ...getOpts() }),
        signal: activeAbort.signal
      });
      if (res.status === 401) {
        setAuthKey('');
        showAuthModal();
        throw new Error('Unauthorized - please re-enter your access key.');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let doneSignaled = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (e) { continue; }
          if (msg.type === 'done') doneSignaled = true;
          handleStreamMsg(msg);
        }
      }

      const elapsed = Date.now() - start;
      stopTimer();
      timerEl.textContent = formatElapsed(elapsed);
      state.elapsedMs = elapsed;
      state.streaming = false;
      showProgressBar(false);
      finalizeRender(doneSignaled);
      saveState();
    } catch (e) {
      stopTimer();
      state.streaming = false;
      showProgressBar(false);
      if (e.name !== 'AbortError') await reportCheckError(e);
    } finally {
      activeAbort = null;
      setRunButton('idle');
    }
  });

  async function reportCheckError(e) {
    console.error('Check failed', e);
    let detail = e && (e.message || e.toString()) || 'unknown error';
    let serverHint = '';
    try {
      const probe = await fetch('/api/health', { cache: 'no-store' });
      if (probe.ok) {
        serverHint = '\n\nServer is reachable.';
      } else {
        serverHint = `\n\nServer responded ${probe.status} on /api/health.`;
      }
    } catch (probeErr) {
      serverHint = `\n\nServer is unreachable. The deployment may be restarting or your network connection dropped.`;
    }
    alert('Check failed: ' + detail + serverHint);
  }

  function setRunButton(mode) {
    const labelEl = checkBtn.querySelector('.run-label');
    const arrowEl = checkBtn.querySelector('.run-arrow');
    if (mode === 'cancel') {
      labelEl.textContent = 'Cancel';
      arrowEl.textContent = '×';
      checkBtn.classList.add('cancel');
    } else {
      labelEl.textContent = 'Run Check';
      arrowEl.textContent = '→';
      checkBtn.classList.remove('cancel');
    }
  }

  function handleStreamMsg(msg) {
    if (msg.type === 'start') {
      state.total = msg.total;
      setTallyText(0, msg.total);
      setProgress(0, msg.total);
    } else if (msg.type === 'ping') {
      // server keepalive; nothing to do
    } else if (msg.type === 'result') {
      const r = msg.result;
      r._index = msg.index;
      state.results.push(r);
      setTallyText(msg.completed, msg.total);
      setProgress(msg.completed, msg.total);
      if (matchesFilter(r)) {
        const row = buildRow(r);
        row.classList.add('row-enter');
        streamView.appendChild(row);
        requestAnimationFrame(() => row.classList.add('row-enter-active'));
      }
    } else if (msg.type === 'done') {
      if (Array.isArray(msg.uniqueIndexes) && msg.uniqueIndexes.length) {
        const set = new Set(msg.uniqueIndexes);
        for (const r of state.results) {
          if (set.has(r._index)) r.uniqueRedirect = true;
        }
      }
    } else if (msg.type === 'error') {
      console.error('stream error', msg.error);
    }
  }

  function finalizeRender(_doneSignaled) {
    state.results.sort((a, b) => (a._index ?? 0) - (b._index ?? 0));
    renderAll();
  }

  function setTallyText(done, total) {
    if (state.streaming && total) {
      checkedCountEl.innerHTML = `${done}<span class="of">/${total}</span>`;
    } else {
      checkedCountEl.textContent = String(done || 0);
    }
  }
  function setProgress(done, total) {
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressLabel.textContent = total ? `${done} of ${total}` : '';
  }
  function showProgressBar(on) {
    progressBar.classList.toggle('hidden', !on);
  }

  cleanBtn.addEventListener('click', () => {
    const before = urlsEl.value || '';
    const beforeLineCount = before.split(/\r?\n/).filter(s => s.trim().length).length;
    const urls = extractUrls(before);
    if (!urls.length) {
      dupNotice.textContent = 'No URLs found in the pasted text.';
      dupNotice.classList.remove('hidden');
      return;
    }
    urlsEl.value = urls.join('\n');
    updateUrlCount();
    updateWarning();
    saveState();
    const noise = Math.max(0, beforeLineCount - urls.length);
    dupNotice.textContent = `Extracted ${urls.length} URL${urls.length === 1 ? '' : 's'}` +
      (noise > 0 ? ` (cleaned ${noise} non-URL line${noise === 1 ? '' : 's'}).` : '.');
    dupNotice.classList.remove('hidden');
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all URLs, results, settings, and visited progress?')) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(VISITED_KEY);
    visited.clear();
    urlsEl.value = '';
    optRedirects.checked = true; optVar.checked = false;
    optUnique.checked = false; optAdvanced.checked = false;
    hideVisited = false; hideVisitedEl.checked = false;
    timerEl.textContent = '0.0s';
    checkedCountEl.textContent = '0';
    dupNotice.classList.add('hidden'); warningEl.classList.add('hidden');
    resultsCard.classList.add('hidden');
    streamView.innerHTML = ''; groupedView.innerHTML = '';
    stackBar.innerHTML = ''; stackChips.innerHTML = '';
    state.results = []; state.elapsedMs = 0; state.activeFilter = null;
    updateUrlCount();
    updateVisitedCount();
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
    notesView.classList.toggle('hidden', v !== 'notes');
    if (v === 'notes') renderNotes();
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
    updateVisitedCount();
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
    if (hideVisited && isVisited(r.url || r.input)) return false;
    if (!state.activeFilter) return true;
    if (state.activeFilter === 'unique') return !!r.uniqueRedirect;
    return r.category === state.activeFilter;
  }

  const CHECK_SVG = '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function makeVisitToggle(url, onChange) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'visit-toggle';
    btn.setAttribute('aria-label', 'Mark as visited');
    btn.title = 'Mark as visited';
    updateVisitToggle(btn, isVisited(url));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !isVisited(url);
      markVisited(url, next);
      updateVisitToggle(btn, next);
      if (typeof onChange === 'function') onChange();
    });
    return btn;
  }
  function updateVisitToggle(btn, on) {
    btn.classList.toggle('on', !!on);
    btn.innerHTML = on ? CHECK_SVG : '';
    btn.title = on ? 'Mark as not visited' : 'Mark as visited';
  }

  const BOOKMARK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 1.5h9a1 1 0 0 1 1 1V14a.5.5 0 0 1-.78.42L8 11.06l-4.72 3.36A.5.5 0 0 1 2.5 14V2.5a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';

  function makeNoteToggle(result) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'note-toggle';
    const url = result.url || result.input;
    btn.dataset.url = url;
    btn.innerHTML = BOOKMARK_SVG;
    btn.title = isNoted(url) ? 'Remove from notes' : 'Add to notes';
    if (isNoted(url)) btn.classList.add('on');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoted(url)) removeSiteFromNotes(url);
      else addSiteToNotes(url, result);
      btn.classList.toggle('on', isNoted(url));
      btn.title = isNoted(url) ? 'Remove from notes' : 'Add to notes';
      if (state.view === 'notes') renderNotes();
    });
    return btn;
  }

  function updateGroupHeaderCounts() {
    const heads = groupedView.querySelectorAll('.group-card');
    heads.forEach(card => {
      const cat = card.dataset.cat;
      const items = state.results.filter(r =>
        cat === 'unique' ? !!r.uniqueRedirect : r.category === cat
      );
      const done = items.filter(r => isVisited(r.url || r.input)).length;
      const counter = card.querySelector('.gcount');
      if (counter) counter.textContent = done ? `${items.length} · ${done} done` : String(items.length);
    });
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
    const url = r.url || r.input;
    if (isVisited(url)) row.classList.add('visited');

    const bar = document.createElement('div'); bar.className = 'bar';
    row.appendChild(bar);

    const body = document.createElement('div'); body.className = 'body';

    const urlLine = document.createElement('div');
    urlLine.className = 'url-line';

    const toggle = makeVisitToggle(url, () => {
      row.classList.toggle('visited', isVisited(url));
      updateVisitedCount();
      if (hideVisited) renderStream();
      // refresh group counters in case grouped view is open later
      updateGroupHeaderCounts();
    });
    urlLine.appendChild(toggle);

    const a = document.createElement('a');
    const aHref = safeHttpHref(url);
    if (aHref) { a.href = aHref; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = url;
    a.addEventListener('click', () => {
      if (!isVisited(url)) {
        markVisited(url, true);
        row.classList.add('visited');
        updateVisitToggle(toggle, true);
        updateVisitedCount();
        updateGroupHeaderCounts();
      }
    });
    urlLine.appendChild(a);
    if (r.uniqueRedirect) {
      const u = document.createElement('span'); u.className = 'uniq-badge'; u.textContent = 'UNIQUE';
      urlLine.appendChild(u);
    }
    urlLine.appendChild(makeNoteToggle(r));
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
        const vbHref = safeHttpHref(v.url);
        if (vbHref) { vb.href = vbHref; vb.target = '_blank'; vb.rel = 'noopener noreferrer'; }
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
    if (r.downReason && !isGenericReason(r.downReason)) {
      out.push(` <span class="reason-tag">${escapeHtml(r.downReason)}</span>`);
    }
    if (r.finalUrl && r.finalUrl !== r.url) {
      const suffix = r.finalStatus ? ` (${r.finalStatus})` : '';
      const safeFinal = safeHttpHref(r.finalUrl);
      if (safeFinal) {
        out.push(`<br/><span class="arr">&rarr;</span><a href="${escapeAttr(safeFinal)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.finalUrl)}</a>${suffix}`);
      } else {
        out.push(`<br/><span class="arr">&rarr;</span>${escapeHtml(r.finalUrl)}${suffix}`);
      }
    }
    return out.join('');
  }
  function isGenericReason(reason) {
    if (!reason) return true;
    return /^HTTP \d{3}$/i.test(reason) || reason === 'No response' || reason === 'Connection failed' || reason === 'Network unreachable';
  }

  function shortVariant(u) {
    try {
      const p = new URL(u);
      const proto = p.protocol === 'https:' ? 'https' : 'http';
      const www = p.host.toLowerCase().startsWith('www.') ? 'www' : '@';
      return `${proto}/${www}`;
    } catch (e) { return u; }
  }

  // Distinct from the category palette: amber, pink, sky, lime, salmon, cyan, magenta, slate.
  const CLUSTER_PALETTE = ['#fbbf24', '#f472b6', '#60a5fa', '#a3e635', '#fb923c', '#22d3ee', '#e879f9', '#94a3b8'];
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  // Pre-pass: which final destinations appear more than once in this group.
  // Only multi-row clusters get a color so single redirects stay clutter-free.
  function computeClusterColors(items) {
    const counts = new Map();
    for (const r of items) {
      if (!r || !r.redirected || !r.finalUrl) continue;
      const k = visitedKey(r.finalUrl);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const colors = new Map();
    for (const [k, n] of counts) {
      if (n > 1) colors.set(k, CLUSTER_PALETTE[hashStr(k) % CLUSTER_PALETTE.length]);
    }
    return colors;
  }

  const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function formatGroupRowDetail(r, clusterColor) {
    const parts = [];
    parts.push('<div class="dt-chain">');
    parts.push(`HTTP ${r.firstStatus || 0}`);
    if (r.chain && r.chain.length) {
      for (const hop of r.chain) {
        parts.push(`<span class="dt-arr">&rarr;</span>${hop && hop.status ? hop.status : 'redirect'}`);
      }
    }
    if (r.finalStatus && r.finalStatus !== r.firstStatus) {
      const cf = r.cloudflareSeen ? ' <span class="dt-cf">(Cloudflare)</span>' : '';
      parts.push(`<span class="dt-arr">&rarr;</span>HTTP ${r.finalStatus}${cf}`);
    } else if (r.cloudflareSeen && r.firstStatus === r.finalStatus) {
      parts.push(' <span class="dt-cf">(Cloudflare)</span>');
    }
    if (r.timingMs != null) parts.push(`<span class="dt-ms"> &middot; ${r.timingMs}ms</span>`);
    parts.push('</div>');

    if (r.finalUrl && r.finalUrl !== r.url) {
      const safe = safeHttpHref(r.finalUrl);
      const dot = clusterColor ? `<span class="cluster-dot" style="background:${clusterColor}"></span>` : '';
      if (safe) {
        parts.push(`<div class="dt-final">${dot}<span class="dt-label">Final:</span> <a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.finalUrl)}</a></div>`);
      } else {
        parts.push(`<div class="dt-final">${dot}<span class="dt-label">Final:</span> ${escapeHtml(r.finalUrl)}</div>`);
      }
    }
    if (r.downReason && !isGenericReason(r.downReason)) {
      parts.push(`<div class="dt-reason">${escapeHtml(r.downReason)}</div>`);
    }
    return parts.join('');
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

    const doneCount = () => items.filter(r => isVisited(r.url || r.input)).length;

    const head = document.createElement('div');
    head.className = 'group-head';
    const initialDone = doneCount();
    head.innerHTML = `<div class="group-title"><span class="gdot"></span>${cat.label}<span class="gcount">${initialDone ? `${items.length} · ${initialDone} done` : items.length}</span></div>`;

    const actions = document.createElement('div');
    actions.className = 'group-actions';

    const copyAll = document.createElement('button');
    copyAll.className = 'copy-btn';
    copyAll.textContent = 'Copy';
    copyAll.addEventListener('click', () => copyList(copyAll, items.map(i => i.url || i.input), 'Copy'));
    actions.appendChild(copyAll);

    const copyLeft = document.createElement('button');
    copyLeft.className = 'copy-btn copy-left';
    copyLeft.textContent = 'Copy left';
    copyLeft.title = 'Copy URLs not yet marked visited';
    const refreshCopyLeft = () => {
      const left = items.filter(r => !isVisited(r.url || r.input));
      copyLeft.classList.toggle('hidden', left.length === 0 || left.length === items.length);
    };
    copyLeft.addEventListener('click', () => {
      const left = items.filter(r => !isVisited(r.url || r.input)).map(i => i.url || i.input);
      copyList(copyLeft, left, 'Copy left');
    });
    actions.appendChild(copyLeft);
    refreshCopyLeft();

    head.appendChild(actions);
    card.appendChild(head);

    const clusterColors = computeClusterColors(items);

    const rows = document.createElement('div'); rows.className = 'group-rows';
    for (const r of items) {
      const url = r.url || r.input;
      const wrap = document.createElement('div');
      wrap.className = 'group-row-wrap';
      if (isVisited(url)) wrap.classList.add('visited');

      const rowEl = document.createElement('div');
      rowEl.className = 'group-row';

      const toggle = makeVisitToggle(url, () => {
        wrap.classList.toggle('visited', isVisited(url));
        const counter = card.querySelector('.gcount');
        const d = doneCount();
        if (counter) counter.textContent = d ? `${items.length} · ${d} done` : String(items.length);
        refreshCopyLeft();
        updateVisitedCount();
        if (hideVisited) wrap.classList.toggle('hidden', isVisited(url));
      });
      rowEl.appendChild(toggle);

      const clusterKey = (r.redirected && r.finalUrl) ? visitedKey(r.finalUrl) : null;
      const clusterColor = clusterKey ? clusterColors.get(clusterKey) : null;
      if (clusterColor) {
        const dot = document.createElement('span');
        dot.className = 'cluster-dot';
        dot.style.background = clusterColor;
        dot.title = 'Same redirect destination as other rows in this group';
        rowEl.appendChild(dot);
      }

      const a = document.createElement('a');
      a.className = 'group-link';
      const aHref = safeHttpHref(url);
      if (aHref) { a.href = aHref; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.textContent = url;
      a.addEventListener('click', () => {
        if (!isVisited(url)) {
          markVisited(url, true);
          wrap.classList.add('visited');
          updateVisitToggle(toggle, true);
          const counter = card.querySelector('.gcount');
          const d = doneCount();
          if (counter) counter.textContent = d ? `${items.length} · ${d} done` : String(items.length);
          refreshCopyLeft();
          updateVisitedCount();
          if (hideVisited) wrap.classList.add('hidden');
        }
      });
      rowEl.appendChild(a);
      rowEl.appendChild(makeNoteToggle(r));

      const hasDetail = (r.redirected && (r.chain && r.chain.length))
        || (r.finalUrl && r.finalUrl !== r.url)
        || (r.downReason && !isGenericReason(r.downReason))
        || r.cloudflareSeen;

      if (hasDetail) {
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'expand-toggle';
        expand.setAttribute('aria-label', 'Show redirect details');
        expand.setAttribute('aria-expanded', 'false');
        expand.title = 'Show redirect details';
        expand.innerHTML = CHEVRON_SVG;
        const detail = document.createElement('div');
        detail.className = 'group-row-detail hidden';
        detail.innerHTML = formatGroupRowDetail(r, clusterColor);
        expand.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const open = detail.classList.toggle('hidden') === false;
          expand.classList.toggle('open', open);
          expand.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        rowEl.appendChild(expand);
        wrap.appendChild(rowEl);
        wrap.appendChild(detail);
      } else {
        wrap.appendChild(rowEl);
      }

      if (hideVisited && isVisited(url)) wrap.classList.add('hidden');
      rows.appendChild(wrap);
    }
    card.appendChild(rows);
    return card;
  }

  async function copyList(btn, urls, baseLabel) {
    if (!urls.length) { return; }
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
      btn.classList.add('copied'); btn.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = baseLabel; }, 1300);
    } catch (e) { alert('Copy failed'); }
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

  // =========================================================================
  // Auth modal wiring
  // =========================================================================
  const authModal = $('authModal');
  const authKeyInput = $('authKeyInput');
  const authKeySubmit = $('authKeySubmit');
  const authKeyErr = $('authKeyErr');

  function showAuthModal() {
    authKeyErr.classList.add('hidden');
    authModal.classList.remove('hidden');
    setTimeout(() => authKeyInput.focus(), 50);
  }
  function hideAuthModal() { authModal.classList.add('hidden'); }

  async function bootstrapAuth() {
    let required = false;
    let misconfigured = false;
    try {
      const r = await fetch('/api/auth-required', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        required = !!j.required;
        misconfigured = !!j.misconfigured;
      }
    } catch (e) { /* network down - leave required=false so init still runs */ }
    if (misconfigured) {
      // Surface a clear admin-side message; no point letting the user try.
      const head = document.querySelector('#authModal .modal-head h3');
      const body = document.querySelector('#authModal .modal-body');
      if (head) head.textContent = 'Server not yet configured';
      if (body) body.innerHTML = '<p>The deployment is running but the administrator has not set the <code>CHECKER_KEY</code> environment variable.</p><p class="muted">All API calls will return 503 until this is configured. Set <code>CHECKER_KEY</code> to a 16+ character random string in your hosting platform and redeploy.</p>';
      showAuthModal();
      return;
    }
    if (!required) { hideAuthModal(); return; }

    const existing = getAuthKey();
    if (existing) {
      // Verify the stored key.
      try {
        const r = await fetch('/api/auth-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-checker-key': existing }
        });
        if (r.ok) { hideAuthModal(); return; }
      } catch (e) { /* ignore */ }
      setAuthKey('');
    }
    showAuthModal();
  }

  authKeySubmit.addEventListener('click', async () => {
    const v = (authKeyInput.value || '').trim();
    if (!v) return;
    authKeySubmit.disabled = true;
    try {
      const r = await fetch('/api/auth-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-checker-key': v }
      });
      if (r.ok) {
        setAuthKey(v);
        authKeyInput.value = '';
        authKeyErr.classList.add('hidden');
        hideAuthModal();
      } else {
        authKeyErr.classList.remove('hidden');
      }
    } catch (e) {
      authKeyErr.textContent = 'Network error - try again.';
      authKeyErr.classList.remove('hidden');
    } finally {
      authKeySubmit.disabled = false;
    }
  });
  authKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') authKeySubmit.click(); });

  init();
  bootstrapAuth();
})();
