const $ = (s) => document.querySelector(s);
const gh = window.gamehub;

let state = {
  view: 'store',            // store | library | game | social | profile
  gamePageId: null,         // when view === 'game' (opened from store)
  selectedLib: null,        // selected game in the library sidebar
  heroIdx: 0,
  games: [], installed: {}, myLibrary: [], favorites: [], playtime: {}, tasks: {},
  categories: { categories: [], collapsed: {} }, // Steam-style collections + collapse memory
  social: null, profile: null, profileSort: 'seconds', // fetched on demand
  socialFrame: 'week',      // social lists timeframe: week | allTime
  profileUserId: null,      // whose profile is open (null = mine)
  storeFilter: null,        // null | {type:'genre',value} | {type:'reviews'} — store browse filter
  storeSort: 'featured',    // featured | reviews | added | released | name
};
let loaded = false;
let lastHash = '';
// games added to the library THIS session stay visible in the store
// (marked "✓ In Library") — they vanish only on the next session
const sessionAdded = new Set();
let heroPaused = false;

const NEW_DAYS = 7; // grey "NEW" = added to your server within this many days
const NEW_RELEASE_DAYS = 30; // blue "NEW RELEASE" = the game itself launched within the past month

function fmtSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
function fmtPlaytime(seconds) {
  if (!seconds || seconds < 60) return null;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
function fmtWhen(iso) {
  if (!iso) return null;
  // SQLite datetimes ("YYYY-MM-DD HH:MM:SS") are UTC with no zone marker — tag
  // them as UTC so Date() doesn't misread them as local (which yields "-1 days").
  const norm = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso;
  const d = new Date(norm);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

// ---------- duplicate packages: one logical game, many downloaded versions ----------
// Library entries matched to the SAME provider game (e.g. "Nova Roma 1.0" and
// "Nova Roma 1.1") are grouped. The group is keyed by a STABLE canonical id (the
// lowest row id) so per-game state (library/favorites/categories/playtime/install)
// survives switching between packages. Each package stays a real, downloadable row.
function pkgKey(g) { return (g.provider && g.provider_id) ? `${g.provider}:${g.provider_id}` : `solo:${g.id}`; }
function pkgVersion(g) {
  const s = g.raw_name || g.clean_name || '';
  let m = s.match(/\bv?(\d+(?:\.\d+){1,3})\b/i);            // 1.2 · v1.2.3
  if (m) return { label: m[1], num: m[1].split('.').map(Number) };
  m = s.match(/\b(?:update|build|patch|rev)\s*\.?\s*(\d+)\b/i); // Build 12345
  if (m) return { label: m[0].replace(/\s+/g, ' ').trim(), num: [0, Number(m[1])] };
  m = s.match(/\bv(\d+)\b/i);                                // v3
  if (m) return { label: `v${m[1]}`, num: [Number(m[1])] };
  return null;
}
function cmpVersionDesc(a, b) { // newest first
  const va = pkgVersion(a), vb = pkgVersion(b);
  if (va && vb) {
    for (let i = 0; i < Math.max(va.num.length, vb.num.length); i++) {
      const d = (vb.num[i] || 0) - (va.num[i] || 0);
      if (d) return d;
    }
  } else if (va) return -1; else if (vb) return 1;
  return addedAt(b) - addedAt(a);
}
let groupsByKey = null; // pkgKey -> [rows] (newest package first)
let canonById = null;   // any row id -> canonical/group id (lowest id in the group)
function rebuildGroups() {
  groupsByKey = new Map();
  for (const g of state.games) {
    const k = pkgKey(g);
    if (!groupsByKey.has(k)) groupsByKey.set(k, []);
    groupsByKey.get(k).push(g);
  }
  canonById = new Map();
  for (const rows of groupsByKey.values()) {
    rows.sort(cmpVersionDesc);
    const canon = rows.reduce((lo, r) => Math.min(lo, r.id), rows[0].id);
    for (const r of rows) canonById.set(r.id, canon);
  }
}
function canonOf(id) { return (canonById && canonById.get(id)) || id; }
function isCanon(g) { return canonOf(g.id) === g.id; }
function packagesOf(id) {
  const g = byId(canonOf(id)) || byId(id);
  return (g && groupsByKey && groupsByKey.get(pkgKey(g))) || (g ? [g] : []);
}
// the version currently installed for a group (matches installed[groupId].packageId)
function installedPackage(id) {
  const inst = state.installed[canonOf(id)];
  // only resolve when we actually recorded which package it is — never fall back
  // to the canonical (lowest-id) row, which can be an OLDER version than what's on disk
  return inst && inst.packageId != null ? (byId(inst.packageId) || null) : null;
}
// dismissable "new version available" alerts (local, per group → dismissed version)
function verDismissMap() { try { return JSON.parse(localStorage.getItem('gh_ver_dismiss') || '{}'); } catch { return {}; } }
function dismissVersion(groupId, label) { const m = verDismissMap(); m[groupId] = label; localStorage.setItem('gh_ver_dismiss', JSON.stringify(m)); }
// the newest package when it's newer than the installed one, was added recently,
// and hasn't been dismissed — else null
function newerVersion(g) {
  const inst = state.installed[canonOf(g.id)];
  if (!inst || inst.packageId == null) return null; // unknown installed version → don't guess
  const packages = packagesOf(g.id);
  if (packages.length < 2) return null;
  const newest = packages[0];
  if (newest.id === inst.packageId) return null;              // already on the newest
  if (Date.now() - addedAt(newest) > 45 * 864e5) return null; // only recent uploads
  const label = pkgVersion(newest)?.label || String(newest.id);
  if (verDismissMap()[canonOf(g.id)] === label) return null;
  return { pkg: newest, label };
}

function inMyLibrary(id) { const c = canonOf(id); return state.myLibrary.includes(c) || !!state.installed[c]; }
function isFavorite(id) { return state.favorites.includes(canonOf(id)); }
function gameState(g) {
  const c = canonOf(g.id);
  const task = state.tasks[c];
  if (task && ['downloading', 'extracting'].includes(task.phase)) return { key: 'busy', task };
  const inst = state.installed[c];
  if (!inst) return { key: 'not-installed' };
  // `playing` is an overlay flag (game is running) — key stays 'installed' so
  // the menu/actions are unchanged; only the primary button switches to "In game"
  return { key: inst.status, inst, playing: !!(task && task.phase === 'playing') };
}
function addedAt(g) { return new Date((g.created_at || '').replace(' ', 'T') + 'Z').getTime() || 0; }
function isNew(g) { return Date.now() - addedAt(g) < NEW_DAYS * 864e5; }
// when the game itself released (from the store's display date). Best-effort
// parse: "Mar 26, 2026" → ts; "Q1 2027"/"Coming soon" → NaN (treated as unknown).
function releasedAt(g) { const t = Date.parse(g.meta_released || ''); return Number.isNaN(t) ? 0 : t; }
function isNewRelease(g) {
  const t = releasedAt(g);
  return t > 0 && t <= Date.now() && Date.now() - t < NEW_RELEASE_DAYS * 864e5;
}
// blue "NEW RELEASE" (just launched) takes priority over grey "NEW" (just added)
function newBadge(g) {
  if (isNewRelease(g)) return '<span class="new-badge release">NEW RELEASE</span>';
  if (isNew(g)) return '<span class="new-badge">NEW</span>';
  return '';
}
function titleOf(g) { return g.meta_title || g.clean_name; }
function byId(id) { return state.games.find((g) => g.id === id); }
function parseJson(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

// ---- discovery: genres + a unified review score, for browse/sort ----
const OUTSTANDING_PCT = 85; // "Outstanding reviews" threshold
function gameGenres(g) { return (g.meta_genres || '').split(',').map((x) => x.trim()).filter(Boolean); }
const _pctCache = new WeakMap(); // meta_ratings JSON parse is hot during sorts
function reviewPct(g) {
  if (_pctCache.has(g)) return _pctCache.get(g);
  const r = parseJson(g.meta_ratings);
  let v = null;
  if (r) {
    if (r.steam && r.steam.percent != null) v = r.steam.percent;
    else if (r.metacritic && r.metacritic.score != null) v = r.metacritic.score;
    else if (r.igdb && r.igdb.critic != null) v = Math.round(r.igdb.critic);
    else if (r.rawg && r.rawg.rating != null) v = Math.round(r.rawg.rating * 20);
  }
  _pctCache.set(g, v);
  return v;
}
function hasGenre(g, name) { const n = name.toLowerCase(); return gameGenres(g).some((x) => x.toLowerCase() === n); }
// genres present in the pool, most common first (≥2 games to be worth a shortcut)
function topGenres(pool, n) {
  const counts = new Map();
  for (const g of pool) for (const gn of gameGenres(g)) counts.set(gn, (counts.get(gn) || 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([gn]) => gn);
}
function sortGames(list, sort) {
  const rev = (a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1);
  const arr = [...list];
  if (sort === 'name') arr.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  else if (sort === 'reviews') arr.sort((a, b) => rev(a, b) || titleOf(a).localeCompare(titleOf(b)));
  else if (sort === 'added') arr.sort((a, b) => addedAt(b) - addedAt(a));
  else if (sort === 'released') arr.sort((a, b) => releasedAt(b) - releasedAt(a));
  else arr.sort((a, b) => rev(a, b) || (addedAt(b) - addedAt(a))); // featured = best-reviewed, then newest
  return arr;
}
function sortControlHtml() {
  const s = state.storeSort;
  const b = (k, l) => `<button class="sort-btn${s === k ? ' on' : ''}" data-storesort="${k}">${l}</button>`;
  return `<span class="sort-control"><span class="muted">Sort</span>${b('featured', 'Featured')}${b('reviews', 'Rating')}${b('added', 'Newest')}${b('released', 'Release')}${b('name', 'Name')}</span>`;
}

// ---------- Steam store price (informational — deep-links out to Steam) ----------
const STEAM_LOGO = '<svg class="steam-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.98 0C5.7 0 .53 4.85.02 11.02l6.44 2.66a3.4 3.4 0 0 1 1.9-.59l.19.01 2.86-4.15v-.06a4.53 4.53 0 1 1 4.53 4.53h-.1l-4.08 2.91.01.16a3.4 3.4 0 1 1-6.72-.67L.44 15.27A12 12 0 1 0 11.98 0zM7.54 18.2l-1.47-.6c.26.54.71 1 1.31 1.25a2.55 2.55 0 0 0 1.96-4.7l-1.52-.63a1.96 1.96 0 1 1-.28 4.68zm11.42-9.3a3.02 3.02 0 1 0-6.03 0 3.02 3.02 0 0 0 6.03 0zm-5.27 0a2.27 2.27 0 1 1 4.53 0 2.27 2.27 0 0 1-4.53 0z"/></svg>';
let showSteamPrices = true; // "Show Steam prices" setting (from config at boot)
function parsePrice(g) {
  const p = parseJson(g.meta_price);
  return p && Object.keys(p).length ? p : null;
}
// Steam-style tag: struck original + green sale price + % off; plain when not
// discounted; "Free" for free-to-play. `compact` (cards) shows the Steam logo,
// drops the "on Steam" note. Hidden entirely when "Show Steam prices" is off.
function priceHtml(g, compact = false) {
  if (!showSteamPrices) return '';
  const p = parsePrice(g);
  if (!p) return '';
  // cards show the logo before the price; the game page shows it after (where
  // "on Steam" used to be) so it doesn't read "on Steam … View on Steam"
  const logo = compact ? STEAM_LOGO : '';
  const store = compact ? '' : STEAM_LOGO;
  if (p.isFree) return `<span class="price">${logo}<span class="price-final free">Free</span>${store}</span>`;
  if (!p.finalFormatted) return '';
  const onSale = p.discountPercent > 0;
  return `<span class="price${onSale ? ' on-sale' : ''}">
    ${logo}
    ${onSale ? `<span class="price-off">-${p.discountPercent}%</span>` : ''}
    ${onSale ? `<span class="price-orig">${esc(p.initialFormatted)}</span>` : ''}
    <span class="price-final${onSale ? ' sale' : ''}">${esc(p.finalFormatted)}</span>
    ${store}
  </span>`;
}
function steamLinkHtml(g) {
  if (g.provider !== 'steam' || !g.provider_id) return '';
  return `<button class="steam-link" data-external="https://store.steampowered.com/app/${encodeURIComponent(g.provider_id)}">View on Steam ↗</button>`;
}

// ============================================================ window controls
$('#win-min').onclick = () => gh.winMinimize();
$('#win-max').onclick = () => gh.winMaximize();
$('#win-close').onclick = () => gh.winClose();

// Window dragging + double-click-to-maximize are NATIVE (-webkit-app-region on
// the title bar, see style.css) — smooth, and Windows anchors the maximized→
// restore drag for us. The one native gotcha: Chromium can drop the draggable-
// region hit-test after a scroll. Re-arm it by briefly toggling the title bar's
// app-region once scrolling settles (debounced, no visible flicker).
(() => {
  let t;
  const rearm = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      document.querySelectorAll('header, .rail').forEach((el) => {
        el.style.setProperty('-webkit-app-region', 'no-drag');
        void el.offsetWidth; // force the region to recompute...
        el.style.removeProperty('-webkit-app-region'); // ...then revert to the stylesheet (drag)
      });
    }, 80);
  };
  window.addEventListener('scroll', rearm, true); // capture: inner scrollers (main, lists) too
})();

// ============================================================ nav
const VIEW_TITLES = { store: 'Store', library: 'My Library', social: 'Social', profile: 'My Profile' };
function switchView(view) {
  if (view !== 'social') stopSocialPoll(); // no live polling off the social tab
  state.view = view;
  state.gamePageId = null;
  $('#nav-store').classList.toggle('active', view === 'store');
  $('#nav-library').classList.toggle('active', view === 'library');
  $('#nav-social').classList.toggle('active', view === 'social');
  $('#page-title').textContent = VIEW_TITLES[view] || 'Gamehub';
  $('#search').value = '';
  render();
}
$('#nav-store').onclick = () => { state.storeFilter = null; switchView('store'); };
$('#nav-library').onclick = () => switchView('library');
$('#nav-social').onclick = () => loadSocial();

function openGamePage(id) {
  stopSocialPoll(); // opening a game from the social tab bypasses switchView — stop polling now
  id = canonOf(id); // always open the logical game (its packages live under the canonical id)
  if (state.view === 'library') {
    state.selectedLib = id;
  } else {
    state.view = 'game';
    state.gamePageId = id;
    $('#page-title').textContent = titleOf(byId(id) || {}) || 'Game';
  }
  render();
}

// ============================================================ store cards
// Cover art with graceful fallback: portrait covers crop to fill; a landscape
// banner (last-resort art) is CONTAINED over a blurred fill instead of an ugly
// center-crop; no art at all → a text cover. coverFit() (onload) tags wide images.
function coverHtml(g) {
  if (!g.meta_cover) return `<div class="cover text-cover"><span>${esc(titleOf(g))}</span></div>`;
  return `<div class="cover" style="background-image:url('${esc(g.meta_cover)}')">
    <img class="cover-fg" src="${esc(g.meta_cover)}" alt="" loading="lazy" onload="coverFit(this)" />
  </div>`;
}
function coverFit(img) {
  const c = img.closest('.cover');
  if (c && img.naturalWidth > img.naturalHeight * 1.15) c.classList.add('wide');
}

function storeCard(g) {
  const owned = inMyLibrary(g.id);
  // owned → small corner "sticker"; otherwise a + button on hover to add
  const libBtn = owned
    ? '<span class="lib-sticker" title="In Library">✓</span>'
    : `<button class="card-lib-btn" data-act="addToLibrary" data-id="${g.id}" title="Add to Library">+</button>`;
  return `<div class="card" data-open="${g.id}">
    ${!owned ? newBadge(g) : ''}
    ${libBtn}
    ${coverHtml(g)}
    <div class="info">
      <div class="title" title="${esc(titleOf(g))}">${esc(titleOf(g))}</div>
      <div class="sub">${g.meta_year || ''}${g.meta_year ? ' · ' : ''}${fmtSize(g.size_bytes)}</div>
      ${priceHtml(g, true) ? `<div class="card-price">${priceHtml(g, true)}</div>` : ''}
    </div>
  </div>`;
}

// ---------- rotating hero (5-7 newest, auto-cycles) ----------
function heroPool() {
  return state.games
    .filter((g) => isCanon(g) && (g.meta_hero || g.meta_cover) && (!inMyLibrary(g.id) || sessionAdded.has(g.id)))
    .sort((a, b) => addedAt(b) - addedAt(a))
    .slice(0, 6);
}

function heroHtml() {
  const pool = heroPool();
  if (pool.length === 0) return '';
  state.heroIdx = state.heroIdx % pool.length;
  const g = pool[state.heroIdx];
  const owned = inMyLibrary(g.id);
  return `<div class="hero" data-open="${g.id}">
    <div class="hero-bg" style="background-image:url('${esc(g.meta_hero || g.meta_cover)}')"></div>
    <div class="hero-fade"></div>
    ${owned ? '<span class="lib-sticker hero-sticker" title="In Library">✓</span>' : ''}
    <div class="hero-content">
      <div class="hero-kicker">${isNew(g) ? 'New on your server' : 'From your server'}</div>
      <div class="hero-title">${esc(titleOf(g))}</div>
      <div class="hero-meta">
        ${g.meta_year ? `<span class="chip">${g.meta_year}</span>` : ''}
        ${(g.meta_genres || '').split(',').filter(Boolean).slice(0, 3).map((x) => `<span class="chip">${esc(x.trim())}</span>`).join('')}
        <span class="chip">${fmtSize(g.size_bytes)}</span>
      </div>
      ${g.meta_summary ? `<div class="hero-summary">${esc(g.meta_summary)}</div>` : ''}
      <div class="hero-actions">
        ${owned ? '' : `<button class="btn primary lg" data-act="addToLibrary" data-id="${g.id}">+ Add to Library</button>`}
      </div>
    </div>
    ${pool.length > 1 ? `
      <button class="hero-arrow prev" data-hero-nav="-1" aria-label="Previous">‹</button>
      <button class="hero-arrow next" data-hero-nav="1" aria-label="Next">›</button>
      <div class="hero-dots">${pool.map((_, i) => `<span class="${i === state.heroIdx ? 'on' : ''}" data-dot="${i}"></span>`).join('')}</div>`
      : ''}
  </div>`;
}

function renderHeroSlot() {
  const slot = $('#hero-slot');
  if (!slot) return;
  slot.innerHTML = heroHtml();
  wire(slot);
  const hero = slot.querySelector('.hero');
  if (hero) {
    hero.addEventListener('mouseenter', () => { heroPaused = true; });
    hero.addEventListener('mouseleave', () => { heroPaused = false; });
  }
}

setInterval(() => {
  if (state.view !== 'store' || heroPaused || document.hidden) return;
  const pool = heroPool();
  if (pool.length < 2) return;
  state.heroIdx = (state.heroIdx + 1) % pool.length;
  renderHeroSlot();
}, 7000);

// ============================================================ game page (Steam-style)
function ratingClass(v, scale = 100) {
  const p = (v / scale) * 100;
  return p >= 75 ? 'good' : p >= 50 ? 'mid' : 'bad';
}
function ratingsHtml(ratingsJson) {
  const r = parseJson(ratingsJson) || {};
  const blocks = [];
  if (r.steam) blocks.push(`<div class="rating"><div class="rating-val ${ratingClass(r.steam.percent)}">${r.steam.percent}%</div><div class="rating-sub"><strong>Steam</strong> · ${esc(r.steam.desc || '')}<br>${Number(r.steam.count).toLocaleString()} reviews</div></div>`);
  if (r.metacritic) blocks.push(`<div class="rating"><div class="rating-val mc ${ratingClass(r.metacritic.score)}">${r.metacritic.score}</div><div class="rating-sub"><strong>Metacritic</strong><br>critic score</div></div>`);
  if (r.igdb?.critic) blocks.push(`<div class="rating"><div class="rating-val ${ratingClass(r.igdb.critic)}">${r.igdb.critic}</div><div class="rating-sub"><strong>IGDB</strong> · critics<br>${r.igdb.criticCount || 0} outlets</div></div>`);
  if (r.rawg) blocks.push(`<div class="rating"><div class="rating-val ${ratingClass(r.rawg.rating, 5)}">${Number(r.rawg.rating).toFixed(1)}</div><div class="rating-sub"><strong>RAWG</strong> · out of 5<br>${Number(r.rawg.count).toLocaleString()} ratings</div></div>`);
  return blocks.length ? `<div class="ratings">${blocks.join('')}</div>` : '';
}

// compact colored rating badges (for the game-page hero) — value on the badge,
// full source/description revealed on hover so it never displaces the header
function ratingBadges(ratingsJson) {
  const r = parseJson(ratingsJson) || {};
  const mk = (val, cls, src, desc) => `<span class="rating-badge ${cls}" tabindex="0">
    <span class="rb-val">${val}</span>
    <span class="rb-tip"><span class="rb-tip-val ${cls}">${val}</span><span class="rb-tip-txt"><strong>${src}</strong>${desc ? ' · ' + desc : ''}</span></span>
  </span>`;
  const b = [];
  if (r.steam) b.push(mk(`${r.steam.percent}%`, ratingClass(r.steam.percent), 'Steam', `${esc(r.steam.desc || 'user reviews')}<br>${Number(r.steam.count).toLocaleString()} reviews`));
  if (r.metacritic) b.push(mk(`${r.metacritic.score}`, ratingClass(r.metacritic.score), 'Metacritic', 'critic score'));
  if (r.igdb?.critic) b.push(mk(`${r.igdb.critic}`, ratingClass(r.igdb.critic), 'IGDB', `critics · ${r.igdb.criticCount || 0} outlets`));
  if (r.rawg) b.push(mk(Number(r.rawg.rating).toFixed(1), ratingClass(r.rawg.rating, 5), 'RAWG', `out of 5 · ${Number(r.rawg.count).toLocaleString()} ratings`));
  return b.length ? `<div class="rating-badges">${b.join('')}</div>` : '';
}

// ---------- OS compatibility + requirements ----------
let hostPlatform = 'win32'; // refreshed from config at boot

// OS glyphs (single-color, rendered plain white via currentColor)
const OS_ICONS = {
  windows: '<svg viewBox="0 0 16 16"><path d="M0 2.3 6.5 1.4v6.2H0zM7.3 1.3 16 0v7.6H7.3zM0 8.4h6.5v6.2L0 13.7zM7.3 8.4H16V16L7.3 14.7z"/></svg>',
  linux: '<svg viewBox="0 0 16 16"><path d="M8 .8C6 .8 4.8 2.3 4.8 4.2c0 .9-.2 1.6-.7 2.6C3.3 8.4 2.5 10 2.5 11.6c0 .5.1 1 .3 1.4-.5.2-.8.6-.8 1.1 0 .7.7 1.2 1.5 1.2.5 0 1-.2 1.5-.2.4 0 .9.1 1.4.1h3.2c.5 0 1-.1 1.4-.1.5 0 1 .2 1.5.2.8 0 1.5-.5 1.5-1.2 0-.5-.3-.9-.8-1.1.2-.4.3-.9.3-1.4 0-1.6-.8-3.2-1.6-4.8-.5-1-.7-1.7-.7-2.6C11.2 2.3 10 .8 8 .8zM6.6 4.1a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2zm2.8 0a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2zM6.7 6.2h2.6L8 7.6 6.7 6.2z" fill-rule="evenodd"/></svg>',
  proton: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="1.7"/><g fill="none" stroke="currentColor" stroke-width="1.1"><ellipse cx="8" cy="8" rx="6.9" ry="2.7"/><ellipse cx="8" cy="8" rx="6.9" ry="2.7" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.9" ry="2.7" transform="rotate(120 8 8)"/></g></svg>',
  mac: '<svg viewBox="0 0 16 16"><path d="M11.6 8.5c0-1.7 1.4-2.5 1.4-2.5-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6-.5 0-1.3-.6-2.2-.6-1.1 0-2.2.7-2.8 1.7-1.2 2-.3 5.1.9 6.8.6.8 1.2 1.7 2.1 1.7.8 0 1.2-.5 2.2-.5s1.3.5 2.2.5 1.5-.8 2-1.6c.6-.9.9-1.8.9-1.9 0 0-1.8-.7-1.8-2.9zM10 3.7c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-1.1z"/></svg>',
};

function compatHtml(g) {
  const c = parseJson(g.meta_compat);
  if (!c?.platforms) return '';
  const items = [];
  if (c.platforms.windows) {
    items.push(`<span class="os-item">${OS_ICONS.windows}<span>Windows</span></span>`);
  }
  if (c.platforms.linux) {
    items.push(`<span class="os-item">${OS_ICONS.linux}<span>Linux</span></span>`);
  } else if (c.proton?.tier) {
    const t = c.proton.tier;
    items.push(`<span class="os-item" title="${c.proton.total || 0} ProtonDB reports">${OS_ICONS.proton}<span>Proton ${esc(t[0].toUpperCase() + t.slice(1))}</span></span>`);
  }
  if (c.platforms.mac) {
    items.push(`<span class="os-item">${OS_ICONS.mac}<span>macOS</span></span>`);
  }
  if (!items.length) return '';

  // host-aware note (Linux launch flow is scaffolded, not shipped)
  let hostNote = '';
  if (hostPlatform === 'linux') {
    hostNote = c.platforms.linux
      ? '<p class="hint">This device runs Linux — native build support is on the roadmap.</p>'
      : '<p class="hint">This device runs Linux — launching via Wine/Proton is on the roadmap.</p>';
  }

  const req = c.requirements || {};
  const reqCol = (label, lines) =>
    lines?.length
      ? `<div class="req-col"><h4>${label}</h4>${lines.map((l) => `<div class="req-line">${esc(l)}</div>`).join('')}</div>`
      : '';
  const reqHtml = (req.minimum?.length || req.recommended?.length)
    ? `<div class="req-grid">${reqCol('Minimum', req.minimum)}${reqCol('Recommended', req.recommended)}</div>`
    : '';

  return `<div class="card-form compat-card">
    <h3>Compatibility</h3>
    <div class="os-row">${items.join('')}</div>
    ${hostNote}
    ${reqHtml}
  </div>`;
}

// ordered media list — trailer first, then screenshots (shared indexing so the
// thumbnail row and the lightbox agree on positions)
function mediaItems(g) {
  const m = parseJson(g.meta_media) || {};
  const items = [];
  if (m.trailer) items.push({ type: 'video', src: m.trailer, thumb: m.trailerThumb || g.meta_hero || '' });
  for (const s of m.screenshots || []) items.push({ type: 'image', src: s });
  return items;
}

function mediaHtml(g) {
  const items = mediaItems(g);
  if (!items.length) return '';
  return `<div class="media-row" data-media-game="${g.id}">
    ${items
      .map((it, i) =>
        it.type === 'video'
          ? `<div class="media-trailer-wrap" data-media-idx="${i}">
              <img src="${esc(it.thumb)}" />
              <div class="playbtn">▶</div>
            </div>`
          : `<img class="media-shot" data-media-idx="${i}" loading="lazy" src="${esc(it.src)}" />`
      )
      .join('')}
  </div>`;
}

// trailer volume/mute is a remembered state (persists across sessions)
function applyVolumeMemory(video) {
  const v = parseFloat(localStorage.getItem('gh_trailer_volume'));
  if (!Number.isNaN(v)) video.volume = Math.max(0, Math.min(1, v));
  if (localStorage.getItem('gh_trailer_muted') === '1') video.muted = true;
  video.addEventListener('volumechange', () => {
    localStorage.setItem('gh_trailer_volume', String(video.volume));
    localStorage.setItem('gh_trailer_muted', video.muted ? '1' : '0');
  });
}

// ---------- media lightbox (Steam-style focused gallery) ----------
const lightbox = { items: [], idx: 0, hls: null, keydown: null, el: null };

function openLightbox(g, startIdx) {
  const items = mediaItems(g);
  if (!items.length) return;
  lightbox.items = items;
  lightbox.idx = Math.max(0, Math.min(startIdx || 0, items.length - 1));
  if (!lightbox.el) {
    const el = document.createElement('div');
    el.className = 'lightbox hidden';
    el.innerHTML = `
      <button class="lb-close" aria-label="Close">✕</button>
      <button class="lb-nav prev" aria-label="Previous">‹</button>
      <div class="lb-stage"></div>
      <button class="lb-nav next" aria-label="Next">›</button>
      <div class="lb-count"></div>
      <div class="lb-strip"></div>`;
    document.body.appendChild(el);
    lightbox.el = el;
    el.querySelector('.lb-close').onclick = closeLightbox;
    el.querySelector('.lb-nav.prev').onclick = () => stepLightbox(-1);
    el.querySelector('.lb-nav.next').onclick = () => stepLightbox(1);
    el.onclick = (ev) => { if (ev.target === el) closeLightbox(); };
  }
  lightbox.el.classList.remove('hidden');
  lightbox.keydown = (ev) => {
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowLeft') stepLightbox(-1);
    else if (ev.key === 'ArrowRight') stepLightbox(1);
  };
  document.addEventListener('keydown', lightbox.keydown);
  renderLightbox();
}

function stepLightbox(d) {
  const n = lightbox.items.length;
  if (!n) return;
  lightbox.idx = (lightbox.idx + d + n) % n;
  renderLightbox();
}

function renderLightbox() {
  const { el, items, idx } = lightbox;
  if (lightbox.hls) { lightbox.hls.destroy(); lightbox.hls = null; }
  const it = items[idx];
  const stage = el.querySelector('.lb-stage');
  if (it.type === 'video') {
    stage.innerHTML = '<video class="lb-video" controls autoplay playsinline></video>';
    const video = stage.querySelector('video');
    applyVolumeMemory(video);
    if (/\.m3u8/.test(it.src) && window.Hls && Hls.isSupported()) {
      lightbox.hls = new Hls();
      lightbox.hls.loadSource(it.src);
      lightbox.hls.attachMedia(video);
    } else {
      video.src = it.src;
    }
    video.play().catch(() => {});
  } else {
    stage.innerHTML = `<img class="lb-img" src="${esc(it.src)}" />`;
  }
  el.querySelector('.lb-count').textContent = `${idx + 1} / ${items.length}`;
  const many = items.length > 1;
  el.querySelector('.lb-nav.prev').classList.toggle('hidden', !many);
  el.querySelector('.lb-nav.next').classList.toggle('hidden', !many);
  el.querySelector('.lb-strip').innerHTML = items
    .map(
      (m, i) => `<div class="lb-thumb${i === idx ? ' on' : ''}" data-lb-thumb="${i}">
        ${m.type === 'video' ? '<span class="lb-thumb-play">▶</span>' : ''}
        <img src="${esc(m.type === 'video' ? m.thumb : m.src)}" />
      </div>`
    )
    .join('');
  el.querySelectorAll('[data-lb-thumb]').forEach((t) => {
    t.onclick = () => { lightbox.idx = parseInt(t.dataset.lbThumb, 10); renderLightbox(); };
  });
}

function closeLightbox() {
  if (lightbox.hls) { lightbox.hls.destroy(); lightbox.hls = null; }
  if (lightbox.keydown) { document.removeEventListener('keydown', lightbox.keydown); lightbox.keydown = null; }
  if (lightbox.el) {
    lightbox.el.classList.add('hidden');
    lightbox.el.querySelector('.lb-stage').innerHTML = '';
  }
}

// Steam's "About This Game" is rich HTML (headings, images, lists). Sanitize
// before rendering: drop scripts/embeds, strip event handlers + javascript:
// URLs. (Links get routed through shell.openExternal via a wire() handler.)
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  tpl.content.querySelectorAll('script,style,iframe,link,meta,object,embed,form,input,button').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}
// Prefer the deep "About This Game"; fall back to the short summary. The long
// version is collapsed (clamped + fade) with a Read-more toggle, Steam-style.
function aboutHtml(g) {
  const full = g.meta_about ? sanitizeHtml(g.meta_about) : '';
  if (full && full.trim()) {
    return `<div class="card-form gp-about about-wrap">
      <h3>About This Game</h3>
      <div class="about-full clamped">${full}</div>
      <button class="about-toggle">Read more ▾</button>
    </div>`;
  }
  if (g.meta_summary) return `<div class="card-form gp-about"><h3>About</h3><p class="detail-summary">${esc(g.meta_summary)}</p></div>`;
  return '';
}

// Show/hide the Read-more toggle based on whether the content actually overflows
// the clamp (re-checks as Steam's images/videos load).
const ABOUT_CLAMP_PX = 420;
function wireAbout(root) {
  root.querySelectorAll('.about-wrap').forEach((wrap) => {
    const box = wrap.querySelector('.about-full');
    const btn = wrap.querySelector('.about-toggle');
    if (!box || !btn) return;
    let userExpanded = false;
    const sync = () => {
      if (userExpanded) return;
      const overflows = box.scrollHeight > ABOUT_CLAMP_PX + 4;
      btn.style.display = overflows ? '' : 'none';
      box.classList.toggle('clamped', overflows);
    };
    btn.onclick = () => {
      const clamped = box.classList.toggle('clamped');
      userExpanded = !clamped;
      btn.textContent = clamped ? 'Read more ▾' : 'Show less ▴';
    };
    sync();
    box.querySelectorAll('img,video').forEach((m) => {
      m.addEventListener('load', sync);
      m.addEventListener('loadedmetadata', sync);
    });
    setTimeout(sync, 900);
  });
}

// Pause the "About This Game" gifs/videos when off-screen or when the window is
// hidden/unfocused (e.g. a game was launched and Gamehub is minimized), so we
// aren't burning CPU/GPU looping clips in the background.
const winActive = () => !document.hidden && document.hasFocus();
let aboutIO = null;
function wireAboutMedia(root) {
  if (aboutIO) { aboutIO.disconnect(); aboutIO = null; }
  const vids = [...root.querySelectorAll('.about-full video')];
  if (!vids.length) return;
  aboutIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      en.target._onscreen = en.isIntersecting;
      if (en.isIntersecting && winActive()) en.target.play().catch(() => {});
      else en.target.pause();
    }
  }, { threshold: 0.01 });
  vids.forEach((v) => aboutIO.observe(v));
}
['visibilitychange', 'blur', 'focus'].forEach((ev) =>
  window.addEventListener(ev, () => {
    const active = winActive();
    document.querySelectorAll('.about-full video').forEach((v) => {
      if (active && v._onscreen) v.play().catch(() => {}); else v.pause();
    });
  })
);

function gamePage(g, { back } = {}) {
  const st = gameState(g);
  const pt = state.playtime[canonOf(g.id)];
  const fav = isFavorite(g.id);
  const heroArt = g.meta_hero || g.meta_cover;
  const packages = packagesOf(g.id); // all downloaded versions of this game

  let primary = '';
  if (st.key === 'busy') {
    const pct = st.task.pct;
    primary = `<div class="detail-progress">
      <div class="progress-bar"><div class="progress-fill${pct == null ? ' indeterminate' : ''}" style="width:${pct ?? 40}%"></div></div>
      <span class="muted">${st.task.phase === 'downloading' ? 'Downloading' : 'Unpacking'}${pct != null ? ` · ${pct}%` : ''} — ${esc(st.task.message || '')}</span>
    </div>`;
  } else if (!inMyLibrary(g.id)) {
    primary = `<button class="btn primary lg" data-act="addToLibrary" data-id="${g.id}">+ Add to Library</button>`;
  } else if (st.key === 'not-installed') {
    primary = `<button class="btn primary lg" data-act="install" data-id="${g.id}">Install</button>`;
  } else if (st.key === 'needs-install') {
    primary = `<button class="btn primary lg" data-act="runInstaller" data-id="${g.id}">▶ Run Installer</button>`;
  } else if (st.key === 'needs-exe') {
    primary = `<button class="btn primary lg" data-act="editEntry" data-id="${g.id}">Select game .exe</button>`;
  } else if (st.key === 'installed') {
    primary = st.playing
      ? `<button class="btn lg in-game" disabled>In game</button>`
      : st.inst.exe
        ? `<button class="btn primary lg play" data-act="play" data-id="${g.id}">▶&nbsp; Play</button>`
        : `<button class="btn lg" data-act="openFolder" data-id="${g.id}">Open folder</button>`;
  }

  const menuItems = [];
  if (inMyLibrary(g.id)) {
    menuItems.push(`<button data-mact="favorite" data-id="${g.id}">${fav ? '★ Remove from favorites' : '☆ Add to favorites'}</button>`);
  }
  if (st.inst?.dir) menuItems.push(`<button data-mact="openFolder" data-id="${g.id}">View local files</button>`);
  if (packages.length > 1 && st.inst) menuItems.push(`<button data-mact="changePackage" data-id="${g.id}">Change version…</button>`);
  if (st.key === 'needs-exe' || st.key === 'installed') {
    menuItems.push(`<button data-mact="editEntry" data-id="${g.id}">Edit entry…</button>`);
    menuItems.push(`<button data-mact="verifyInstall" data-id="${g.id}">Verify / repair installation</button>`);
  }
  if (['installed', 'needs-install', 'needs-exe'].includes(st.key)) {
    menuItems.push(`<button class="danger" data-mact="uninstall" data-id="${g.id}">Uninstall</button>`);
  } else if (inMyLibrary(g.id) && st.key === 'not-installed') {
    menuItems.push(`<button class="danger" data-mact="removeFromLibrary" data-id="${g.id}">Remove from Library</button>`);
  }

  const secs = pt?.seconds || 0;
  const allTimeStr = secs >= 60 ? fmtPlaytime(secs) : secs > 0 ? '< 1 min' : '0 min';
  const lastPlayedStr = fmtWhen(pt?.lastPlayed) || 'Never';

  const newer = newerVersion(g);
  return `<div class="game-page">
    ${back ? `<button class="btn back-btn" data-back="1">← Store</button>` : ''}
    ${newer ? `<div class="ver-alert">
      <span class="ver-alert-txt">🔔 <strong>New version available</strong> — ${esc(newer.label)} was just added to the Store.</span>
      <button class="btn sm" data-pkg-install="${newer.pkg.id}">Update to ${esc(newer.label)}</button>
      <button class="ver-dismiss" data-ver-dismiss="${esc(newer.label)}" data-ver-gid="${canonOf(g.id)}" title="Dismiss">×</button>
    </div>` : ''}
    <div class="detail-hero${back ? '' : ' compact'}">
      ${heroArt ? `<div class="hero-bg" style="background-image:url('${esc(heroArt)}')"></div>` : ''}
      <div class="hero-fade"></div>
      ${menuItems.length
        ? `<div class="menu-wrap gp-hero-menu">
            <button class="btn gp-menu-btn" data-menu="1" title="More">⋯</button>
            <div class="menu hidden">${menuItems.join('')}</div>
          </div>`
        : ''}
      <div class="hero-content gp-hero">
        <div class="gp-hero-main">
          <div class="hero-title-row">
            <div class="hero-title">${esc(titleOf(g))} ${fav ? '<span class="fav-star">★</span>' : ''}</div>
            ${ratingBadges(g.meta_ratings)}
          </div>
          <div class="hero-meta" style="margin-top:10px">
            ${g.meta_year ? `<span class="chip">${g.meta_year}</span>` : ''}
            ${gameGenres(g).slice(0, 4).map((x) => `<button class="chip genre-chip" data-genre="${esc(x)}" title="Browse ${esc(x)} games">${esc(x)}</button>`).join('')}
            <span class="chip">${fmtSize(g.size_bytes)}</span>
          </div>
          ${priceHtml(g) ? `<div class="hero-price">${priceHtml(g)}${steamLinkHtml(g)}</div>` : ''}
        </div>
        <div class="gp-hero-side">
          ${primary}
          ${inMyLibrary(g.id)
            ? `<div class="gp-stats">
                <div class="gp-stat"><span>All time</span><strong>${allTimeStr}</strong></div>
                <div class="gp-stat"><span>Last played</span><strong>${lastPlayedStr}</strong></div>
              </div>`
            : ''}
        </div>
      </div>
    </div>

    ${mediaHtml(g)}
    ${aboutHtml(g)}
    ${compatHtml(g) ? `<div class="gp-about">${compatHtml(g)}</div>` : ''}
    <div class="detail-kv">
      ${g.meta_released ? `<div class="kv"><span class="k">Release date</span><span class="v">${esc(g.meta_released)}</span></div>` : ''}
      <div class="kv"><span class="k">${packages.length > 1 ? 'Versions' : 'Source'}</span><span class="v">${packages.length > 1 ? `${packages.length} downloaded` : esc(g.raw_name)}</span></div>
      <div class="kv"><span class="k">Payload</span><span class="v">${esc((installedPackage(g.id) || g).payload_type)}</span></div>
      ${st.inst?.dir ? `<div class="kv"><span class="k">Installed at</span><span class="v">${esc(st.inst.dir)}</span></div>` : ''}
      ${st.inst?.exe ? `<div class="kv"><span class="k">Executable</span><span class="v">${esc(st.inst.exe)}</span></div>` : ''}
    </div>
    ${versionsSectionHtml(packages, st)}
  </div>`;
}
// Versions block (only when >1 package): newest shown, the rest tucked into a
// collapsible "Older" section (auto-opened if an older version is the installed one).
function versionsSectionHtml(packages, st) {
  if (!packages.length) return '';
  const older = packages.slice(1);
  const installedInOlder = st.inst && older.some((p) => (st.inst.packageId ?? canonOf(p.id)) === p.id);
  return `<div class="gp-versions">
    <div class="section-head"><h2>Versions</h2><span class="muted">${packages.length === 1 ? '1 version' : `${packages.length} versions`}</span></div>
    <div class="version-list">
      ${versionRow(packages[0], packages, st)}
      ${older.length ? `<details class="older-versions"${installedInOlder ? ' open' : ''}>
        <summary>Older versions (${older.length})</summary>
        ${older.map((p) => versionRow(p, packages, st)).join('')}
      </details>` : ''}
    </div>
  </div>`;
}
// one row of the GitHub-releases-style Versions list
function versionRow(p, packages, st) {
  const v = pkgVersion(p);
  const isNewest = p.id === packages[0].id;
  // mark the row installed only when we know which package it is (never guess a
  // legacy/unknown install onto the lowest-id row, which may be an older version)
  const isInstalled = st.inst && st.inst.packageId != null && st.inst.packageId === p.id;
  const anyInstalled = !!st.inst;
  let action;
  if (st.key === 'busy') action = '<span class="muted sm">busy…</span>';
  else if (isInstalled) action = `<button class="btn sm danger" data-mact="uninstall" data-id="${canonOf(p.id)}">Uninstall</button>`;
  else if (anyInstalled) action = `<button class="btn sm" data-pkg-install="${p.id}">Switch to this →</button>`;
  else action = `<button class="btn sm primary" data-pkg-install="${p.id}">Install</button>`;
  return `<div class="version-row${isInstalled ? ' installed' : ''}">
    <div class="version-main">
      <div class="version-label">${esc(v ? v.label : 'Unversioned')}
        ${isNewest ? '<span class="v-badge newest">NEWEST</span>' : ''}
        ${isInstalled ? '<span class="v-badge on">INSTALLED</span>' : ''}
      </div>
      <div class="version-meta">${esc(p.raw_name)} · ${fmtSize(p.size_bytes)}${p.created_at ? ` · added ${fmtWhen(p.created_at) || ''}` : ''}</div>
    </div>
    <div class="version-action">${action}</div>
  </div>`;
}

// ============================================================ library categories
function catState() { return state.categories || { categories: [], collapsed: {} }; }
function gameCategories(gameId) { const c = canonOf(gameId); return catState().categories.filter((cat) => cat.games.includes(c)); }
function isCollapsed(key) { return !!catState().collapsed[key]; }
async function persistCategories() { state.categories = await gh.saveCategories(catState()); }

async function toggleCollapsed(key) {
  const c = catState();
  c.collapsed[key] = !c.collapsed[key];
  await persistCategories();
  render();
}
async function createCategory(name, addGameId) {
  const nm = (name || '').trim();
  if (!nm) return;
  const cat = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), name: nm, games: addGameId ? [canonOf(addGameId)] : [] };
  catState().categories.push(cat);
  await persistCategories();
  toast(`Created “${nm}”`);
  render();
}
async function toggleGameInCategory(catId, gameId) {
  const cat = catState().categories.find((c) => c.id === catId);
  if (!cat) return;
  gameId = canonOf(gameId);
  cat.games = cat.games.includes(gameId) ? cat.games.filter((g) => g !== gameId) : [...cat.games, gameId];
  await persistCategories();
  render();
}
async function renameCategory(catId, name) {
  const cat = catState().categories.find((c) => c.id === catId);
  const nm = (name || '').trim();
  if (!cat || !nm) return;
  cat.name = nm;
  await persistCategories();
  render();
}
async function deleteCategory(catId) {
  const c = catState();
  c.categories = c.categories.filter((x) => x.id !== catId);
  delete c.collapsed[catId];
  await persistCategories();
  render();
}
async function reorderCategories(orderedIds) {
  const c = catState();
  c.categories.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
  await persistCategories();
  render();
}

// ============================================================ library sidebar
function libRow(g, selected) {
  const st = gameState(g);
  const installed = st.key === 'installed';
  // when the game has multiple versions, show which one is installed (light grey)
  const instPkg = st.inst ? installedPackage(g.id) : null;
  const ver = instPkg && packagesOf(g.id).length > 1 ? pkgVersion(instPkg) : null;
  return `<div class="lib-row${selected ? ' selected' : ''}${installed ? '' : ' dim'}" data-select="${g.id}" data-gid="${g.id}">
    ${g.meta_cover
      ? `<div class="lib-thumb" style="background-image:url('${esc(g.meta_cover)}')"></div>`
      : `<div class="lib-thumb text">${esc(titleOf(g).slice(0, 1))}</div>`}
    <span class="lib-name">${esc(titleOf(g))}</span>
    ${ver ? `<span class="lib-ver" title="Installed version">${esc(ver.label)}</span>` : ''}
    ${newerVersion(g) ? '<span class="lib-new" title="New version available">↑</span>' : ''}
    ${isFavorite(g.id) ? '<span class="lib-fav">★</span>' : ''}
    ${st.key === 'busy' ? '<span class="lib-busy">⬇</span>' : ''}
  </div>`;
}

// opts: { key (collapse memory), cat (custom category → draggable + editable) }
function libGroup(label, games, selectedId, opts = {}) {
  const { key, cat } = opts;
  if (games.length === 0 && !cat) return '';
  const collapsed = key ? isCollapsed(key) : false;
  return `<div class="lib-group${collapsed ? ' collapsed' : ''}"${cat ? ` data-cat="${cat.id}"` : ''}>
    <div class="lib-group-head${cat ? ' cat-head' : ''}" ${key ? `data-collapse="${key}"` : ''}${cat ? ' draggable="true"' : ''}>
      <span class="lib-group-chevron">▾</span>
      <span class="lib-group-label">${esc(label)}</span>
      <span class="lib-group-count">${games.length}</span>
      ${cat ? `<button class="lib-group-menu" data-catmenu="${cat.id}" title="Category options">⋯</button>` : ''}
    </div>
    <div class="lib-group-games">
      ${games.length ? games.map((g) => libRow(g, g.id === selectedId)).join('')
        : '<div class="lib-group-empty">Right-click a game → Add to Category</div>'}
    </div>
  </div>`;
}

// ---------- category name prompt + per-category menu ----------
function closeContextMenus() { document.querySelectorAll('.ctx-menu').forEach((m) => m.remove()); }

function placeMenu(menu, x, y) {
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

// small modal to name/rename a category → resolves to the trimmed name or null
function askName(title, initial = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `<div class="modal-box" style="width:360px">
      <h2>${esc(title)}</h2>
      <input class="ask-input" type="text" placeholder="Category name" maxlength="60" />
      <div class="modal-actions"><button class="btn ask-cancel">Cancel</button><button class="btn primary ask-ok">Save</button></div>
    </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('.ask-input');
    input.value = initial;
    input.focus();
    input.select();
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('.ask-cancel').onclick = () => done(null);
    ov.querySelector('.ask-ok').onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); else if (e.key === 'Escape') done(null); };
    ov.onmousedown = (e) => { if (e.target === ov) done(null); };
  });
}

function openCategoryMenu(btn, catId) {
  closeContextMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `<button data-a="rename">Rename…</button><button class="danger" data-a="delete">Delete category</button>`;
  const r = btn.getBoundingClientRect();
  placeMenu(menu, r.left, r.bottom + 4);
  menu.querySelector('[data-a="rename"]').onclick = async () => {
    closeContextMenus();
    const cat = catState().categories.find((c) => c.id === catId);
    const name = await askName('Rename category', cat?.name || '');
    if (name) renameCategory(catId, name);
  };
  menu.querySelector('[data-a="delete"]').onclick = () => { closeContextMenus(); deleteCategory(catId); };
}

// HTML5 drag to reorder categories (grab the category header)
function wireCategoryDrag(root) {
  let dragId = null;
  root.querySelectorAll('.lib-group[data-cat]').forEach((grp) => {
    const head = grp.querySelector('.cat-head');
    if (!head) return;
    head.addEventListener('dragstart', (e) => {
      dragId = grp.dataset.cat;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      grp.classList.add('dragging');
    });
    head.addEventListener('dragend', () => {
      grp.classList.remove('dragging');
      root.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
      dragId = null;
    });
    grp.addEventListener('dragover', (e) => { if (dragId && dragId !== grp.dataset.cat) { e.preventDefault(); grp.classList.add('drop-target'); } });
    grp.addEventListener('dragleave', (e) => { if (!grp.contains(e.relatedTarget)) grp.classList.remove('drop-target'); });
    grp.addEventListener('drop', (e) => {
      e.preventDefault();
      grp.classList.remove('drop-target');
      const src = dragId || e.dataTransfer.getData('text/plain');
      if (!src || src === grp.dataset.cat) return;
      const ids = [...root.querySelectorAll('.lib-group[data-cat]')].map((x) => x.dataset.cat);
      const from = ids.indexOf(src), to = ids.indexOf(grp.dataset.cat);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      reorderCategories(ids);
    });
  });
}

// ============================================================ profile + social
function fmtHours(seconds) {
  if (!seconds) return '0 min';
  const h = seconds / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.max(1, Math.round(seconds / 60))} min`;
}
const FRAME_LABEL = { week: 'this week', allTime: 'all time' };
// a stable, pleasant colour per name for the fallback (no-picture) avatar
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 40%)`;
}
function avatarHtml(user, size = 40) {
  const dim = `width:${size}px;height:${size}px`;
  if (user && user.avatar) return `<div class="pfp" style="${dim}"><img src="${esc(user.avatar)}" alt="" /></div>`;
  const name = (user && user.username) || '?';
  return `<div class="pfp fallback" style="${dim};font-size:${Math.round(size * 0.42)}px;background:${avatarColor(name)}">${esc(name.slice(0, 1).toUpperCase())}</div>`;
}
function setAccountAvatar(avatar) {
  const btn = $('#account-btn');
  if (!btn) return;
  if (avatar) { btn.style.backgroundImage = `url('${avatar}')`; btn.classList.add('has-avatar'); }
  else { btn.style.backgroundImage = ''; btn.classList.remove('has-avatar'); }
}

let socialPollTimer = null;
function stopSocialPoll() { if (socialPollTimer) { clearInterval(socialPollTimer); socialPollTimer = null; } }
async function loadSocial() {
  switchView('social');
  state.social = null; render();
  try { state.social = await gh.leaderboard(); }
  catch (e) { state.social = { error: /401/.test(e.message) ? 'auth' : e.message }; }
  if (state.view !== 'social') return;
  render();
  // keep "now playing" fresh while the tab is open (presence has a short TTL)
  stopSocialPoll();
  socialPollTimer = setInterval(async () => {
    if (state.view !== 'social') { stopSocialPoll(); return; }
    try { const fresh = await gh.leaderboard(); if (state.view === 'social') { state.social = fresh; render(); } } catch { /* keep last */ }
  }, 30000);
}
async function loadProfile(userId = null) {
  state.profileUserId = userId;
  switchView('profile');
  state.profile = null; render();
  try { state.profile = userId ? await gh.userStats(userId) : await gh.myStats(); }
  catch (e) { state.profile = { error: /401/.test(e.message) ? 'auth' : e.message }; }
  if (state.view !== 'profile') return;
  const p = state.profile;
  $('#page-title').textContent = p && p.username && !p.me ? p.username : 'My Profile';
  if (p && p.me) setAccountAvatar(p.avatar); // keep the account chip in sync
  render();
}

// upload flow: pick → crop/zoom in a modal → data URL → server
async function pickAvatar() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      const dataUrl = await cropAvatar(file);
      if (!dataUrl) return; // cancelled
      const res = await gh.setAvatar(dataUrl);
      setAccountAvatar(res.avatar);
      state.social = null; // the leaderboard's avatars are now stale
      toast('Profile picture updated');
      if (state.view === 'profile') loadProfile(state.profileUserId);
    } catch (e) { toast(e.message || 'Could not update picture', true); }
  };
  inp.click();
}
// interactive square-crop (pan + zoom) → 128px JPEG data URL, or null if cancelled
function cropAvatar(file) {
  return new Promise((resolve) => {
    if (!/^image\//.test(file.type)) { toast('Please choose an image file', true); return resolve(null); }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image', true); resolve(null); };
    img.onload = () => {
      const V = 300, OUT = 128;
      const overlay = document.createElement('div');
      overlay.className = 'crop-overlay';
      overlay.innerHTML = `
        <div class="crop-box">
          <h2>Position your picture</h2>
          <p class="crop-hint">Drag to move · scroll or use the slider to zoom</p>
          <div class="crop-stage" style="width:${V}px;height:${V}px">
            <canvas width="${V}" height="${V}"></canvas>
            <div class="crop-ring"></div>
          </div>
          <input class="crop-zoom" type="range" min="1" max="4" step="0.01" value="1" />
          <div class="crop-actions">
            <button class="btn crop-cancel">Cancel</button>
            <button class="btn primary crop-ok">Set picture</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const ctx = overlay.querySelector('canvas').getContext('2d');
      const zoom = overlay.querySelector('.crop-zoom');
      const base = Math.max(V / img.width, V / img.height); // cover the viewport at min zoom
      let scale = base, ox = (V - img.width * base) / 2, oy = (V - img.height * base) / 2;
      const draw = () => {
        const dw = img.width * scale, dh = img.height * scale;
        ox = Math.min(0, Math.max(V - dw, ox));
        oy = Math.min(0, Math.max(V - dh, oy));
        ctx.clearRect(0, 0, V, V);
        ctx.drawImage(img, ox, oy, dw, dh);
      };
      const setZoom = (z, cx = V / 2, cy = V / 2) => {
        const ns = base * z;
        ox = cx - (cx - ox) * (ns / scale);
        oy = cy - (cy - oy) * (ns / scale);
        scale = ns; draw();
      };
      zoom.oninput = () => setZoom(parseFloat(zoom.value));
      const stage = overlay.querySelector('.crop-stage');
      let dragging = false, lx = 0, ly = 0;
      stage.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; stage.setPointerCapture(e.pointerId); });
      stage.addEventListener('pointermove', (e) => { if (!dragging) return; ox += e.clientX - lx; oy += e.clientY - ly; lx = e.clientX; ly = e.clientY; draw(); });
      stage.addEventListener('pointerup', () => { dragging = false; });
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const z = Math.min(4, Math.max(1, parseFloat(zoom.value) - e.deltaY * 0.0012));
        zoom.value = z;
        const r = stage.getBoundingClientRect();
        setZoom(z, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      draw();
      const cleanup = () => { overlay.remove(); URL.revokeObjectURL(url); };
      const cancel = () => { cleanup(); resolve(null); };
      overlay.querySelector('.crop-cancel').onclick = cancel;
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cancel(); });
      overlay.querySelector('.crop-ok').onclick = () => {
        const out = document.createElement('canvas'); out.width = OUT; out.height = OUT;
        const k = OUT / V;
        out.getContext('2d').drawImage(img, ox * k, oy * k, img.width * scale * k, img.height * scale * k);
        const dataUrl = out.toDataURL('image/jpeg', 0.85);
        cleanup(); resolve(dataUrl);
      };
    };
    img.src = url;
  });
}

function renderSocialHtml() {
  const s = state.social;
  if (s === null) return '<div class="empty">Loading…</div>';
  if (s.error === 'auth') return '<div class="empty">Sign in to see what everyone on your server is playing.</div>';
  if (s.error) return `<div class="empty">${esc(s.error)}</div>`;
  const users = s.users || [];
  if (!users.length) return '<div class="empty">No playtime recorded yet — play a game to get on the board! 🎮</div>';
  const frame = state.socialFrame;
  const label = FRAME_LABEL[frame];
  const players = [...users].sort((a, b) => (b[frame].total - a[frame].total) || (b.allTime.total - a.allTime.total))
    .filter((u) => u[frame].total > 0);
  const games = (s.games && s.games[frame]) || [];
  // a status line shows ONLY when a player is actually in a game right now —
  // never a game they merely played this week (that read as misleading)
  const playerRow = (u, i) => `<div class="social-row${u.me ? ' me' : ''}" data-profile="${u.id}">
      <div class="social-rank r${i + 1}">${i + 1}</div>
      ${avatarHtml(u, 42)}
      <div class="social-user">
        <div class="social-name">${esc(u.username)}${u.me ? ' <span class="muted">(you)</span>' : ''}</div>
        ${u.playing ? `<div class="social-sub"><span class="live-dot"></span>playing <strong data-open2="${u.playing.id}">${esc(u.playing.title)}</strong></div>` : ''}
      </div>
      <div class="social-hours"><b>${fmtHours(u[frame].total)}</b><span>${label}</span></div>
    </div>`;
  const gameRow = (g, i) => `<div class="social-row game" data-open="${g.id}">
      <div class="social-rank r${i + 1}">${i + 1}</div>
      ${g.cover ? `<div class="social-cover" style="background-image:url('${esc(g.cover)}')"></div>` : '<div class="social-cover"></div>'}
      <div class="social-user">
        <div class="social-name">${esc(g.title)}</div>
        <div class="social-sub">${g.players} player${g.players === 1 ? '' : 's'}</div>
      </div>
      <div class="social-hours"><b>${fmtHours(g.seconds)}</b><span>${label}</span></div>
    </div>`;
  return `
    <div class="social-toggle">
      <button class="seg${frame === 'week' ? ' on' : ''}" data-frame="week">This week</button>
      <button class="seg${frame === 'allTime' ? ' on' : ''}" data-frame="allTime">All time</button>
    </div>
    <div class="social-cols">
      <div class="social-col">
        <div class="section-head"><h2>Top players</h2><span class="muted">${label}</span></div>
        <div class="social-list">${players.length ? players.map(playerRow).join('') : `<div class="empty small">No playtime ${label}.</div>`}</div>
      </div>
      <div class="social-col">
        <div class="section-head"><h2>Top games</h2><span class="muted">${label}</span></div>
        <div class="social-list">${games.length ? games.map(gameRow).join('') : `<div class="empty small">Nothing played ${label}.</div>`}</div>
      </div>
    </div>`;
}

function renderProfileHtml() {
  const p = state.profile;
  if (p === null) return '<div class="empty">Loading…</div>';
  if (p.error === 'auth') return '<div class="empty">Sign in to see profiles and stats.</div>';
  if (p.error) return `<div class="empty">${esc(p.error)}</div>`;
  const all = p.games || [];
  const sort = state.profileSort;
  const games = [...all].sort(
    sort === 'name' ? (a, b) => (a.meta_title || a.clean_name).localeCompare(b.meta_title || b.clean_name)
    : sort === 'recent' ? (a, b) => (b.last_played || '').localeCompare(a.last_played || '')
    : (a, b) => b.seconds - a.seconds
  );
  const top = [...all].sort((a, b) => b.seconds - a.seconds).slice(0, 4);
  const mostPlayed = top[0] ? (top[0].meta_title || top[0].clean_name) : '—';
  return `
    ${!p.me ? '<button class="btn back-btn" data-social-back="1">← Social</button>' : ''}
    <div class="profile-hero${p.playing ? ' live' : ''}">
      ${avatarHtml(p, 88)}
      <div class="profile-id">
        <h2 class="profile-username">${esc(p.username)}${p.me ? ' <span class="muted">(you)</span>' : ''}</h2>
        ${p.playing ? `<div class="profile-playing"><span class="live-dot"></span>playing <strong data-open="${p.playing.id}">${esc(p.playing.title)}</strong></div>` : ''}
        ${p.me ? `<button class="btn sm" id="avatar-edit">${p.avatar ? 'Change' : 'Add'} picture</button>` : ''}
      </div>
    </div>
    <div class="profile-head">
      <div class="profile-stat"><strong>${fmtHours(p.totalSeconds)}</strong><span>Total playtime</span></div>
      <div class="profile-stat"><strong>${all.length}</strong><span>Games played</span></div>
      <div class="profile-stat"><strong>${esc(mostPlayed)}</strong><span>Most played</span></div>
    </div>
    ${all.length === 0 ? `<div class="empty">${p.me ? 'No playtime yet — launch a game from your library to start tracking. 🎮' : 'No games played yet.'}</div>` : `
      ${top.length ? `<div class="section-head"><h2>Top played</h2></div>
        <div class="card-rail">${top.map(profileTopCard).join('')}</div>` : ''}
      <div class="section-head"><h2>All played games</h2>
        <span class="profile-sort">Sort:
          <button class="sort-btn${sort === 'seconds' ? ' on' : ''}" data-sort="seconds">Playtime</button>
          <button class="sort-btn${sort === 'recent' ? ' on' : ''}" data-sort="recent">Recent</button>
          <button class="sort-btn${sort === 'name' ? ' on' : ''}" data-sort="name">Name</button>
        </span>
      </div>
      <div class="played-list">${games.map(playedRow).join('')}</div>`}`;
}
function profileTopCard(g) {
  return `<div class="card" data-open="${g.id}">
    ${g.meta_cover ? `<div class="cover" style="background-image:url('${esc(g.meta_cover)}')"><img class="cover-fg" src="${esc(g.meta_cover)}" alt="" onload="coverFit(this)" /></div>` : `<div class="cover text-cover"><span>${esc(g.meta_title || g.clean_name)}</span></div>`}
    <div class="info"><div class="title" title="${esc(g.meta_title || g.clean_name)}">${esc(g.meta_title || g.clean_name)}</div><div class="sub">${fmtHours(g.seconds)}</div></div>
  </div>`;
}
function playedRow(g) {
  return `<div class="played-row" data-open="${g.id}">
    ${g.meta_cover ? `<div class="played-cover" style="background-image:url('${esc(g.meta_cover)}')"></div>` : `<div class="played-cover text">${esc((g.meta_title || g.clean_name).slice(0, 1))}</div>`}
    <span class="played-name">${esc(g.meta_title || g.clean_name)}</span>
    <span class="played-when">${g.last_played ? (fmtWhen(g.last_played) || '') : ''}</span>
    <span class="played-hours">${fmtHours(g.seconds)}</span>
  </div>`;
}

// ============================================================ render
let lastPageKey = null; // which logical page main is showing (for scroll reset)
function render() {
  try {
    renderInner();
  } catch (err) {
    // a render exception must never leave the UI dead
    console.error('render failed:', err);
    toast(`Render error: ${err.message}`, true);
  }
}
function renderInner() {
  const q = ($('#search').value || '').toLowerCase();
  const main = $('#main-content');
  const matches = (g) => !q || titleOf(g).toLowerCase().includes(q);

  const badge = $('#lib-badge');
  // one row per logical game (a group's canonical id) — duplicate packages collapse
  const libGames = state.games.filter((g) => isCanon(g) && inMyLibrary(g.id));
  badge.textContent = libGames.length;
  badge.classList.toggle('hidden', libGames.length === 0);

  if (!loaded) {
    main.innerHTML = `<div class="grid">${Array.from({ length: 8 }, () =>
      `<div class="skeleton"><div class="sk-cover sk"></div><div class="sk-line sk" style="width:70%"></div><div class="sk-line sk" style="width:40%"></div></div>`
    ).join('')}</div>`;
    return;
  }

  if (state.view === 'game') {
    const g = byId(state.gamePageId);
    main.innerHTML = g ? gamePage(g, { back: true }) : '<div class="empty">Game not found.</div>';
  } else if (state.view === 'social') {
    main.innerHTML = renderSocialHtml();
  } else if (state.view === 'profile') {
    main.innerHTML = renderProfileHtml();
  } else if (state.view === 'store') {
    // owned games stay out of the storefront (search still finds them) —
    // EXCEPT ones added this session, which linger as "✓ In Library"
    const pool = (q
      ? state.games.filter(matches)
      : state.games.filter((g) => !inMyLibrary(g.id) || sessionAdded.has(g.id))
    ).filter(isCanon); // collapse duplicate packages to one card per game
    const filter = state.storeFilter;
    if (q || filter) {
      // ---- results mode: a search, a genre, or the "outstanding reviews" filter ----
      let list, title, kicker;
      if (q) { list = pool; title = 'Search results'; kicker = `“${q}”`; }
      else if (filter.type === 'genre') { list = pool.filter((g) => hasGenre(g, filter.value)); title = filter.value; kicker = 'genre'; }
      else { list = pool.filter((g) => (reviewPct(g) ?? -1) >= OUTSTANDING_PCT); title = 'Top rated'; kicker = `${OUTSTANDING_PCT}%+ rated`; }
      const sorted = sortGames(list, state.storeSort);
      main.innerHTML = `
        <div class="results-head">
          <button class="btn back-btn" data-store-clear="1">← Store</button>
          <div class="results-title"><h2>${esc(title)}</h2><span class="muted">${esc(kicker)} · ${sorted.length} game${sorted.length === 1 ? '' : 's'}</span></div>
          ${sortControlHtml()}
        </div>
        <div class="grid">${sorted.length ? sorted.map(storeCard).join('') : `<div class="empty">${q ? 'Nothing matches your search.' : 'No games in this section yet.'}</div>`}</div>`;
    } else {
      // ---- curated mode: hero + browse shortcuts + themed rails + sortable grid ----
      const newReleases = pool.filter(isNewRelease).sort((a, b) => releasedAt(b) - releasedAt(a)).slice(0, 12);
      const recentlyAdded = pool.filter((g) => isNew(g) && !isNewRelease(g)).sort((a, b) => addedAt(b) - addedAt(a)).slice(0, 12);
      const outstanding = pool.filter((g) => (reviewPct(g) ?? -1) >= OUTSTANDING_PCT).sort((a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1)).slice(0, 12);
      const genres = topGenres(pool, 12);
      const genreRails = genres.slice(0, 3)
        .map((gn) => ({ name: gn, games: pool.filter((g) => hasGenre(g, gn)).sort((a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1)).slice(0, 12) }))
        .filter((r) => r.games.length >= 3);
      const allSorted = sortGames(pool, state.storeSort);
      const rail = (heading, seeAllAttr, games) => `
        <div class="section-head"><h2>${esc(heading)}</h2>${seeAllAttr ? `<button class="see-all" ${seeAllAttr}>See all →</button>` : ''}</div>
        <div class="card-rail">${games.map(storeCard).join('')}</div>`;
      main.innerHTML = `
        <div id="hero-slot"></div>
        ${genres.length ? `<div class="browse-bar">
          <button class="browse-pill" data-filter="reviews">Top rated</button>
          ${genres.map((gn) => `<button class="browse-pill" data-genre="${esc(gn)}">${esc(gn)}</button>`).join('')}
        </div>` : ''}
        ${newReleases.length ? rail('New Releases', '', newReleases) : ''}
        ${recentlyAdded.length ? rail('Recently added', '', recentlyAdded) : ''}
        ${outstanding.length ? rail('Top rated', 'data-filter="reviews"', outstanding) : ''}
        ${genreRails.map((r) => rail(r.name, `data-genre="${esc(r.name)}"`, r.games)).join('')}
        <div class="section-head"><h2>All games</h2><span class="muted">${pool.length} game${pool.length === 1 ? '' : 's'}</span>${sortControlHtml()}</div>
        <div class="grid">${pool.length ? allSorted.map(storeCard).join('') : '<div class="empty">Everything on the server is already in your library. 🎉</div>'}</div>`;
      renderHeroSlot();
    }
  } else {
    // library: Steam-style split — grouped title list + game page
    const list = libGames.filter(matches).sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    if (!list.find((g) => g.id === state.selectedLib)) {
      state.selectedLib = (list.find((g) => isFavorite(g.id)) || list.find((g) => gameState(g).key === 'installed') || list[0])?.id ?? null;
    }
    const cats = catState().categories;
    const favs = list.filter((g) => isFavorite(g.id));
    // a game is "uncategorized" if it's in no custom category (favorites are separate)
    const uncategorized = list.filter((g) => !cats.some((c) => c.games.includes(g.id)));
    const selected = byId(state.selectedLib);
    main.innerHTML = `
      <div class="lib-split">
        <aside class="lib-list">
          ${list.length === 0 ? `<div class="empty small">${q ? 'No matches.' : 'Nothing here yet — add games from the Store.'}</div>` : ''}
          ${libGroup('★ Favorites', favs, state.selectedLib, { key: 'fav' })}
          ${cats.map((c) => libGroup(c.name, list.filter((g) => c.games.includes(g.id)), state.selectedLib, { key: c.id, cat: c })).join('')}
          ${uncategorized.length ? libGroup(cats.length || favs.length ? 'Uncategorized' : 'All games', uncategorized, state.selectedLib, { key: 'uncat' }) : ''}
        </aside>
        <div class="lib-main">
          ${selected ? gamePage(selected, { back: false }) : '<div class="empty">Select a game.</div>'}
        </div>
      </div>`;
  }

  // main is a persistent scroll container now (the header stays fixed above it),
  // so replacing its innerHTML no longer resets scroll. Snap to top when the
  // logical page changes (view switch or a different game selected) but NOT on
  // in-place re-renders — a download-progress tick must hold its scroll spot.
  const pageKey = state.view === 'game' ? `game:${state.gamePageId}`
    : state.view === 'library' ? `lib:${state.selectedLib}`
    : state.view === 'social' ? 'social'
    : state.view === 'profile' ? `profile:${state.profileUserId || 'me'}`
    : 'store';
  if (pageKey !== lastPageKey) { main.scrollTop = 0; lastPageKey = pageKey; }

  wire(main);
  wireAbout(main);
  wireAboutMedia(main);
}

function wire(root) {
  root.querySelectorAll('[data-dot]').forEach((dot) => {
    dot.onclick = (ev) => {
      ev.stopPropagation();
      state.heroIdx = parseInt(dot.dataset.dot, 10);
      renderHeroSlot();
    };
  });
  root.querySelectorAll('[data-hero-nav]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const n = heroPool().length;
      if (n) { state.heroIdx = (state.heroIdx + parseInt(btn.dataset.heroNav, 10) + n) % n; renderHeroSlot(); }
    };
  });
  root.querySelectorAll('[data-external]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); gh.openExternal(el.dataset.external); };
  });
  root.querySelectorAll('.about-full a[href]').forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); const href = a.getAttribute('href'); if (/^https?:/i.test(href)) gh.openExternal(href); };
  });
  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = (ev) => { ev.stopPropagation(); doAction(btn.dataset.act, parseInt(btn.dataset.id, 10)); };
  });
  root.querySelectorAll('[data-mact]').forEach((btn) => {
    btn.onclick = (ev) => { ev.stopPropagation(); closeMenus(); doAction(btn.dataset.mact, parseInt(btn.dataset.id, 10)); };
  });
  // Versions list: install / switch to a specific package
  root.querySelectorAll('[data-pkg-install]').forEach((btn) => {
    btn.onclick = (ev) => { ev.stopPropagation(); installPackage(parseInt(btn.dataset.pkgInstall, 10)); };
  });
  // dismiss a "new version available" alert
  root.querySelectorAll('[data-ver-dismiss]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); dismissVersion(parseInt(el.dataset.verGid, 10), el.dataset.verDismiss); render(); };
  });
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => openGamePage(parseInt(el.dataset.open, 10));
  });
  root.querySelectorAll('[data-open2]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openGamePage(parseInt(el.dataset.open2, 10)); };
  });
  root.querySelectorAll('[data-select]').forEach((el) => {
    el.onclick = () => { state.selectedLib = parseInt(el.dataset.select, 10); render(); };
  });
  // library categories: collapse, context menu, new-category, per-category menu, drag-reorder
  root.querySelectorAll('[data-collapse]').forEach((head) => {
    head.onclick = (ev) => { if (ev.target.closest('[data-catmenu]')) return; toggleCollapsed(head.dataset.collapse); };
  });
  root.querySelectorAll('[data-catmenu]').forEach((btn) => {
    btn.onclick = (ev) => { ev.stopPropagation(); openCategoryMenu(btn, btn.dataset.catmenu); };
  });
  wireCategoryDrag(root);
  root.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => { state.profileSort = b.dataset.sort; render(); };
  });
  // store discovery: genre chips/pills, the reviews filter, sort, and clear
  root.querySelectorAll('[data-genre]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      state.storeFilter = { type: 'genre', value: el.dataset.genre };
      state.storeSort = 'featured';
      if (state.view === 'store') { $('#search').value = ''; render(); } else switchView('store');
    };
  });
  root.querySelectorAll('[data-filter="reviews"]').forEach((el) => {
    el.onclick = () => {
      state.storeFilter = { type: 'reviews' };
      state.storeSort = 'featured';
      if (state.view === 'store') { $('#search').value = ''; render(); } else switchView('store');
    };
  });
  root.querySelectorAll('[data-storesort]').forEach((b) => {
    b.onclick = () => { state.storeSort = b.dataset.storesort; render(); };
  });
  root.querySelectorAll('[data-store-clear]').forEach((el) => {
    el.onclick = () => { state.storeFilter = null; $('#search').value = ''; render(); };
  });
  root.querySelectorAll('[data-frame]').forEach((b) => {
    b.onclick = () => { state.socialFrame = b.dataset.frame; render(); };
  });
  root.querySelectorAll('[data-profile]').forEach((el) => {
    el.onclick = () => loadProfile(parseInt(el.dataset.profile, 10));
  });
  root.querySelectorAll('[data-social-back]').forEach((el) => {
    el.onclick = () => {
      state.profileUserId = null;
      if (state.social) { state.view = 'social'; $('#page-title').textContent = 'Social'; render(); }
      else loadSocial();
    };
  });
  const avatarBtn = root.querySelector('#avatar-edit');
  if (avatarBtn) avatarBtn.onclick = pickAvatar;
  root.querySelectorAll('[data-back]').forEach((el) => {
    el.onclick = () => switchView('store');
  });
  root.querySelectorAll('[data-media-idx]').forEach((el) => {
    el.onclick = () => {
      const row = el.closest('[data-media-game]');
      const g = row && byId(parseInt(row.dataset.mediaGame, 10));
      if (g) openLightbox(g, parseInt(el.dataset.mediaIdx, 10));
    };
  });
  root.querySelectorAll('[data-menu]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const menu = el.parentElement.querySelector('.menu');
      const wasHidden = menu.classList.contains('hidden');
      closeMenus();
      menu.classList.toggle('hidden', !wasHidden);
    };
  });
  // right-click context menus on store cards and library rows
  root.querySelectorAll('.card[data-open], .lib-row[data-select]').forEach((el) => {
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const id = parseInt(el.dataset.open ?? el.dataset.select, 10);
      showCtxMenu(ev.clientX, ev.clientY, id);
    });
  });
  attachHoverPreviews(root);
}
function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
  document.querySelector('.ctx-menu')?.remove();
}
document.addEventListener('click', closeMenus);

// ============================================================ context menu
function ctxItemsFor(g) {
  const st = gameState(g);
  const items = [{ label: 'View page', act: 'openDetail' }];
  if (!inMyLibrary(g.id)) {
    items.push({ label: '+ Add to Library', act: 'addToLibrary' });
    return items;
  }
  if (st.key === 'installed' && st.inst.exe) items.unshift({ label: '▶ Play', act: 'play' });
  // (no "Install" here — the primary button handles install, with its location picker)
  if (st.key === 'needs-install') items.push({ label: 'Run Installer', act: 'runInstaller' });
  if (st.key === 'needs-exe') items.push({ label: 'Select game .exe', act: 'editEntry' });
  if (st.key === 'installed') items.push({ label: 'Edit entry…', act: 'editEntry' });
  if (st.key === 'installed' || st.key === 'needs-exe') {
    items.push({ label: 'Verify / repair installation', act: 'verifyInstall' });
  }
  items.push({ label: isFavorite(g.id) ? '★ Remove from favorites' : '☆ Add to favorites', act: 'favorite' });
  // Steam-style collections: "Add to…" opens a submenu of categories (+ Create new)
  items.push({ label: 'Add to', submenu: 'category' });
  // multiple downloaded versions → quick-switch which one is installed
  if (st.inst && packagesOf(g.id).length > 1) items.push({ label: 'Change version', submenu: 'version' });
  items.push({ sep: true });
  if (st.inst?.dir) items.push({ label: 'View local files', act: 'openFolder' });
  if (['installed', 'needs-install', 'needs-exe'].includes(st.key)) {
    items.push({ label: 'Uninstall', act: 'uninstall', danger: true });
  } else {
    items.push({ label: 'Remove from Library', act: 'removeFromLibrary', danger: true });
  }
  return items;
}

function showCtxMenu(x, y, gameId) {
  closeMenus();
  const g = byId(gameId);
  if (!g) return;
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  const items = ctxItemsFor(g);
  el.innerHTML = items
    .map((it, i) => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      if (it.header) return `<div class="ctx-label">${esc(it.label)}</div>`;
      if (it.submenu) return `<button data-sub="${i}" class="ctx-parent">${esc(it.label)}<span class="ctx-arrow">▸</span></button>`;
      return `<button data-ci="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`;
    })
    .join('');
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  el.querySelectorAll('[data-ci]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      el.remove();
      doAction(items[btn.dataset.ci].act, gameId);
    };
  });
  // "Add to…" opens a category submenu on hover. The close timer is shared
  // between the parent button and the submenu so moving the cursor across the
  // gap (diagonal travel) onto the submenu cancels the pending close instead of
  // it vanishing mid-travel.
  let subTimer;
  const cancelSubClose = () => clearTimeout(subTimer);
  const scheduleSubClose = () => {
    clearTimeout(subTimer);
    subTimer = setTimeout(() => el.querySelector('.ctx-submenu')?.remove(), 400);
  };
  el.querySelectorAll('[data-sub]').forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      cancelSubClose();
      if (el.querySelector('.ctx-submenu')) return;
      const opener = items[btn.dataset.sub].submenu === 'version' ? openVersionSubmenu : openCategorySubmenu;
      opener(el, btn, gameId, cancelSubClose, scheduleSubClose);
    });
    btn.addEventListener('mouseleave', scheduleSubClose);
  });
}
// submenu that switches which downloaded version is installed (checkmark = current)
function openVersionSubmenu(parentMenu, anchorBtn, gameId, cancelClose, scheduleClose) {
  parentMenu.querySelectorAll('.ctx-submenu').forEach((s) => s.remove());
  const packages = packagesOf(gameId);
  const st = gameState(byId(canonOf(gameId)) || { id: gameId });
  const instId = st.inst && st.inst.packageId != null ? st.inst.packageId : null;
  const sub = document.createElement('div');
  sub.className = 'ctx-menu ctx-submenu';
  sub.innerHTML = packages.map((p) => {
    const v = pkgVersion(p);
    return `<button class="ctx-check" data-switchpkg="${p.id}"><span class="ctx-box">${p.id === instId ? '✓' : ''}</span>${esc(v ? v.label : 'Unversioned')}${p.id === packages[0].id ? ' <span class="ctx-dim">newest</span>' : ''}</button>`;
  }).join('');
  parentMenu.appendChild(sub);
  const ar = anchorBtn.getBoundingClientRect();
  const sr = sub.getBoundingClientRect();
  let left = ar.right - 2;
  if (left + sr.width > window.innerWidth - 8) left = ar.left - sr.width + 2;
  sub.style.left = (left - parentMenu.getBoundingClientRect().left) + 'px';
  sub.style.top = (ar.top - parentMenu.getBoundingClientRect().top - 4) + 'px';
  sub.addEventListener('mouseenter', cancelClose);
  sub.addEventListener('mouseleave', scheduleClose);
  sub.querySelectorAll('[data-switchpkg]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      closeMenus();
      const pkgId = parseInt(b.dataset.switchpkg, 10);
      if (pkgId !== instId) installPackage(pkgId); // opens the switch dialog for that version
    };
  });
}

// submenu of the user's categories (click adds the game) + Create new.
// cancelClose/scheduleClose are the parent's shared timer controls so hovering
// the submenu keeps it (and the parent menu) open.
function openCategorySubmenu(parentMenu, anchorBtn, gameId, cancelClose, scheduleClose) {
  parentMenu.querySelectorAll('.ctx-submenu').forEach((s) => s.remove());
  const cats = catState().categories;
  const sub = document.createElement('div');
  sub.className = 'ctx-menu ctx-submenu';
  sub.innerHTML = `
    ${cats.length ? cats.map((c) => `<button class="ctx-check" data-cat="${c.id}"><span class="ctx-box">${c.games.includes(gameId) ? '✓' : ''}</span>${esc(c.name)}</button>`).join('') : '<div class="ctx-label">No categories yet</div>'}
    <div class="ctx-sep"></div>
    <button data-newcat="1">＋ Create new…</button>`;
  parentMenu.appendChild(sub);
  const ar = anchorBtn.getBoundingClientRect();
  const sr = sub.getBoundingClientRect();
  let left = ar.right - 2;
  if (left + sr.width > window.innerWidth - 8) left = ar.left - sr.width + 2; // flip left if no room
  sub.style.left = (left - parentMenu.getBoundingClientRect().left) + 'px';
  // nudge up a touch so the cursor lands inside the submenu, not above its first row
  sub.style.top = (ar.top - parentMenu.getBoundingClientRect().top - 4) + 'px';
  sub.addEventListener('mouseenter', cancelClose);
  sub.addEventListener('mouseleave', scheduleClose);
  sub.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); toggleGameInCategory(b.dataset.cat, gameId); };
  });
  sub.querySelector('[data-newcat]').onclick = async (ev) => {
    ev.stopPropagation();
    closeMenus();
    const name = await askName('New category');
    if (name) createCategory(name, gameId);
  };
}

// ============================================================ hover preview (Steam-style)
const hp = { el: null, hls: null, timer: null };
function hidePreview() {
  clearTimeout(hp.timer);
  hp.timer = null;
  if (hp.hls) { hp.hls.destroy(); hp.hls = null; }
  hp.el?.remove();
  hp.el = null;
}
function attachHoverPreviews(root) {
  root.querySelectorAll('.card[data-open]').forEach((card) => {
    card.addEventListener('mouseenter', () => {
      if (state.view !== 'store') return;
      clearTimeout(hp.timer);
      hp.timer = setTimeout(() => showPreview(card, parseInt(card.dataset.open, 10)), 380);
    });
    card.addEventListener('mouseleave', hidePreview);
    card.addEventListener('click', hidePreview);
  });
}
function showPreview(card, id) {
  hidePreview();
  const g = byId(id);
  if (!g) return;
  const m = parseJson(g.meta_media) || {};
  const r = parseJson(g.meta_ratings) || {};
  const art = g.meta_hero || g.meta_cover;
  if (!m.trailer && !art && !g.meta_summary) return;
  const el = document.createElement('div');
  el.className = 'hover-preview';
  el.innerHTML = `
    ${m.trailer ? '<video muted autoplay loop playsinline></video>' : art ? `<img src="${esc(art)}" />` : ''}
    <div class="hp-body">
      <div class="hp-title">${esc(titleOf(g))}</div>
      ${r.steam ? `<div class="hp-rating"><span class="${ratingClass(r.steam.percent)}">${r.steam.percent}%</span> positive · ${Number(r.steam.count).toLocaleString()} Steam reviews</div>` : ''}
      ${g.meta_summary ? `<p>${esc(g.meta_summary)}</p>` : ''}
    </div>`;
  document.body.appendChild(el);
  const rc = card.getBoundingClientRect();
  const w = 340;
  let x = rc.right + 12;
  if (x + w > innerWidth - 8) x = rc.left - w - 12;
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(64, Math.min(rc.top, innerHeight - el.getBoundingClientRect().height - 12)) + 'px';
  const video = el.querySelector('video');
  if (video && m.trailer) {
    if (/\.m3u8/.test(m.trailer) && window.Hls && Hls.isSupported()) {
      hp.hls = new Hls();
      hp.hls.loadSource(m.trailer);
      hp.hls.attachMedia(video);
    } else {
      video.src = m.trailer;
    }
  }
  hp.el = el;
}

// install a specific package (from the Versions list) — adds to library first if needed
function installPackage(packageId) {
  const groupId = canonOf(packageId);
  if (isGuestMode) { pendingInstall = groupId; showAuth(); return; }
  openInstallDialog(groupId, packageId);
}
// Install/switch dialog: pick which downloaded version (if several) + the install
// location. Switching to a different package keeps saves + metadata (main.js).
async function openInstallDialog(gameId, presetPackageId = null) {
  gameId = canonOf(gameId);
  const g = byId(gameId);
  if (!g) return;
  const packages = packagesOf(gameId);
  const st = gameState(g);
  const installedPkgId = st.inst?.packageId;
  const switching = !!st.inst;
  const cfg = await gh.getConfig();
  let dirs = [...new Set([cfg.gamesDir, ...(cfg.gamesDirs || [])].filter(Boolean))];
  if (dirs.length === 0) {
    const dir = await gh.pickFolder();
    if (!dir) return;
    await gh.setConfig({ gamesDir: dir });
    dirs = [dir];
  }
  let selected = cfg.gamesDir || dirs[0];
  // default package: the preset, else the newest that isn't already installed, else newest
  let pkgId = presetPackageId ?? (packages.find((p) => p.id !== installedPkgId)?.id ?? packages[0].id);
  const ov = document.createElement('div');
  ov.className = 'modal';
  const draw = () => {
    ov.innerHTML = `<div class="modal-box" style="width:500px">
      <h2>${switching ? 'Change version' : 'Install'} — ${esc(titleOf(g))}</h2>
      ${packages.length > 1 ? `<label>Version
        <select class="inst-pkg">${packages.map((p) => {
          const v = pkgVersion(p);
          return `<option value="${p.id}"${p.id === pkgId ? ' selected' : ''}>${esc(v ? v.label : 'Unversioned')} · ${fmtSize(p.size_bytes)}${p.id === installedPkgId ? ' — installed' : ''}${p.id === packages[0].id ? ' — newest' : ''}</option>`;
        }).join('')}</select>
      </label>` : ''}
      <label>Install location
        <select class="inst-select">${dirs.map((d) => `<option value="${esc(d)}"${d === selected ? ' selected' : ''}>${esc(d)}${d === cfg.gamesDir ? '  (default)' : ''}</option>`).join('')}</select>
      </label>
      <button class="btn inst-browse">Browse for another location…</button>
      <p class="hint">Downloaded, unpacked, and installed on this PC in the folder above (a temporary <code>_staging</code> subfolder is used, then cleaned up). Your source library on the server is only ever read — never copied or modified.</p>
      ${switching ? '<p class="hint">Your saves live in a separate <code>_gamehub_saves</code> folder (kept across switches <em>and</em> uninstalls), so switching — or switching back — never loses progress. The previous version is removed only after the new one downloads.</p>' : ''}
      <div class="modal-actions">
        <button class="btn inst-cancel">Cancel</button>
        <button class="btn primary inst-go">${switching ? 'Switch & install' : 'Install'}</button>
      </div>
    </div>`;
    const pkgSel = ov.querySelector('.inst-pkg');
    if (pkgSel) pkgSel.onchange = (e) => { pkgId = parseInt(e.target.value, 10); };
    ov.querySelector('.inst-select').onchange = (e) => { selected = e.target.value; };
    ov.querySelector('.inst-browse').onclick = async () => {
      const dir = await gh.pickFolder();
      if (!dir) return;
      if (!dirs.includes(dir)) {
        dirs.push(dir);
        await gh.setConfig({ gamesDirs: dirs.filter((d) => d !== cfg.gamesDir) });
      }
      selected = dir;
      draw();
    };
    ov.querySelector('.inst-cancel').onclick = () => ov.remove();
    ov.querySelector('.inst-go').onclick = async () => {
      ov.remove();
      try { await gh.install(gameId, pkgId, selected); } catch (err) { toast(err.message, true); }
    };
  };
  draw();
  document.body.appendChild(ov);
  ov.onmousedown = (e) => { if (e.target === ov) ov.remove(); };
}

// ============================================================ actions
async function doAction(act, id) {
  id = canonOf(id); // all actions operate on the logical game (its canonical id)
  try {
    // category actions (from the right-click menu)
    if (act && act.startsWith('toggleCat:')) { await toggleGameInCategory(act.slice(10), id); return; }
    if (act === 'newCat') { const name = await askName('New category'); if (name) await createCategory(name, id); return; }
    // downloading requires an account — prompt sign-in, then resume the install
    if (act === 'install' && isGuestMode) {
      pendingInstall = id;
      showAuth();
      return;
    }
    if (act === 'install') return openInstallDialog(id); // pick package (if many) + location
    if (act === 'changePackage') return openInstallDialog(id); // switch to a different downloaded version
    if (act === 'favorite') {
      state.favorites = await gh.toggleFavorite(id);
      render();
      return;
    }
    if (act === 'addToLibrary') {
      state.myLibrary = await gh.addToLibrary(id);
      sessionAdded.add(id); // stays visible in the store this session
      toast('Added to your library');
      render();
      return;
    }
    if (act === 'removeFromLibrary') {
      state.myLibrary = await gh.removeFromLibrary(id);
      state.favorites = state.favorites.filter((f) => f !== id);
      toast('Removed from your library');
      render();
      return;
    }
    if (act === 'editEntry') return openEditModal(id);
    if (act === 'uninstall' && !confirm('Uninstall this game and remove its shortcuts?')) return;
    if (act === 'play') toast('Launching…');
    if (act === 'verifyInstall') {
      const r = await gh.verifyInstall(id);
      if (r.ok) toast(r.fixed.length ? `Repaired: ${r.fixed.join(', ')}` : 'Installation verified — everything checks out');
      else toast(`Issues found: ${r.issues.join('; ')}`, true);
      await refreshData(true);
      render();
      return;
    }
    await gh[act](id);
    if (act !== 'install') await refreshData(true);
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
    await refreshData(true);
  }
  render();
}

// ============================================================ refresh
async function refreshData(force = false) {
  try {
    const lib = await gh.getLibrary();
    loaded = true;
    $('#conn-dot').className = 'dot ok';
    $('#conn-dot').title = 'connected';
    $('#banner').classList.add('hidden');
    if (lib.categories) state.categories = lib.categories; // local; always current
    const hash = JSON.stringify([lib.games, lib.installed, lib.myLibrary, lib.favorites, lib.playtime]);
    if (!force && hash === lastHash) return;
    lastHash = hash;
    state.games = lib.games;
    rebuildGroups(); // recompute duplicate-package groups whenever the game list changes
    // count logical games (duplicate packages collapse into one)
    const logical = groupsByKey.size;
    $('#status-line').textContent = `${logical} game${logical === 1 ? '' : 's'} on server`;
    state.installed = lib.installed;
    state.myLibrary = lib.myLibrary || [];
    state.favorites = lib.favorites || [];
    state.playtime = lib.playtime || {};
    render();
  } catch (err) {
    $('#conn-dot').className = 'dot warn';
    $('#conn-dot').title = 'offline';
    $('#status-line').textContent = 'offline';
    const needsLogin = /401/.test(err.message);
    if (needsLogin) {
      $('#banner').classList.add('hidden');
      showAuth(); // session expired or first run — straight to sign-in
    } else {
      $('#banner').textContent = `⚠ Cannot reach server: ${err.message} — check the address via the account menu or Settings.`;
      $('#banner').classList.remove('hidden');
    }
    if (!loaded) { loaded = true; render(); }
  }
}

// Coalesce bursty re-renders (download/extraction progress fires many times a
// second) into at most one render per animation frame — a naive render()-per-tick
// during a download saturates the main thread and can crash the renderer.
let _renderQueued = false;
function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; render(); });
}
// Which views actually SHOW a game's task progress. A progress tick that changes
// nothing visible in the current view must not re-render it (the Store shows no
// per-game progress, so downloading while browsing it should never re-render it).
function viewShowsTask(gameId) {
  if (state.view === 'game') return state.gamePageId === gameId;
  if (state.view === 'library') return true; // rows show a busy dot + the page shows progress
  return false; // store / social / profile don't surface download progress
}
gh.onTaskUpdate((t) => {
  // game exited: clear the "In game" state and refresh (playtime updated)
  if (t.phase === 'playtime') { delete state.tasks[t.gameId]; refreshData(true); scheduleRender(); return; }
  if (t.phase === 'error' || t.phase === 'play-failed') {
    toast(t.message || 'Something went wrong', true);
    delete state.tasks[t.gameId];
    scheduleRender();
    return;
  }
  state.tasks[t.gameId] = t;
  if (['done', 'needs-install', 'needs-exe', 'uninstalled'].includes(t.phase)) {
    delete state.tasks[t.gameId];
    if (t.phase === 'done') toast(t.message || 'Ready to play');
    refreshData(true); // library state changed → always reflect it
    scheduleRender();
    return;
  }
  // in-progress tick (downloading / extracting): only re-render if it's visible
  if (viewShowsTask(t.gameId)) scheduleRender();
});

// typing a search overrides any active browse filter
$('#search').oninput = () => { if (state.storeFilter) state.storeFilter = null; render(); };
$('#refresh-btn').onclick = () => refreshData(true);

// ============================================================ settings
const modal = $('#settings-modal');
$('#settings-btn').onclick = async () => {
  const cfg = await gh.getConfig();
  $('#cfg-server').value = cfg.serverUrl;
  $('#cfg-apikey').value = cfg.apiKey;
  $('#cfg-gamesdir').value = cfg.gamesDir;
  $('#cfg-showprices').checked = cfg.showSteamPrices !== false;
  $('#cfg-delarch').checked = cfg.deleteArchivesAfterExtract;
  $('#cfg-desktop').checked = cfg.createDesktopShortcut;
  $('#cfg-startmenu').checked = cfg.createStartMenuShortcut;
  modal.classList.remove('hidden');
};
$('#cfg-pickdir').onclick = async () => {
  const dir = await gh.pickFolder();
  if (dir) $('#cfg-gamesdir').value = dir;
};
$('#cfg-cancel').onclick = () => modal.classList.add('hidden');
$('#cfg-save').onclick = async () => {
  await gh.setConfig({
    serverUrl: $('#cfg-server').value.trim(),
    apiKey: $('#cfg-apikey').value.trim(),
    gamesDir: $('#cfg-gamesdir').value.trim(),
    showSteamPrices: $('#cfg-showprices').checked,
    deleteArchivesAfterExtract: $('#cfg-delarch').checked,
    createDesktopShortcut: $('#cfg-desktop').checked,
    createStartMenuShortcut: $('#cfg-startmenu').checked,
  });
  showSteamPrices = $('#cfg-showprices').checked;
  modal.classList.add('hidden');
  toast('Settings saved');
  render();
  await refreshData(true);
};

// ============================================================ edit entry modal
let editGameId = null;
let editSelected = null;

async function openEditModal(id) {
  editGameId = id;
  editSelected = null;
  const g = byId(id);
  const info = await gh.getCandidates(id);
  $('#edit-dir').textContent = info.dir || '';
  $('#edit-custom').value = '';
  const box = $('#edit-cands');
  if (!info.candidates.length) {
    box.innerHTML = '<div class="muted" style="padding:8px 2px">No executables found in the install folder — browse for one below.</div>';
  } else {
    box.innerHTML = info.candidates
      .map(
        (c, i) => `<label class="edit-cand${c.isCurrent ? ' current' : ''}">
          <input type="radio" name="edit-exe" value="${i}" ${c.isCurrent || (!info.current && i === 0) ? 'checked' : ''} />
          <div class="ec-body">
            <div class="ec-name">${esc(c.rel)} ${c.isCurrent ? '<span class="chip state-installed">current</span>' : ''}</div>
            <div class="ec-sub">${fmtSize(c.size)}${c.reasons.length ? ' · ' + esc(c.reasons.join(', ')) : ''}</div>
          </div>
          <span class="ec-score" title="detection confidence">${c.score}</span>
        </label>`
      )
      .join('');
    const checked = box.querySelector('input:checked');
    if (checked) editSelected = info.candidates[Number(checked.value)].path;
    box.querySelectorAll('input[name="edit-exe"]').forEach((r) => {
      r.onchange = () => {
        editSelected = info.candidates[Number(r.value)].path;
        $('#edit-custom').value = '';
      };
    });
  }
  $('#edit-modal').classList.remove('hidden');
  $('#edit-modal').dataset.title = g ? titleOf(g) : '';
}

$('#edit-browse').onclick = async () => {
  const info = await gh.getCandidates(editGameId);
  const file = await gh.pickExeFile(info.dir);
  if (file) {
    $('#edit-custom').value = file;
    editSelected = file;
    document.querySelectorAll('#edit-cands input').forEach((r) => (r.checked = false));
  }
};
$('#edit-verify').onclick = async () => {
  const r = await gh.verifyInstall(editGameId);
  if (r.ok) toast(r.fixed.length ? `Repaired: ${r.fixed.join(', ')}` : 'Everything checks out');
  else toast(`Issues: ${r.issues.join('; ')}`, true);
};
$('#edit-cancel').onclick = () => $('#edit-modal').classList.add('hidden');
$('#edit-save').onclick = async () => {
  if (!editSelected) { toast('Pick an executable first', true); return; }
  try {
    await gh.setExe(editGameId, editSelected);
    $('#edit-modal').classList.add('hidden');
    await refreshData(true);
    render();
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
  }
};

// ============================================================ auth screen + account chip
let pendingInstall = null; // game to install after a sign-in prompt succeeds
function showAuth(prefill = {}) {
  gh.getConfig().then((cfg) => {
    $('#auth-server').value = prefill.serverUrl ?? cfg.serverUrl ?? '';
    $('#auth-user').value = prefill.username ?? cfg.username ?? '';
    $('#auth-pass').value = '';
    $('#auth-error').classList.add('hidden');
    $('#auth-step-login').classList.remove('hidden');
    $('#auth-step-folder').classList.add('hidden');
    // guests can dismiss and keep browsing; if the store already loaded, allow it
    $('#auth-guest').classList.toggle('hidden', !loaded);
    $('#auth-screen').classList.remove('hidden');
  });
}
function hideAuth() {
  $('#auth-screen').classList.add('hidden');
  pendingInstall = null;
}
$('#auth-guest').onclick = () => hideAuth();
document.addEventListener('keydown', (e) => {
  const authOpen = !$('#auth-screen').classList.contains('hidden');
  const onLoginStep = !$('#auth-step-login').classList.contains('hidden');
  if (e.key === 'Escape' && loaded && authOpen && onLoginStep) hideAuth();
});

async function submitAuth() {
  const errBox = $('#auth-error');
  errBox.classList.add('hidden');
  try {
    await gh.setConfig({ serverUrl: $('#auth-server').value.trim() });
    const user = await gh.login($('#auth-user').value.trim(), $('#auth-pass').value);
    toast(user.created ? `Admin account “${user.username}” created` : `Signed in as ${user.username}`);
    const cfg = await gh.getConfig();
    if (!cfg.gamesDir) {
      $('#auth-gamesdir').value = cfg.suggestedGamesDir;
      $('#auth-step-login').classList.add('hidden');
      $('#auth-step-folder').classList.remove('hidden');
      return;
    }
    const resume = pendingInstall;
    hideAuth();
    await updateAccountChip();
    await refreshData(true);
    if (resume != null) doAction('install', resume); // finish what the guest started
  } catch (err) {
    errBox.textContent = err.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    errBox.classList.remove('hidden');
  }
}
$('#auth-submit').onclick = submitAuth;
['auth-server', 'auth-user', 'auth-pass'].forEach((id) => {
  document.getElementById(id).onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };
});
$('#auth-browse').onclick = async () => {
  const dir = await gh.pickFolder();
  if (dir) $('#auth-gamesdir').value = dir;
};
$('#auth-finish').onclick = async () => {
  await gh.setConfig({ gamesDir: $('#auth-gamesdir').value.trim() });
  const resume = pendingInstall;
  hideAuth();
  toast('Setup complete — welcome to Gamehub');
  await updateAccountChip();
  await refreshData(true);
  if (resume != null) doAction('install', resume);
};

let isGuestMode = true;
async function updateAccountChip() {
  const cfg = await gh.getConfig();
  isGuestMode = !cfg.authToken && !cfg.apiKey;
  // Social + Profile need an account — hide them from guests
  $('#nav-social').classList.toggle('hidden', isGuestMode);
  if (isGuestMode && (state.view === 'social' || state.view === 'profile')) switchView('store');
  const acct = $('#account');
  const signin = $('#account-signin');
  if (isGuestMode || !cfg.username) {
    acct.classList.add('hidden');
    signin.classList.remove('hidden'); // guest → offer sign-in
    setAccountAvatar(null);
    return;
  }
  signin.classList.add('hidden');
  acct.classList.remove('hidden');
  $('#account-btn').textContent = cfg.username.slice(0, 1).toUpperCase();
  $('#account-name').textContent = cfg.username;
  $('#account-server').textContent = cfg.serverUrl.replace(/^https?:\/\//, '');
  // pull my picture into the chip (fire-and-forget — the initial shows meanwhile)
  gh.myStats().then((st) => setAccountAvatar(st && st.avatar)).catch(() => {});
}
$('#account-signin').onclick = () => showAuth();
$('#account-btn').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('#account-menu');
  const wasHidden = menu.classList.contains('hidden');
  closeMenus();
  menu.classList.toggle('hidden', !wasHidden);
};
$('#account-profile').onclick = () => { closeMenus(); loadProfile(); };
$('#account-logout').onclick = async () => {
  await gh.logout();
  updateAccountChip();
  showAuth({ username: '' });
};
$('#account-switch').onclick = async () => {
  await gh.logout();
  updateAccountChip();
  showAuth();
};

// ============================================================ boot
(async () => {
  render(); // skeletons
  const cfg = await gh.getConfig();
  hostPlatform = cfg.hostPlatform || 'win32';
  showSteamPrices = cfg.showSteamPrices !== false;
  await updateAccountChip();
  // browse the store as a guest by default — no forced sign-in
  await refreshData(true);
  // only nudge for a games folder once signed in (needed for installs)
  if (!isGuestMode && !cfg.gamesDir) {
    $('#auth-gamesdir').value = cfg.suggestedGamesDir;
    $('#auth-step-login').classList.add('hidden');
    $('#auth-step-folder').classList.remove('hidden');
    $('#auth-screen').classList.remove('hidden');
  }
  setInterval(() => refreshData(), 30_000);
})();
