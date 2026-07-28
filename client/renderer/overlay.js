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
let activePane = null; // 'browser' | 'shots' | null — nothing open by default
let browserProfile = null;
let browserHome = null; // local dark new-tab (file://…/browser-home.html)
let tabs = [];
let activeTabId = null;
let layoutSaveTimer = null;

function isHomeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (browserHome && url === browserHome) return true;
  if (/browser-home\.html(?:[?#]|$)/i.test(url)) return true;
  return /^https?:\/\/(www\.)?google\.[a-z.]+\/?$/i.test(url);
}

function displayUrl(url) {
  return isHomeUrl(url) ? '' : (url || '');
}

function scheduleSaveLayout() {
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(persistLayout, 200);
}

function persistLayout() {
  const panel = $('#pane-browser');
  const open = !panel.classList.contains('hidden');
  const bounds = {
    x: parseInt(panel.style.left, 10) || 0,
    y: parseInt(panel.style.top, 10) || 0,
    w: parseInt(panel.style.width, 10) || panel.offsetWidth,
    h: parseInt(panel.style.height, 10) || panel.offsetHeight,
  };
  // Keep live tab URL in sync before save
  try {
    const u = web.getURL();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab && (/^https?:\/\//i.test(u) || isHomeUrl(u))) {
      tab.url = isHomeUrl(u) ? (browserHome || u) : u;
    }
  } catch { /* */ }
  ov.saveLayout({
    browserOpen: open,
    bounds,
    tabs,
    activeTabId,
  }).catch(() => {});
}

function closeShotsPanel() {
  $('#pane-shots').classList.add('hidden');
  $('#tb-shots').classList.remove('active');
  if (activePane === 'shots') activePane = null;
}

function selectPane(which) {
  if (which === 'browser') {
    const opening = $('#pane-browser').classList.contains('hidden');
    if (opening) openBrowserPanel();
    else closeBrowserPanel();
    return;
  }
  if (which === 'shots') {
    const opening = $('#pane-shots').classList.contains('hidden');
    if (!opening) {
      closeShotsPanel();
      return;
    }
    activePane = 'shots';
    $('#tb-browser').classList.toggle('active', !$('#pane-browser').classList.contains('hidden'));
    $('#tb-shots').classList.add('active');
    $('#pane-shots').classList.remove('hidden');
    renderShots();
    return;
  }
  activePane = which;
  $('#tb-browser').classList.toggle('active', !$('#pane-browser').classList.contains('hidden'));
  $('#tb-shots').classList.toggle('active', which === 'shots');
  $('#pane-shots').classList.toggle('hidden', which !== 'shots');
}
$('#tb-browser').onclick = () => selectPane('browser');
$('#tb-shots').onclick = () => selectPane('shots');
$('#tb-close').onclick = () => { persistLayout(); ov.close(); };

function applyBrowserBounds(bounds) {
  const panel = $('#pane-browser');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(bounds?.w || 980, 420), vw - 24);
  const h = Math.min(Math.max(bounds?.h || 640, 280), vh - 24);
  let x = bounds?.x;
  let y = bounds?.y;
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    x = Math.round((vw - w) / 2);
    y = Math.round((vh - h) / 2 * 0.7);
  }
  x = Math.min(Math.max(8, x), vw - 80);
  y = Math.min(Math.max(8, y), vh - 80);
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.width = `${w}px`;
  panel.style.height = `${h}px`;
}

function openBrowserPanel() {
  const panel = $('#pane-browser');
  panel.classList.remove('hidden');
  $('#tb-browser').classList.add('active');
  activePane = 'browser';
  applyBrowserBounds(browserProfile?.bounds);
  scheduleRelayoutWeb();
  // If still on blank, navigate to active tab
  try {
    const cur = web.getURL();
    if (!cur || cur === 'about:blank') {
      const tab = tabs.find((t) => t.id === activeTabId) || tabs[0];
      if (tab) navigateTo(tab.url);
    }
  } catch {
    const tab = tabs.find((t) => t.id === activeTabId) || tabs[0];
    if (tab) navigateTo(tab.url);
  }
  scheduleSaveLayout();
}

function closeBrowserPanel() {
  persistLayout();
  $('#pane-browser').classList.add('hidden');
  $('#tb-browser').classList.remove('active');
  if (activePane === 'browser') activePane = null;
  ov.saveLayout({ browserOpen: false, tabs, activeTabId }).catch(() => {});
}

// ---------------------------------------------------------------- browser
const web = $('#ov-web');
const webHost = $('.ov-web-host');
const urlBox = $('#bb-url');
const suggestBox = $('#bb-suggest');
const bookmarksPanel = $('#bb-bookmarks-panel');
const starBtn = $('#bb-star');
let suggestItems = [];
let suggestIdx = -1;
let suggestTimer = null;
let pageTitle = '';

// Pixel-size the guest to its host. Flex/% sizing alone is unreliable for
// <webview> in a transparent always-on-top window and clips the page top.
function relayoutWeb() {
  if (!web || !webHost) return;
  const r = webHost.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  web.style.width = `${w}px`;
  web.style.height = `${h}px`;
}
let relayoutTimer = null;
function scheduleRelayoutWeb() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutWeb, 16);
}
window.addEventListener('resize', scheduleRelayoutWeb);

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
  if (!url) return;
  // Home is a local file:// page; everything else must be http(s).
  if (!isHomeUrl(url) && !/^https?:\/\//i.test(url)) return;
  hideSuggest();
  bookmarksPanel.classList.add('hidden');
  urlBox.value = displayUrl(url);
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
  urlBox.value = displayUrl(url);
  syncNavButtons();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) {
    tab.url = isHomeUrl(url) ? (browserHome || url) : url;
    if (isHomeUrl(url)) tab.title = 'New Tab';
  }
  try {
    if (!isHomeUrl(url)) await ov.recordVisit({ url, title: pageTitle || '' });
  } catch { /* */ }
  syncStar();
  renderTabs();
  scheduleSaveLayout();
}

function renderTabs() {
  const host = $('#bb-tabs');
  if (!host) return;
  host.innerHTML = tabs.map((t) => `
    <button type="button" class="ov-tab${t.id === activeTabId ? ' active' : ''}" data-id="${esc(t.id)}" title="${esc(t.url)}">
      <span>${esc(t.title || t.url || 'Tab')}</span>
      <span class="x" data-close="${esc(t.id)}" title="Close tab">×</span>
    </button>`).join('');
  host.querySelectorAll('.ov-tab').forEach((el) => {
    el.onclick = (e) => {
      const closeId = e.target?.dataset?.close;
      if (closeId) {
        e.preventDefault();
        e.stopPropagation();
        closeTab(closeId);
        return;
      }
      switchTab(el.dataset.id);
    };
  });
}

async function switchTab(id) {
  if (!id || id === activeTabId) return;
  // Remember current URL on the tab we're leaving
  try {
    const u = web.getURL();
    const cur = tabs.find((t) => t.id === activeTabId);
    if (cur && (/^https?:\/\//i.test(u) || isHomeUrl(u))) {
      cur.url = isHomeUrl(u) ? (browserHome || u) : u;
    }
  } catch { /* */ }
  activeTabId = id;
  const tab = tabs.find((t) => t.id === id);
  renderTabs();
  if (tab) await navigateTo(tab.url);
  scheduleSaveLayout();
}

function closeTab(id) {
  if (tabs.length <= 1) {
    // Last tab — just navigate home rather than killing the browser
    const tab = tabs[0];
    tab.url = browserHome || tab.url;
    tab.title = 'New Tab';
    activeTabId = tab.id;
    navigateTo(tab.url);
    renderTabs();
    scheduleSaveLayout();
    return;
  }
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    const next = tabs[Math.max(0, idx - 1)];
    activeTabId = next.id;
    navigateTo(next.url);
  }
  renderTabs();
  scheduleSaveLayout();
}

function addTab(url) {
  const dest = url || browserHome;
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  tabs.push({ id, url: dest, title: 'New Tab' });
  activeTabId = id;
  renderTabs();
  navigateTo(dest);
  if ($('#pane-browser').classList.contains('hidden')) openBrowserPanel();
  scheduleSaveLayout();
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
  scheduleRelayoutWeb();
};

web.addEventListener('dom-ready', () => {
  syncNavButtons();
  relayoutWeb();
  // Reinforce Chrome UA on the guest (partition session UA is set in main).
  ov.browserUa().then((ua) => {
    try { if (ua) web.setUserAgent(ua); } catch { /* */ }
  }).catch(() => {});
});
web.addEventListener('did-finish-load', () => scheduleRelayoutWeb());
web.addEventListener('did-navigate', (e) => { pageTitle = ''; onNavigated(e.url); });
web.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigated(e.url); });
web.addEventListener('page-title-updated', (e) => {
  pageTitle = e.title || '';
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab && pageTitle) tab.title = pageTitle.slice(0, 200);
  renderTabs();
  let url = '';
  try { url = web.getURL(); } catch { /* */ }
  if (url && /^https?:\/\//i.test(url)) ov.recordVisit({ url, title: pageTitle }).catch(() => {});
});
web.addEventListener('did-fail-load', (e) => {
  if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted
  console.warn('[overlay-browser] fail-load', e.errorDescription, e.validatedURL);
});
web.addEventListener('new-window', (e) => {
  e.preventDefault();
  if (/^https?:\/\//i.test(e.url)) addTab(e.url);
});

// ---- drag + resize the floating browser ----
(() => {
  const panel = $('#pane-browser');
  const dragEl = $('#bb-drag');
  const resizeEl = $('#bb-resize');
  let drag = null;
  let resize = null;

  dragEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .ov-tab')) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      left: panel.offsetLeft,
      top: panel.offsetTop,
    };
    e.preventDefault();
  });
  resizeEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    resize = {
      x: e.clientX,
      y: e.clientY,
      w: panel.offsetWidth,
      h: panel.offsetHeight,
    };
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('mousemove', (e) => {
    if (drag) {
      const nx = Math.min(Math.max(0, drag.left + (e.clientX - drag.x)), window.innerWidth - 80);
      const ny = Math.min(Math.max(0, drag.top + (e.clientY - drag.y)), window.innerHeight - 80);
      panel.style.left = `${nx}px`;
      panel.style.top = `${ny}px`;
    } else if (resize) {
      const nw = Math.min(Math.max(420, resize.w + (e.clientX - resize.x)), window.innerWidth - 16);
      const nh = Math.min(Math.max(280, resize.h + (e.clientY - resize.y)), window.innerHeight - 16);
      panel.style.width = `${nw}px`;
      panel.style.height = `${nh}px`;
      scheduleRelayoutWeb();
    }
  });
  window.addEventListener('mouseup', () => {
    if (drag || resize) scheduleSaveLayout();
    drag = null;
    resize = null;
  });
})();

$('#bb-newtab').onclick = () => addTab();
$('#bb-close-panel').onclick = () => closeBrowserPanel();

async function bootBrowser() {
  // Only boot once per overlay window lifetime. Shift+Tab hides the window —
  // it does not remount this page — so tabs/scroll/media keep playing.
  if (bootBrowser.done) return;
  bootBrowser.done = true;
  browserHome = await ov.browserHome().catch(() => null);
  browserProfile = await ov.browserProfile().catch(() => null);
  const home = browserHome || browserProfile?.tabs?.[0]?.url;
  tabs = (browserProfile?.tabs?.length
    ? browserProfile.tabs.map((t) => ({
      id: t.id,
      url: isHomeUrl(t.url) ? (browserHome || t.url) : t.url,
      title: isHomeUrl(t.url) ? 'New Tab' : (t.title || t.url),
    }))
    : [{ id: 'home', url: home, title: 'New Tab' }]);
  activeTabId = browserProfile?.activeTabId && tabs.some((t) => t.id === browserProfile.activeTabId)
    ? browserProfile.activeTabId
    : tabs[0].id;
  renderTabs();
  applyBrowserBounds(browserProfile?.bounds);

  // Apply UA before first navigation
  try {
    const ua = await ov.browserUa();
    if (ua) web.setUserAgent(ua);
  } catch { /* */ }

  const start = tabs.find((t) => t.id === activeTabId)?.url || home;
  urlBox.value = displayUrl(start);

  // Restore open state from last session — otherwise stay closed
  if (browserProfile?.browserOpen) {
    openBrowserPanel();
    await navigateTo(start);
  } else {
    // Prefetch into the hidden webview so opening later is instant
    await navigateTo(start);
    $('#pane-browser').classList.add('hidden');
    $('#tb-browser').classList.remove('active');
  }
  syncStar();
  scheduleRelayoutWeb();
}
bootBrowser();

// Soft re-show after Shift+Tab — refresh chrome only, never reload the guest.
ov.onShown(() => {
  refresh();
  scheduleRelayoutWeb();
});
ov.onHiding(() => {
  persistLayout();
  hideSuggest();
});

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
$('#shots-close').onclick = () => closeShotsPanel();

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

// Start with no pane open — browser restores itself if it was left open last time
$('#pane-shots').classList.add('hidden');
$('#tb-shots').classList.remove('active');
refresh();
