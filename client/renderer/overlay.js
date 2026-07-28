const $ = (s) => document.querySelector(s);
const ov = window.overlay;

let st = null; // { game, user, keys, shots }
let viewer = { idx: -1 };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtWhen(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtElapsed(started) {
  const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Seed from the load URL so the timer is correct on first paint (before IPC).
const bootStarted = Number(new URLSearchParams(location.search).get('started')) || 0;

function tickChrome() {
  const started = st?.game?.started || bootStarted;
  if (started) $('#ov-timer').textContent = fmtElapsed(started);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#ov-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
  $('#ov-date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- panes
function selectPane(which) {
  $('#tb-browser').classList.toggle('active', which === 'browser');
  $('#tb-shots').classList.toggle('active', which === 'shots');
  $('#pane-browser').classList.toggle('hidden', which !== 'browser');
  $('#pane-shots').classList.toggle('hidden', which !== 'shots');
  if (which === 'shots') renderShots();
}
$('#tb-browser').onclick = () => selectPane('browser');
$('#tb-shots').onclick = () => selectPane('shots');
$('#tb-close').onclick = () => ov.close();

// ---------------------------------------------------------------- browser
const web = $('#ov-web');
const urlBox = $('#bb-url');
const suggestBox = $('#bb-suggest');
const bookmarksPanel = $('#bb-bookmarks-panel');
const starBtn = $('#bb-star');
let suggestItems = [];
let suggestIdx = -1;
let suggestTimer = null;
let pageTitle = '';

function hideSuggest() {
  suggestBox.classList.add('hidden');
  suggestBox.innerHTML = '';
  suggestItems = [];
  suggestIdx = -1;
}

function renderSuggest() {
  if (!suggestItems.length) { hideSuggest(); return; }
  suggestBox.innerHTML = suggestItems.map((item, i) => {
    const kind = item.kind === 'search' ? 'Search' : item.kind === 'bookmark' ? 'Bookmark' : 'History';
    const title = item.kind === 'search' ? item.q : (item.title || item.url);
    const sub = item.kind === 'search' ? 'Google search' : item.url;
    return `<button type="button" class="ov-suggest-item${i === suggestIdx ? ' active' : ''}" data-idx="${i}" role="option">
      <span class="ov-suggest-kind">${esc(kind)}</span>
      <span class="ov-suggest-main">
        <div class="ov-suggest-title">${esc(title)}</div>
        <div class="ov-suggest-sub">${esc(sub)}</div>
      </span>
    </button>`;
  }).join('');
  suggestBox.classList.remove('hidden');
  suggestBox.querySelectorAll('.ov-suggest-item').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); chooseSuggest(parseInt(el.dataset.idx, 10)); };
  });
}

async function refreshSuggest(query) {
  try {
    suggestItems = await ov.suggest(query || '');
    suggestIdx = suggestItems.length ? 0 : -1;
    renderSuggest();
  } catch {
    hideSuggest();
  }
}

function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => refreshSuggest(urlBox.value), 80);
}

async function navigateTo(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  hideSuggest();
  bookmarksPanel.classList.add('hidden');
  urlBox.value = url;
  try {
    await web.loadURL(url);
  } catch (err) {
    console.warn('[overlay-browser] loadURL failed:', err?.message || err);
  }
}

async function goOmnibox(raw) {
  const input = (raw ?? urlBox.value).trim();
  if (!input) return;
  // Prefer main-process resolve (keeps Steam's "must open google.com first" bug dead).
  let resolved = null;
  try { resolved = await ov.resolveOmnibox(input); } catch { /* */ }
  if (!resolved?.url) {
    // local fallback identical to main helper
    if (/^https?:\/\//i.test(input)) resolved = { kind: 'url', url: input };
    else if (/\s/.test(input) || !/\./.test(input)) {
      resolved = { kind: 'search', url: `https://www.google.com/search?q=${encodeURIComponent(input)}`, query: input };
    } else {
      resolved = { kind: 'url', url: `https://${input}` };
    }
  }
  if (resolved.kind === 'search' && resolved.query) {
    try { await ov.recordSearch(resolved.query); } catch { /* */ }
  }
  await navigateTo(resolved.url);
}

function chooseSuggest(idx) {
  const item = suggestItems[idx];
  if (!item) return;
  if (item.kind === 'search') {
    urlBox.value = item.q;
    goOmnibox(item.q);
  } else {
    navigateTo(item.url);
  }
}

function syncNavButtons() {
  try {
    $('#bb-back').disabled = !web.canGoBack();
    $('#bb-fwd').disabled = !web.canGoForward();
  } catch {
    $('#bb-back').disabled = true;
    $('#bb-fwd').disabled = true;
  }
}

async function syncStar() {
  let url = '';
  try { url = web.getURL(); } catch { /* */ }
  if (!url || !/^https?:\/\//i.test(url)) {
    starBtn.classList.remove('starred');
    starBtn.textContent = '☆';
    starBtn.setAttribute('aria-pressed', 'false');
    starBtn.title = 'Bookmark this page';
    return;
  }
  const on = await ov.isBookmarked(url).catch(() => false);
  starBtn.classList.toggle('starred', !!on);
  starBtn.textContent = on ? '★' : '☆';
  starBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  starBtn.title = on ? 'Remove bookmark' : 'Bookmark this page';
}

async function renderBookmarksPanel() {
  const list = await ov.bookmarks().catch(() => []);
  if (!list.length) {
    bookmarksPanel.innerHTML = '<div class="ov-bm-empty">No bookmarks yet — hit ★ on a page you like.</div>';
    return;
  }
  bookmarksPanel.innerHTML = list.map((b) => `
    <div class="ov-bm-chip" data-url="${esc(b.url)}" title="${esc(b.url)}">
      <span data-nav="1">${esc(b.title || b.url)}</span>
      <button type="button" class="x" data-id="${esc(b.id)}" title="Remove">×</button>
    </div>`).join('');
  bookmarksPanel.querySelectorAll('.ov-bm-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const btn = e.target.closest('.x');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        ov.removeBookmark(btn.dataset.id).then(() => { renderBookmarksPanel(); syncStar(); });
        return;
      }
      navigateTo(chip.dataset.url);
    });
  });
}

async function onNavigated(url) {
  if (!url || url === 'about:blank') return;
  urlBox.value = url;
  syncNavButtons();
  try {
    await ov.recordVisit({ url, title: pageTitle || '' });
  } catch { /* */ }
  syncStar();
}

$('#bb-go').onclick = () => goOmnibox();
urlBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (suggestIdx >= 0 && suggestItems[suggestIdx] && !suggestBox.classList.contains('hidden')) {
      chooseSuggest(suggestIdx);
    } else {
      goOmnibox();
    }
    return;
  }
  if (e.key === 'Escape') {
    hideSuggest();
    urlBox.blur();
    return;
  }
  if (e.key === 'ArrowDown' && suggestItems.length) {
    e.preventDefault();
    suggestIdx = (suggestIdx + 1) % suggestItems.length;
    renderSuggest();
    return;
  }
  if (e.key === 'ArrowUp' && suggestItems.length) {
    e.preventDefault();
    suggestIdx = (suggestIdx - 1 + suggestItems.length) % suggestItems.length;
    renderSuggest();
  }
});
urlBox.addEventListener('input', scheduleSuggest);
urlBox.addEventListener('focus', () => refreshSuggest(urlBox.value));
urlBox.addEventListener('blur', () => { setTimeout(hideSuggest, 120); });

$('#bb-back').onclick = () => { try { if (web.canGoBack()) web.goBack(); } catch { /* */ } };
$('#bb-fwd').onclick = () => { try { if (web.canGoForward()) web.goForward(); } catch { /* */ } };
$('#bb-reload').onclick = () => { try { web.reload(); } catch { /* */ } };
$('#bb-external').onclick = () => {
  let u = '';
  try { u = web.getURL(); } catch { /* */ }
  if (/^https?:\/\//i.test(u)) ov.openExternal(u);
};
starBtn.onclick = async () => {
  let url = '';
  try { url = web.getURL(); } catch { /* */ }
  if (!/^https?:\/\//i.test(url)) return;
  const on = await ov.isBookmarked(url).catch(() => false);
  if (on) await ov.removeBookmark(url);
  else await ov.addBookmark({ url, title: pageTitle || url });
  await syncStar();
  if (!bookmarksPanel.classList.contains('hidden')) renderBookmarksPanel();
};
$('#bb-bookmarks').onclick = async () => {
  bookmarksPanel.classList.toggle('hidden');
  if (!bookmarksPanel.classList.contains('hidden')) await renderBookmarksPanel();
};

web.addEventListener('dom-ready', () => syncNavButtons());
web.addEventListener('did-navigate', (e) => { pageTitle = ''; onNavigated(e.url); });
web.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigated(e.url); });
web.addEventListener('page-title-updated', (e) => {
  pageTitle = e.title || '';
  let url = '';
  try { url = web.getURL(); } catch { /* */ }
  if (url && /^https?:\/\//i.test(url)) ov.recordVisit({ url, title: pageTitle }).catch(() => {});
});
web.addEventListener('did-fail-load', (e) => {
  if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted
  console.warn('[overlay-browser] fail-load', e.errorDescription, e.validatedURL);
});
web.addEventListener('new-window', (e) => { // target=_blank opens inside the guest
  e.preventDefault();
  if (/^https?:\/\//i.test(e.url)) navigateTo(e.url);
});

async function bootBrowser() {
  const profile = await ov.browserProfile().catch(() => null);
  const start = profile?.lastUrl || 'https://www.google.com/';
  urlBox.value = start;
  await navigateTo(start);
  syncStar();
}
bootBrowser();

// ---------------------------------------------------------------- shots
function renderShots() {
  const grid = $('#shots-grid');
  const list = st?.shots || [];
  $('#shots-title').textContent = st?.game ? `${st.game.title} — screenshots` : 'Screenshots';
  const count = $('#shot-count');
  count.textContent = list.length;
  count.classList.toggle('hidden', list.length === 0);
  $('#shots-empty').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = list.map((s, i) => `
    <button class="ov-shot" data-idx="${i}">
      <img src="${esc(s.url)}" loading="lazy" alt="" />
      <span class="when">${esc(fmtWhen(s.at))}</span>
    </button>`).join('');
  grid.querySelectorAll('.ov-shot').forEach((el) => {
    el.onclick = () => openViewer(parseInt(el.dataset.idx, 10));
  });
}

async function refresh() {
  st = await ov.getState();
  if (!st.game) { ov.close(); return; } // game exited while open — nothing to overlay
  $('#ov-game-title').textContent = st.game.title;
  $('#ov-name').textContent = st.user.name;
  const av = $('#ov-avatar');
  av.innerHTML = st.user.avatar ? `<img src="${esc(st.user.avatar)}" alt="" />` : esc((st.user.name || '?').slice(0, 1));
  $('#hint-close').innerHTML = `<b>${esc(st.keys.overlay)}</b> — back to game`;
  $('#shot-key-hint').textContent = st.keys.screenshot;
  // Capture toolbar slot is reserved for a future action — keep greyed out.
  $('#tb-capture').disabled = true;
  $('#tb-capture').title = 'Coming soon';
  $('#shots-capture').disabled = true;
  $('#shots-capture').title = 'Coming soon';
  tickChrome(); // sync timer immediately — never flash 0:00 after state lands
  renderShots();
}

$('#shots-refresh').onclick = refresh;

$('#tb-quit').onclick = async () => { await ov.exitGame(); };

// a hotkey capture landed while the overlay was open — slot it in live
ov.onShot((entry) => {
  if (!entry || !st) return;
  st.shots = [entry, ...(st.shots || []).filter((s) => s.file !== entry.file)];
  renderShots();
});

// ---------------------------------------------------------------- viewer
function openViewer(idx) {
  const list = st?.shots || [];
  if (!list.length) return;
  viewer.idx = Math.max(0, Math.min(idx, list.length - 1));
  renderViewer();
  $('#viewer').classList.remove('hidden');
}
function renderViewer() {
  const list = st?.shots || [];
  const s = list[viewer.idx];
  if (!s) { closeViewer(); return; }
  $('#viewer-img').src = s.url;
  $('#viewer-meta').textContent = `${fmtWhen(s.at)} — ${viewer.idx + 1} / ${list.length}`;
  $('#viewer-prev').classList.toggle('hidden', list.length < 2);
  $('#viewer-next').classList.toggle('hidden', list.length < 2);
}
function closeViewer() { $('#viewer').classList.add('hidden'); viewer.idx = -1; }
$('#viewer-close').onclick = closeViewer;
$('#viewer-prev').onclick = () => { viewer.idx = (viewer.idx - 1 + st.shots.length) % st.shots.length; renderViewer(); };
$('#viewer-next').onclick = () => { viewer.idx = (viewer.idx + 1) % st.shots.length; renderViewer(); };
$('#viewer-delete').onclick = async () => {
  const s = st?.shots?.[viewer.idx];
  if (!s) return;
  const ok = await ov.deleteShot(s.file);
  if (ok) {
    st.shots = st.shots.filter((x) => x.file !== s.file);
    renderShots();
    if (!st.shots.length) closeViewer();
    else { viewer.idx = Math.min(viewer.idx, st.shots.length - 1); renderViewer(); }
  }
};
// Click the dimmed dead space around the shot to leave the viewer (X still works).
$('#viewer').addEventListener('click', (ev) => {
  if (ev.target.closest('#viewer-img, #viewer-close, #viewer-prev, #viewer-next, .ov-viewer-bar, button')) return;
  closeViewer();
});

// ---------------------------------------------------------------- chrome
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#viewer').classList.contains('hidden')) closeViewer();
    else if (!suggestBox.classList.contains('hidden')) hideSuggest();
    else if (!bookmarksPanel.classList.contains('hidden')) bookmarksPanel.classList.add('hidden');
    else if (document.activeElement === urlBox) urlBox.blur();
    else ov.close();
  }
  if (!$('#viewer').classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') $('#viewer-prev').click();
    if (e.key === 'ArrowRight') $('#viewer-next').click();
  }
});

tickChrome(); // first paint uses ?started= from main — no 0:00 flash
setInterval(tickChrome, 1000);

selectPane('browser'); // every open starts on the browser, like Steam
refresh();
