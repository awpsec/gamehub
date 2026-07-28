// Overlay browser profile — bookmarks, omnibox history, floating-window
// layout, and tab URLs. Pure fs helpers (no Electron) so unit tests stay easy.
// Chromium cookies/logins live separately in partition persist:gamehub-overlay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_HISTORY = 250;
const MAX_SEARCHES = 120;
const MAX_BOOKMARKS = 200;
const MAX_TABS = 12;

const DEFAULT_HOME = 'https://www.google.com/';
const SEARCH_URL = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function blankTab(url = DEFAULT_HOME) {
  return { id: newId(), url, title: 'New Tab' };
}

function blank() {
  const tab = blankTab();
  return {
    version: 2,
    lastUrl: DEFAULT_HOME,
    browserOpen: false, // overlay opens with browser closed unless user left it open
    bounds: { x: null, y: null, w: 980, h: 640 },
    tabs: [tab],
    activeTabId: tab.id,
    bookmarks: [],
    history: [],
    searches: [],
  };
}

function profilePath(root) {
  return path.join(root, 'overlay-browser.json');
}

function validBookmark(b) {
  return b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url) && typeof b.title === 'string';
}
function validVisit(v) {
  return v && typeof v.url === 'string' && /^https?:\/\//i.test(v.url);
}
function validSearch(s) {
  return s && typeof s.q === 'string' && s.q.trim().length > 0;
}
function validTab(t) {
  return t && typeof t.id === 'string' && typeof t.url === 'string' && /^https?:\/\//i.test(t.url);
}
function validBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const w = Number(b.w); const h = Number(b.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 360 || h < 240) return null;
  const x = b.x == null ? null : Number(b.x);
  const y = b.y == null ? null : Number(b.y);
  return {
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    w: Math.min(Math.max(Math.round(w), 360), 4000),
    h: Math.min(Math.max(Math.round(h), 240), 3000),
  };
}

function load(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(root), 'utf8'));
    if (!raw || typeof raw !== 'object') return blank();
    let tabs = Array.isArray(raw.tabs) ? raw.tabs.filter(validTab).slice(0, MAX_TABS) : [];
    if (!tabs.length) {
      const u = typeof raw.lastUrl === 'string' && /^https?:\/\//i.test(raw.lastUrl) ? raw.lastUrl : DEFAULT_HOME;
      tabs = [blankTab(u)];
    }
    tabs = tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: String(t.title || t.url).slice(0, 200),
    }));
    let activeTabId = typeof raw.activeTabId === 'string' ? raw.activeTabId : tabs[0].id;
    if (!tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0].id;
    const active = tabs.find((t) => t.id === activeTabId) || tabs[0];
    return {
      version: 2,
      lastUrl: active.url,
      browserOpen: raw.browserOpen === true,
      bounds: validBounds(raw.bounds) || blank().bounds,
      tabs,
      activeTabId,
      bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks.filter(validBookmark) : [],
      history: Array.isArray(raw.history) ? raw.history.filter(validVisit) : [],
      searches: Array.isArray(raw.searches) ? raw.searches.filter(validSearch) : [],
    };
  } catch {
    return blank();
  }
}

function save(root, data) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = profilePath(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, profilePath(root));
}

function looksLikeAddress(input) {
  const v = (input || '').trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (/\s/.test(v)) return false;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(v)) return true;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/i.test(v)) {
    const host = v.split(/[/:?#]/)[0];
    const tld = host.split('.').pop();
    if (tld && /^[a-z]{2,24}$/i.test(tld)) return true;
  }
  return false;
}

function resolveOmnibox(input) {
  const v = (input || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return { kind: 'url', url: v, query: null };
  if (looksLikeAddress(v)) return { kind: 'url', url: `https://${v}`, query: null };
  return { kind: 'search', url: SEARCH_URL(v), query: v };
}

function setLastUrl(root, url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return load(root);
  if (/^(about:|chrome:|data:)/i.test(url)) return load(root);
  const data = load(root);
  data.lastUrl = url;
  const tab = data.tabs.find((t) => t.id === data.activeTabId);
  if (tab) tab.url = url;
  save(root, data);
  return data;
}

function recordVisit(root, { url, title = '' }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return load(root);
  if (/^(about:|chrome:|data:)/i.test(url)) return load(root);
  if (/google\.[^/]+\/search\?/i.test(url)) {
    try {
      const q = new URL(url).searchParams.get('q');
      if (q) recordSearch(root, q);
    } catch { /* */ }
  }
  const data = load(root);
  data.lastUrl = url;
  const tab = data.tabs.find((t) => t.id === data.activeTabId);
  if (tab) {
    tab.url = url;
    if (title) tab.title = String(title).slice(0, 200);
  }
  data.history = [
    { url, title: String(title || '').slice(0, 200), at: Date.now() },
    ...data.history.filter((h) => h.url !== url),
  ].slice(0, MAX_HISTORY);
  save(root, data);
  return data;
}

function recordSearch(root, query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return load(root);
  const data = load(root);
  data.searches = [
    { q, at: Date.now() },
    ...data.searches.filter((s) => s.q.toLowerCase() !== q.toLowerCase()),
  ].slice(0, MAX_SEARCHES);
  save(root, data);
  return data;
}

function listBookmarks(root) {
  return load(root).bookmarks.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

function addBookmark(root, { url, title = '' }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const data = load(root);
  const existing = data.bookmarks.find((b) => b.url === url);
  if (existing) {
    existing.title = String(title || existing.title || url).slice(0, 200);
    existing.at = Date.now();
    save(root, data);
    return existing;
  }
  const entry = {
    id: newId(),
    url,
    title: String(title || url).slice(0, 200),
    at: Date.now(),
  };
  data.bookmarks = [entry, ...data.bookmarks].slice(0, MAX_BOOKMARKS);
  save(root, data);
  return entry;
}

function removeBookmark(root, idOrUrl) {
  const data = load(root);
  const before = data.bookmarks.length;
  data.bookmarks = data.bookmarks.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
  if (data.bookmarks.length === before) return false;
  save(root, data);
  return true;
}

function isBookmarked(root, url) {
  return load(root).bookmarks.some((b) => b.url === url);
}

function suggest(root, query = '', limit = 8) {
  const data = load(root);
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = item.kind === 'search' ? `s:${item.q.toLowerCase()}` : `u:${item.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const s of data.searches) {
    if (q && !s.q.toLowerCase().includes(q)) continue;
    push({ kind: 'search', q: s.q, url: SEARCH_URL(s.q), title: s.q, at: s.at });
    if (out.length >= limit) return out;
  }
  for (const b of data.bookmarks) {
    if (q && !`${b.title} ${b.url}`.toLowerCase().includes(q)) continue;
    push({ kind: 'bookmark', url: b.url, title: b.title || b.url, at: b.at });
    if (out.length >= limit) return out;
  }
  for (const h of data.history) {
    if (q && !`${h.title || ''} ${h.url}`.toLowerCase().includes(q)) continue;
    push({ kind: 'history', url: h.url, title: h.title || h.url, at: h.at });
    if (out.length >= limit) return out;
  }
  return out;
}

// Persist floating browser chrome: open/closed, pixel bounds, tab list.
function saveLayout(root, { browserOpen, bounds, tabs, activeTabId } = {}) {
  const data = load(root);
  if (typeof browserOpen === 'boolean') data.browserOpen = browserOpen;
  const b = validBounds(bounds);
  if (b) data.bounds = b;
  if (Array.isArray(tabs) && tabs.length) {
    data.tabs = tabs.filter(validTab).slice(0, MAX_TABS).map((t) => ({
      id: t.id,
      url: t.url,
      title: String(t.title || t.url).slice(0, 200),
    }));
    if (!data.tabs.length) data.tabs = [blankTab()];
  }
  if (typeof activeTabId === 'string' && data.tabs.some((t) => t.id === activeTabId)) {
    data.activeTabId = activeTabId;
  } else {
    data.activeTabId = data.tabs[0].id;
  }
  const active = data.tabs.find((t) => t.id === data.activeTabId) || data.tabs[0];
  data.lastUrl = active.url;
  save(root, data);
  return data;
}

function newTab(root, url = DEFAULT_HOME) {
  const data = load(root);
  if (data.tabs.length >= MAX_TABS) return data;
  const tab = blankTab(url);
  data.tabs.push(tab);
  data.activeTabId = tab.id;
  data.lastUrl = tab.url;
  data.browserOpen = true;
  save(root, data);
  return data;
}

module.exports = {
  DEFAULT_HOME,
  SEARCH_URL,
  blank,
  blankTab,
  newId,
  load,
  save,
  looksLikeAddress,
  resolveOmnibox,
  setLastUrl,
  recordVisit,
  recordSearch,
  listBookmarks,
  addBookmark,
  removeBookmark,
  isBookmarked,
  suggest,
  saveLayout,
  newTab,
};
