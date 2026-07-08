const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
let authToken = localStorage.getItem('gamehub_token') || '';
let me = null;
let lastDataHash = '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { 'X-Auth-Token': authToken } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // only bounce to sign-in if we THOUGHT we were signed in (expired session);
    // guests hitting a protected endpoint just get the error, handled by callers
    if (authToken) { authToken = ''; localStorage.removeItem('gamehub_token'); me = { role: 'guest' }; showAuth('login'); }
    throw new Error('sign in required');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
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
  }, 3400);
}

function fmtSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function relTime(sqliteUtc) {
  const t = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function scoreClass(s) { return s >= 0.85 ? 'score-high' : s >= 0.6 ? 'score-mid' : 'score-low'; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ============================================================ routing
const ROUTES = ['library', 'profile', 'social', 'activity', 'errors', 'settings'];
const TITLES = { library: 'Store', profile: 'My Profile', social: 'Social', activity: 'Activity', errors: 'Errors', settings: 'Settings' };

function hashParts() {
  return (location.hash || '').replace(/^#\//, '').split('/');
}
function currentRoute() {
  const r = hashParts()[0];
  return ROUTES.includes(r) ? r : 'library';
}

function selectSettingsTab(tab) {
  const btn = $(`#settings-tabs .subtab[data-stab="${tab}"]`);
  if (!btn) return;
  $$('#settings-tabs .subtab').forEach((b) => b.classList.toggle('active', b === btn));
  ['general', 'library', 'sources', 'security', 'users'].forEach((t) =>
    $(`#stab-${t}`).classList.toggle('hidden', t !== tab)
  );
  if (tab === 'users') loadUsersTab();
}

function applyRoute() {
  const parts = hashParts();
  const isGame = parts[0] === 'game' && parts[1];
  const route = isGame ? 'game' : currentRoute();
  $$('aside nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === (isGame ? 'library' : route))
  );
  [...ROUTES, 'game'].forEach((r) => $(`#view-${r}`).classList.toggle('hidden', r !== route));
  $('#page-title').textContent = isGame ? 'Store' : TITLES[route];
  $('#search').classList.toggle('hidden', route !== 'library');
  if (route === 'errors') renderEvents();
  if (route === 'settings') {
    const tab = parts[1];
    if (tab) selectSettingsTab(tab);
    loadSettingsForm();
  }
  if (route === 'activity') renderActivity();
  if (route === 'library' && loaded) renderLibrary(); // apply any browse filter set elsewhere
  if (route === 'profile') renderProfile();
  if (route === 'social') renderSocial();
  else stopSocialPoll(); // stop presence polling when leaving Social
  if (isGame) renderGameDetail(parseInt(parts[1], 10));
}
window.addEventListener('hashchange', applyRoute);

// ============================================================ shared state
let allGames = [];
let loaded = false;

$('#rescan-btn').onclick = async () => {
  await api('/api/rescan', { method: 'POST' });
  toast('Library rescan started');
  setTimeout(() => refresh(true), 2000);
};
// typing a search overrides any active browse filter
$('#search').oninput = () => { if (storeFilter) storeFilter = null; renderLibrary(); };

// ============================================================ library
// hero rotates through the newest additions (pauses on hover)
let heroIdx = 0;
let heroPaused = false;

// tiered so the hero never goes stale: genuinely-new picks first (new releases →
// recently added), then quality tiers (top rated → featured) fill in. Each slide
// carries the reason it's featured, which drives its kicker.
function heroPool() {
  const eligible = allGames.filter((g) => g.status === 'matched' && isCanon(g) && !isDlc(g) && (g.meta_hero || g.meta_cover));
  const seen = new Set();
  const take = (arr, reason, n) => {
    const out = [];
    for (const g of arr) {
      if (out.length >= n) break;
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ g, reason });
    }
    return out;
  };
  const byReview = (a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1);
  const newReleases = eligible.filter(isNewRelease).sort((a, b) => releasedAt(b) - releasedAt(a));
  const recentlyAdded = eligible.filter((g) => isNew(g) && !isNewRelease(g)).sort((a, b) => addedAt(b) - addedAt(a));
  const topRated = eligible.filter((g) => (reviewPct(g) ?? -1) >= 80).sort(byReview);
  const featured = eligible.slice().sort(byReview);
  return [
    ...take(newReleases, 'released', 3),
    ...take(recentlyAdded, 'added', 3),
    ...take(topRated, 'rated', 3),
    ...take(featured, 'featured', 6),
  ].slice(0, 6);
}

function renderHero() {
  const hero = $('#hero');
  const pool = heroPool();
  if (pool.length === 0) { hero.classList.add('hidden'); return; }
  heroIdx = heroIdx % pool.length;
  const { g, reason } = pool[heroIdx];
  const HERO_KICKERS = { released: 'Newly released', added: 'New on your server', rated: 'Top rated', featured: 'Featured' };
  hero.classList.remove('hidden');
  hero.innerHTML = `
    <div class="hero-bg" style="background-image:url('${esc(g.meta_hero || g.meta_cover)}')"></div>
    <div class="hero-fade"></div>
    <div class="hero-content">
      <div class="hero-kicker">${HERO_KICKERS[reason] || 'Featured'}</div>
      <div class="hero-title">${esc(g.meta_title || g.clean_name)}</div>
      <div class="hero-meta">
        ${g.meta_year ? `<span class="chip">${g.meta_year}</span>` : ''}
        ${(g.meta_genres || '').split(',').filter(Boolean).slice(0, 3).map((x) => `<span class="chip">${esc(x.trim())}</span>`).join('')}
        <span class="chip">${fmtSize(g.size_bytes)}</span>
      </div>
      ${g.meta_summary ? `<div class="hero-summary">${esc(g.meta_summary)}</div>` : ''}
    </div>
    ${pool.length > 1 ? `
      <button class="hero-arrow prev" data-hero-nav="-1" aria-label="Previous">‹</button>
      <button class="hero-arrow next" data-hero-nav="1" aria-label="Next">›</button>
      <div class="hero-dots">${pool.map((_, i) => `<span class="${i === heroIdx ? 'on' : ''}" data-dot="${i}"></span>`).join('')}</div>`
      : ''}`;
  hero.onmouseenter = () => { heroPaused = true; };
  hero.onmouseleave = () => { heroPaused = false; };
  // the whole hero opens the game (arrows/dots stopPropagation)
  hero.onclick = () => (location.hash = `#/game/${g.id}`);
  hero.querySelectorAll('[data-dot]').forEach((dot) => {
    dot.onclick = (ev) => {
      ev.stopPropagation();
      heroIdx = parseInt(dot.dataset.dot, 10);
      renderHero();
    };
  });
  hero.querySelectorAll('[data-hero-nav]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const n = pool.length;
      heroIdx = (heroIdx + parseInt(btn.dataset.heroNav, 10) + n) % n;
      renderHero();
    };
  });
}

setInterval(() => {
  if (heroPaused || document.hidden || currentRoute() !== 'library') return;
  if (storeFilter || $('#search').value) return; // hero only shows in the curated view
  const pool = heroPool();
  if (pool.length < 2) return;
  heroIdx = (heroIdx + 1) % pool.length;
  renderHero();
}, 7000);

// grey "NEW" = added to your server within this window; blue "NEW RELEASE" =
// the game itself launched this recently (from the store release date)
const NEW_DAYS = 7;
const NEW_RELEASE_DAYS = 30;
function addedAt(g) { return new Date((g.created_at || '').replace(' ', 'T') + 'Z').getTime() || 0; }
function isNew(g) { return Date.now() - addedAt(g) < NEW_DAYS * 864e5; }
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
// DLC live under their base game's page, not as store rows of their own
function isDlc(g) { return g.meta_kind === 'dlc'; }

// ---- discovery: genres + a unified review score, for browse/sort ----
const OUTSTANDING_PCT = 85; // "Outstanding reviews" threshold
let storeFilter = null; // null | {type:'genre',value} | {type:'reviews'}
let storeSort = 'featured'; // featured | reviews | added | released | name
function titleOf(g) { return g.meta_title || g.clean_name; }
function gameGenres(g) { return (g.meta_genres || '').split(',').map((x) => x.trim()).filter(Boolean); }
function hasGenre(g, name) { const n = name.toLowerCase(); return gameGenres(g).some((x) => x.toLowerCase() === n); }
const _pctCache = new WeakMap();
function reviewPct(g) {
  if (_pctCache.has(g)) return _pctCache.get(g);
  let r; try { r = JSON.parse(g.meta_ratings || 'null'); } catch { r = null; }
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
function topGenres(pool, n) {
  const counts = new Map();
  for (const g of pool) for (const gn of gameGenres(g)) counts.set(gn, (counts.get(gn) || 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([gn]) => gn);
}
// granular Steam popular tags (Zombie, Survival, City Builder…) from SteamSpy
function gameTags(g) { try { const t = JSON.parse(g.meta_tags || 'null'); return Array.isArray(t) ? t : []; } catch { return []; } }
// mood/aesthetic/meta tags that make poor *browse categories* — kept out of the
// shortcut row so it stays thematic (Zombies, Survival, City Builder, Roguelike…)
const TERM_STOPWORDS = new Set([
  'atmospheric', 'difficult', 'realistic', 'violent', 'gore', 'blood', 'nudity', 'sexual content', 'mature',
  'character customization', 'moddable', 'great soundtrack', 'physics', 'choices matter', 'multiple endings',
  'funny', 'relaxing', 'cute', 'colorful', 'beautiful', 'stylized', 'minimalist', 'cinematic', 'family friendly',
  'classic', 'nostalgia', 'memes', 'fast-paced', 'addictive', 'epic', 'masterpiece', 'cult classic',
]);
// combined browse terms = broad genres + granular tags, deduped, minus mood noise
function browseTerms(g) {
  const seen = new Set(), out = [];
  for (const term of [...gameGenres(g), ...gameTags(g)]) {
    const k = term.toLowerCase();
    if (term && !seen.has(k) && !TERM_STOPWORDS.has(k)) { seen.add(k); out.push(term); }
  }
  return out;
}
function hasTerm(g, name) { const n = name.toLowerCase(); return browseTerms(g).some((x) => x.toLowerCase() === n); }
function topTerms(pool, n) {
  const counts = new Map(), casing = new Map();
  for (const g of pool) for (const term of browseTerms(g)) {
    const k = term.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!casing.has(k)) casing.set(k, term);
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => casing.get(k));
}
function sortGames(list, sort) {
  const rev = (a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1);
  const arr = [...list];
  if (sort === 'name') arr.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  else if (sort === 'reviews') arr.sort((a, b) => rev(a, b) || titleOf(a).localeCompare(titleOf(b)));
  else if (sort === 'added') arr.sort((a, b) => addedAt(b) - addedAt(a));
  else if (sort === 'released') arr.sort((a, b) => releasedAt(b) - releasedAt(a));
  else arr.sort((a, b) => rev(a, b) || (addedAt(b) - addedAt(a))); // featured
  return arr;
}
function sortControlHtml() {
  const b = (k, l) => `<button class="sort-btn${storeSort === k ? ' on' : ''}" data-storesort="${k}">${l}</button>`;
  return `<span class="sort-control"><span class="muted">Sort</span>${b('featured', 'Featured')}${b('reviews', 'Rating')}${b('added', 'Newest')}${b('released', 'Release')}${b('name', 'Name')}</span>`;
}

// ---- duplicate packages: one logical game, many downloaded versions ----
function pkgKey(g) { return (g.provider && g.provider_id) ? `${g.provider}:${g.provider_id}` : `solo:${g.id}`; }
function pkgVersion(g) {
  const s = g.raw_name || g.clean_name || '';
  let m = s.match(/\bv?(\d+(?:\.\d+){1,3})\b/i);
  if (m) return { label: m[1], num: m[1].split('.').map(Number) };
  m = s.match(/\b(?:update|build|patch|rev)\s*\.?\s*(\d+)\b/i);
  if (m) return { label: m[0].replace(/\s+/g, ' ').trim(), num: [0, Number(m[1])] };
  m = s.match(/\bv(\d+)\b/i);
  if (m) return { label: `v${m[1]}`, num: [Number(m[1])] };
  return null;
}
function cmpVersionDesc(a, b) {
  const va = pkgVersion(a), vb = pkgVersion(b);
  if (va && vb) {
    for (let i = 0; i < Math.max(va.num.length, vb.num.length); i++) {
      const d = (vb.num[i] || 0) - (va.num[i] || 0);
      if (d) return d;
    }
  } else if (va) return -1; else if (vb) return 1;
  return addedAt(b) - addedAt(a);
}
let groupsByKey = null, canonById = null;
function rebuildGroups() {
  groupsByKey = new Map();
  for (const g of allGames) {
    if (g.status !== 'matched') continue;
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
  const g = allGames.find((x) => x.id === canonOf(id)) || allGames.find((x) => x.id === id);
  return (g && groupsByKey && groupsByKey.get(pkgKey(g))) || (g ? [g] : []);
}

function renderLibrary() {
  const q = $('#search').value.toLowerCase();
  const hero = $('#hero');
  const body = $('#store-body');
  // one card per logical game — duplicate packages collapse to the canonical row
  const all = allGames.filter((g) => g.status === 'matched' && isCanon(g));
  // DLC stay searchable but never clutter the store rows — they live on
  // their base game's page (Steam-style)
  const matched = all.filter((g) => !isDlc(g));

  if (!loaded) {
    hero.classList.add('hidden');
    body.innerHTML = `<div class="grid">${Array.from({ length: 8 }, () =>
      `<div class="skeleton"><div class="sk-cover sk"></div><div class="sk-line sk" style="width:70%"></div><div class="sk-line sk" style="width:40%"></div></div>`).join('')}</div>`;
    return;
  }

  if (q || storeFilter) {
    // ---- results mode: search / genre / outstanding-reviews ----
    hero.classList.add('hidden');
    let list, title, kicker;
    if (q) { list = all.filter((g) => titleOf(g).toLowerCase().includes(q)); title = 'Search results'; kicker = `“${$('#search').value}”`; }
    else if (storeFilter.type === 'genre') { list = matched.filter((g) => hasTerm(g, storeFilter.value)); title = storeFilter.value; kicker = 'category'; }
    else if (storeFilter.type === 'newrelease') { list = matched.filter(isNewRelease); title = 'New Releases'; kicker = 'recently released'; }
    else if (storeFilter.type === 'recent') { list = matched.filter((g) => isNew(g) && !isNewRelease(g)); title = 'Recently added'; kicker = 'new on your server'; }
    else { list = matched.filter((g) => (reviewPct(g) ?? -1) >= OUTSTANDING_PCT); title = 'Top rated'; kicker = `${OUTSTANDING_PCT}%+ rated`; }
    const sorted = sortGames(list, storeSort);
    body.innerHTML = `
      <div class="results-head">
        <button class="btn back-btn" data-store-clear="1">← Store</button>
        <div class="results-title"><h2>${esc(title)}</h2><span class="muted">${esc(kicker)} · ${sorted.length} game${sorted.length === 1 ? '' : 's'}</span></div>
        ${sortControlHtml()}
      </div>
      <div class="grid">${sorted.length ? sorted.map(webCard).join('') : `<div class="empty">${q ? 'No games match your search.' : 'No games in this section yet.'}</div>`}</div>`;
  } else if (matched.length === 0) {
    hero.classList.add('hidden');
    body.innerHTML = '<div class="empty">No matched games yet — check the Activity tab.</div>';
  } else {
    // ---- curated mode: hero + browse shortcuts + themed rails + sortable grid ----
    renderHero();
    const newReleases = matched.filter(isNewRelease).sort((a, b) => releasedAt(b) - releasedAt(a)).slice(0, 12);
    const recentlyAdded = matched.filter((g) => isNew(g) && !isNewRelease(g)).sort((a, b) => addedAt(b) - addedAt(a)).slice(0, 12);
    const outstanding = matched.filter((g) => (reviewPct(g) ?? -1) >= OUTSTANDING_PCT).sort((a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1)).slice(0, 12);
    const terms = topTerms(matched, 30);
    const termRails = terms.slice(0, 3)
      .map((gn) => ({ name: gn, games: matched.filter((g) => hasTerm(g, gn)).sort((a, b) => (reviewPct(b) ?? -1) - (reviewPct(a) ?? -1)).slice(0, 12) }))
      .filter((r) => r.games.length >= 3);
    const allSorted = sortGames(matched, storeSort);
    // Every rail heading links to its full "group" page — same targets the browse
    // pills use. Click the title or the See all → button.
    const rail = (heading, filterAttr, games) => `
      <div class="section-head">
        <h2${filterAttr ? ` class="head-link" ${filterAttr}` : ''}>${esc(heading)}</h2>
        ${filterAttr ? `<button class="see-all" ${filterAttr}>See all →</button>` : ''}
      </div>
      <div class="card-rail">${games.map(webCard).join('')}</div>`;
    body.innerHTML = `
      ${terms.length ? `<div class="browse-wrap">
        <button class="browse-arrow left hidden" data-browse-nav="-1" aria-label="Scroll categories left">‹</button>
        <div class="browse-bar" id="browse-bar">
          <button class="browse-pill" data-filter="reviews">Top rated</button>
          ${terms.map((t) => `<button class="browse-pill" data-genre="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>
        <button class="browse-arrow right" data-browse-nav="1" aria-label="Scroll categories right">›</button>
      </div>` : ''}
      ${newReleases.length ? rail('New Releases', 'data-filter="newrelease"', newReleases) : ''}
      ${recentlyAdded.length ? rail('Recently added', 'data-filter="recent"', recentlyAdded) : ''}
      ${outstanding.length ? rail('Top rated', 'data-filter="reviews"', outstanding) : ''}
      ${termRails.map((r) => rail(r.name, `data-genre="${esc(r.name)}"`, r.games)).join('')}
      <div class="section-head"><h2>All games</h2><span class="muted">${matched.length} game${matched.length === 1 ? '' : 's'}</span>${sortControlHtml()}</div>
      <div class="grid">${allSorted.map(webCard).join('')}</div>`;
  }
  wireStore();
}

// wire store cards (open + hover preview) and the discovery controls
function wireStore() {
  const root = $('#view-library');
  root.querySelectorAll('.card[data-open]').forEach((card) => {
    card.onclick = () => { hidePreview(); location.hash = `#/game/${card.dataset.open}`; };
    card.addEventListener('mouseenter', () => {
      clearTimeout(hp.timer);
      hp.timer = setTimeout(() => showPreview(card, parseInt(card.dataset.open, 10)), 380);
    });
    card.addEventListener('mouseleave', hidePreview);
  });
  root.querySelectorAll('[data-genre]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); storeFilter = { type: 'genre', value: el.dataset.genre }; storeSort = 'featured'; $('#search').value = ''; renderLibrary(); };
  });
  const bar = $('#browse-bar');
  if (bar) {
    const wrap = bar.closest('.browse-wrap');
    const l = wrap.querySelector('.browse-arrow.left'), r = wrap.querySelector('.browse-arrow.right');
    const upd = () => { const max = bar.scrollWidth - bar.clientWidth - 1; l.classList.toggle('hidden', bar.scrollLeft <= 0); r.classList.toggle('hidden', bar.scrollLeft >= max); };
    bar.onscroll = upd;
    wrap.querySelectorAll('[data-browse-nav]').forEach((btn) => { btn.onclick = () => bar.scrollBy({ left: 260 * parseInt(btn.dataset.browseNav, 10), behavior: 'smooth' }); });
    upd();
  }
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.onclick = () => { storeFilter = { type: el.dataset.filter }; storeSort = 'featured'; $('#search').value = ''; renderLibrary(); };
  });
  root.querySelectorAll('[data-storesort]').forEach((b) => {
    b.onclick = () => { storeSort = b.dataset.storesort; renderLibrary(); };
  });
  root.querySelectorAll('[data-store-clear]').forEach((el) => {
    el.onclick = () => { storeFilter = null; $('#search').value = ''; renderLibrary(); };
  });
}

// portrait covers crop to fill; a landscape banner is contained over a blurred
// fill (never an ugly center-crop); no art → text cover. coverFit() tags wide art.
function coverHtml(g) {
  const title = g.meta_title || g.clean_name;
  if (!g.meta_cover) return `<div class="cover text-cover"><span>${esc(title)}</span></div>`;
  return `<div class="cover" style="background-image:url('${esc(g.meta_cover)}')">
    <img class="cover-fg" src="${esc(g.meta_cover)}" alt="" loading="lazy" onload="coverFit(this)" />
  </div>`;
}
function coverFit(img) {
  const c = img.closest('.cover');
  if (c && img.naturalWidth > img.naturalHeight * 1.15) c.classList.add('wide');
}

function webCard(g) {
  return `<div class="card" data-open="${g.id}">
    ${newBadge(g)}
    ${coverHtml(g)}
    <div class="info">
      <div class="title" title="${esc(g.meta_title || g.clean_name)}">${esc(g.meta_title || g.clean_name)}</div>
      <div class="sub">${[isDlc(g) ? '<span class="dlc-tag">DLC</span>' : '', g.meta_year || '', g.size_bytes ? fmtSize(g.size_bytes) : ''].filter(Boolean).join(' · ')}</div>
      ${priceHtml(g, true) ? `<div class="card-price">${priceHtml(g, true)}</div>` : ''}
    </div>
  </div>`;
}

// ============================================================ profile + social
let profileData = null; // { id, username, avatar, totalSeconds, games:[...], me } | { error }
let socialData = null;  // { users:[...], games:{week,allTime} } | { error }
let profileSort = 'seconds';
let socialFrame = 'week'; // social lists timeframe: week | allTime
const FRAME_LABEL = { week: 'this week', allTime: 'all time' };

function fmtHours(seconds) {
  if (!seconds) return '0 min';
  const h = seconds / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.max(1, Math.round(seconds / 60))} min`;
}
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
      await api('/api/me/avatar', { method: 'POST', body: JSON.stringify({ avatar: dataUrl }) });
      profileData = null; socialData = null; // avatars are now stale
      toast('Profile picture updated');
      renderProfile();
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

async function renderProfile() {
  const body = $('#profile-body');
  if (isGuest()) { body.innerHTML = '<div class="empty">Sign in to see profiles and stats.</div>'; return; }
  const uid = hashParts()[1] ? parseInt(hashParts()[1], 10) : null;
  const key = uid ?? 'me';
  if (!profileData || profileData.__key !== key) body.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await api(uid ? `/api/users/${uid}/stats` : '/api/me/stats');
    data.__key = key;
    profileData = data;
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (currentRoute() !== 'profile') return;
  const p = profileData;
  $('#page-title').textContent = p.me ? 'My Profile' : p.username;
  const all = p.games || [];
  const sort = profileSort;
  const games = [...all].sort(
    sort === 'name' ? (a, b) => (a.meta_title || a.clean_name).localeCompare(b.meta_title || b.clean_name)
    : sort === 'recent' ? (a, b) => (b.last_played || '').localeCompare(a.last_played || '')
    : (a, b) => b.seconds - a.seconds
  );
  const top = [...all].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
  const mostPlayed = top[0] ? (top[0].meta_title || top[0].clean_name) : '—';
  body.innerHTML = `
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
  body.querySelector('#avatar-edit')?.addEventListener('click', pickAvatar);
  body.querySelector('[data-social-back]')?.addEventListener('click', () => { location.hash = '#/social'; });
  body.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => { profileSort = b.dataset.sort; renderProfile(); };
  });
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => { location.hash = `#/game/${el.dataset.open}`; };
  });
}

function profileTopCard(g) {
  return `<div class="card" data-open="${g.id}">
    ${coverHtml(g)}
    <div class="info"><div class="title" title="${esc(g.meta_title || g.clean_name)}">${esc(g.meta_title || g.clean_name)}</div><div class="sub">${fmtHours(g.seconds)}</div></div>
  </div>`;
}
function playedRow(g) {
  return `<div class="played-row" data-open="${g.id}">
    ${g.meta_cover ? `<div class="played-cover" style="background-image:url('${esc(g.meta_cover)}')"></div>` : `<div class="played-cover text">${esc((g.meta_title || g.clean_name).slice(0, 1))}</div>`}
    <span class="played-name">${esc(g.meta_title || g.clean_name)}</span>
    <span class="played-when">${g.last_played ? relTime(g.last_played) : ''}</span>
    <span class="played-hours">${fmtHours(g.seconds)}</span>
  </div>`;
}

async function renderSocial() {
  const body = $('#social-body');
  if (isGuest()) { body.innerHTML = '<div class="empty">Sign in to see what everyone on your server is playing.</div>'; return; }
  if (!socialData) body.innerHTML = '<div class="empty">Loading…</div>';
  try { socialData = await api('/api/social/leaderboard'); }
  catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (currentRoute() !== 'social') return;
  const users = socialData.users || [];
  if (!users.length) { body.innerHTML = '<div class="empty">No playtime recorded yet — play a game to get on the board! 🎮</div>'; return; }
  const frame = socialFrame;
  const label = FRAME_LABEL[frame];
  const players = [...users].sort((a, b) => (b[frame].total - a[frame].total) || (b.allTime.total - a.allTime.total))
    .filter((u) => u[frame].total > 0);
  const games = (socialData.games && socialData.games[frame]) || [];
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
  body.innerHTML = `
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
  body.querySelectorAll('[data-frame]').forEach((b) => {
    b.onclick = () => { socialFrame = b.dataset.frame; renderSocial(); };
  });
  body.querySelectorAll('[data-profile]').forEach((el) => {
    el.onclick = () => { location.hash = `#/profile/${el.dataset.profile}`; };
  });
  body.querySelectorAll('[data-open2]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); location.hash = `#/game/${el.dataset.open2}`; };
  });
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => { location.hash = `#/game/${el.dataset.open}`; };
  });
  // keep "now playing" fresh while the tab is open (presence has a short TTL)
  stopSocialPoll();
  socialPoll = setInterval(async () => {
    if (currentRoute() !== 'social') { stopSocialPoll(); return; }
    try { socialData = await api('/api/social/leaderboard'); if (currentRoute() === 'social') renderSocial(); } catch { /* keep last */ }
  }, 30000);
}
let socialPoll = null;
function stopSocialPoll() { if (socialPoll) { clearInterval(socialPoll); socialPoll = null; } }

// ============================================================ hover preview (Steam-style)
const hp = { el: null, hls: null, timer: null };
function hidePreview() {
  clearTimeout(hp.timer);
  hp.timer = null;
  if (hp.hls) { hp.hls.destroy(); hp.hls = null; }
  hp.el?.remove();
  hp.el = null;
}
function scoreColor(p) { return p >= 75 ? 'good' : p >= 50 ? 'mid' : 'bad'; }
function showPreview(card, id) {
  hidePreview();
  const g = allGames.find((x) => x.id === id);
  if (!g) return;
  let m, r;
  try { m = JSON.parse(g.meta_media || '{}'); } catch { m = {}; }
  try { r = JSON.parse(g.meta_ratings || '{}'); } catch { r = {}; }
  const art = g.meta_hero || g.meta_cover;
  if (!m.trailer && !art && !g.meta_summary) return;
  const el = document.createElement('div');
  el.className = 'hover-preview';
  el.innerHTML = `
    ${m.trailer ? '<video muted autoplay loop playsinline></video>' : art ? `<img src="${esc(art)}" />` : ''}
    <div class="hp-body">
      <div class="hp-title">${esc(g.meta_title || g.clean_name)}</div>
      ${r.steam ? `<div class="hp-rating"><span class="${scoreColor(r.steam.percent)}">${r.steam.percent}%</span> positive · ${Number(r.steam.count).toLocaleString()} Steam reviews</div>` : ''}
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

// ============================================================ game detail
function ratingClass(v, scale = 100) {
  const p = (v / scale) * 100;
  return p >= 75 ? 'good' : p >= 50 ? 'mid' : 'bad';
}

function renderRatings(ratingsJson) {
  let r;
  try {
    r = JSON.parse(ratingsJson || '{}');
  } catch {
    r = {};
  }
  const blocks = [];
  if (r.steam) {
    blocks.push(`<div class="rating">
      <div class="rating-val ${ratingClass(r.steam.percent)}">${r.steam.percent}%</div>
      <div class="rating-sub"><strong>Steam</strong> · ${esc(r.steam.desc || 'user reviews')}<br>${Number(r.steam.count).toLocaleString()} reviews</div>
    </div>`);
  }
  if (r.metacritic) {
    blocks.push(`<div class="rating">
      <div class="rating-val mc ${ratingClass(r.metacritic.score)}">${r.metacritic.score}</div>
      <div class="rating-sub"><strong>Metacritic</strong><br>critic score</div>
    </div>`);
  }
  if (r.igdb?.critic) {
    blocks.push(`<div class="rating">
      <div class="rating-val ${ratingClass(r.igdb.critic)}">${r.igdb.critic}</div>
      <div class="rating-sub"><strong>IGDB</strong> · critics<br>${r.igdb.criticCount || 0} outlets</div>
    </div>`);
  }
  if (r.igdb?.user) {
    blocks.push(`<div class="rating">
      <div class="rating-val ${ratingClass(r.igdb.user)}">${r.igdb.user}</div>
      <div class="rating-sub"><strong>IGDB</strong> · users<br>${r.igdb.userCount || 0} ratings</div>
    </div>`);
  }
  if (r.rawg) {
    blocks.push(`<div class="rating">
      <div class="rating-val ${ratingClass(r.rawg.rating, 5)}">${Number(r.rawg.rating).toFixed(1)}</div>
      <div class="rating-sub"><strong>RAWG</strong> · out of 5<br>${Number(r.rawg.count).toLocaleString()} ratings</div>
    </div>`);
  }
  return blocks.length ? `<div class="ratings">${blocks.join('')}</div>` : '';
}

// compact colored rating badges (game-page hero) — value on the badge, full
// source/description revealed on hover so it never displaces the header
function ratingBadges(ratingsJson) {
  let r;
  try { r = JSON.parse(ratingsJson || '{}'); } catch { r = {}; }
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

// ---------- Steam store price (informational — links out to Steam) ----------
const STEAM_LOGO = '<svg class="steam-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.98 0C5.7 0 .53 4.85.02 11.02l6.44 2.66a3.4 3.4 0 0 1 1.9-.59l.19.01 2.86-4.15v-.06a4.53 4.53 0 1 1 4.53 4.53h-.1l-4.08 2.91.01.16a3.4 3.4 0 1 1-6.72-.67L.44 15.27A12 12 0 1 0 11.98 0zM7.54 18.2l-1.47-.6c.26.54.71 1 1.31 1.25a2.55 2.55 0 0 0 1.96-4.7l-1.52-.63a1.96 1.96 0 1 1-.28 4.68zm11.42-9.3a3.02 3.02 0 1 0-6.03 0 3.02 3.02 0 0 0 6.03 0zm-5.27 0a2.27 2.27 0 1 1 4.53 0 2.27 2.27 0 0 1-4.53 0z"/></svg>';
function showPrices() { return localStorage.getItem('gh_hide_prices') !== '1'; }
function parsePrice(g) {
  try { const p = JSON.parse(g.meta_price || 'null'); return p && Object.keys(p).length ? p : null; }
  catch { return null; }
}
// Steam-style tag: struck-out original + green sale price + % off; plain when
// not discounted; "Free" for free-to-play. `compact` (cards) shows the Steam
// logo, drops the "on Steam" note. Hidden entirely when prices are toggled off.
function priceHtml(g, compact = false) {
  if (!showPrices()) return '';
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
// Deep-link to the Steam store page (only for Steam-provided matches)
function steamLink(g) {
  if (g.provider !== 'steam' || !g.provider_id) return '';
  return `<a class="steam-link" href="https://store.steampowered.com/app/${encodeURIComponent(g.provider_id)}" target="_blank" rel="noopener">View on Steam ↗</a>`;
}

// ---------- OS compatibility + requirements ----------
function parseCompat(g) {
  try { return JSON.parse(g.meta_compat || 'null'); } catch { return null; }
}
// OS glyphs (single-color, rendered plain white via currentColor)
const OS_ICONS = {
  windows: '<svg viewBox="0 0 16 16"><path d="M0 2.3 6.5 1.4v6.2H0zM7.3 1.3 16 0v7.6H7.3zM0 8.4h6.5v6.2L0 13.7zM7.3 8.4H16V16L7.3 14.7z"/></svg>',
  linux: '<svg viewBox="0 0 16 16"><path d="M8 .8C6 .8 4.8 2.3 4.8 4.2c0 .9-.2 1.6-.7 2.6C3.3 8.4 2.5 10 2.5 11.6c0 .5.1 1 .3 1.4-.5.2-.8.6-.8 1.1 0 .7.7 1.2 1.5 1.2.5 0 1-.2 1.5-.2.4 0 .9.1 1.4.1h3.2c.5 0 1-.1 1.4-.1.5 0 1 .2 1.5.2.8 0 1.5-.5 1.5-1.2 0-.5-.3-.9-.8-1.1.2-.4.3-.9.3-1.4 0-1.6-.8-3.2-1.6-4.8-.5-1-.7-1.7-.7-2.6C11.2 2.3 10 .8 8 .8zM6.6 4.1a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2zm2.8 0a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2zM6.7 6.2h2.6L8 7.6 6.7 6.2z" fill-rule="evenodd"/></svg>',
  proton: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="1.7"/><g fill="none" stroke="currentColor" stroke-width="1.1"><ellipse cx="8" cy="8" rx="6.9" ry="2.7"/><ellipse cx="8" cy="8" rx="6.9" ry="2.7" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.9" ry="2.7" transform="rotate(120 8 8)"/></g></svg>',
  mac: '<svg viewBox="0 0 16 16"><path d="M11.6 8.5c0-1.7 1.4-2.5 1.4-2.5-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6-.5 0-1.3-.6-2.2-.6-1.1 0-2.2.7-2.8 1.7-1.2 2-.3 5.1.9 6.8.6.8 1.2 1.7 2.1 1.7.8 0 1.2-.5 2.2-.5s1.3.5 2.2.5 1.5-.8 2-1.6c.6-.9.9-1.8.9-1.9 0 0-1.8-.7-1.8-2.9zM10 3.7c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-1.1z"/></svg>',
};

// icon row + hardware requirements for the game page (plain white glyphs)
function compatHtml(g) {
  const c = parseCompat(g);
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
    ${c.proton?.tier && !c.platforms.linux ? '<p class="hint">Linux rating cited from ProtonDB community reports. Native Linux install flow is on the roadmap.</p>' : ''}
    ${reqHtml}
  </div>`;
}

// Steam's "About This Game" is rich HTML (headings, images, lists). Sanitize
// before rendering: drop scripts/embeds, strip event handlers + javascript: URLs.
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
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  });
  return tpl.innerHTML;
}
// Prefer the deep "About This Game"; fall back to the short summary. The long
// version is collapsed (clamped + fade) with a Read-more toggle, Steam-style.
function aboutHtml(g) {
  const full = g.meta_about ? sanitizeHtml(g.meta_about) : '';
  if (full && full.trim()) {
    return `<div class="card-form about-wrap">
      <h3>About This Game</h3>
      <div class="about-full clamped">${full}</div>
      <button class="about-toggle">Read more ▾</button>
    </div>`;
  }
  if (g.meta_summary) return `<div class="card-form"><h3>About</h3><p class="detail-summary">${esc(g.meta_summary)}</p></div>`;
  return '';
}

// show/hide the Read-more toggle based on whether the About actually overflows
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

// Pause the "About This Game" gifs/videos when off-screen or when the tab is
// hidden/unfocused, so we aren't looping clips in the background.
const winActive = () => !document.hidden && document.hasFocus();
let aboutIO = null;
function wireAboutMedia(root) {
  if (aboutIO) { aboutIO.disconnect(); aboutIO = null; }
  const vids = [...root.querySelectorAll('.about-full video')];
  if (!vids.length) return;
  vids.forEach((v) => {
    v.preload = 'auto'; // buffer the whole short clip so the loop stays seamless
    // Under bandwidth contention (a download running) a looping clip can't
    // re-buffer at its loop point and flashes back to the start. Hold on the
    // current frame while it's starved, then resume once it can play through.
    v.addEventListener('waiting', () => { if (!v.paused) { v._stalled = true; v.pause(); } });
    v.addEventListener('canplaythrough', () => {
      if (v._stalled && v._onscreen && winActive()) { v._stalled = false; v.play().catch(() => {}); }
    });
  });
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

// ordered media list — trailer first, then screenshots (shared indexing so the
// thumbnail row and the lightbox agree on positions)
function mediaItems(g) {
  let m;
  try { m = JSON.parse(g.meta_media || '{}'); } catch { m = {}; }
  const items = [];
  if (m.trailer) items.push({ type: 'video', src: m.trailer, thumb: m.trailerThumb || g.meta_hero || '' });
  for (const s of m.screenshots || []) items.push({ type: 'image', src: s });
  return items;
}

function mediaHtml(g) {
  const items = mediaItems(g);
  if (!items.length) return '';
  return `<div class="media-row">
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

// "DLC for <base game>" chip on a DLC's page — clickable when the base game
// is on the server, plain text otherwise
function dlcParentChip(g) {
  const parent = allGames.find(
    (x) => x.status === 'matched' && x.provider === 'steam' && String(x.provider_id) === String(g.meta_parent_id || '')
  );
  const label = g.meta_parent_title || (parent ? titleOf(parent) : 'base game');
  return parent
    ? `<button class="chip dlc-parent" data-open-parent="${parent.id}" title="Open the base game">DLC · ${esc(label)}</button>`
    : `<span class="chip dlc-parent">DLC · ${esc(label)}</span>`;
}

// Steam-style DLC section on a base game's page: every official DLC, the ones
// on the server highlighted, the rest dimmed. Loads async (name resolution).
// Always asked for Steam-matched games — the server unions the official list
// with library DLC that link back to this game, so owned DLC show even before
// the base game's own list has been backfilled.
async function loadDlcSection(g) {
  const el = $('#dlc-section');
  if (!el || g.provider !== 'steam' || !g.provider_id) return;
  let ids = [];
  try { ids = JSON.parse(g.meta_dlc || '[]'); } catch { /* none */ }
  // only show a loading skeleton when we know DLC exist; otherwise fill silently
  if (ids.length) el.innerHTML = '<div class="section-head"><h2>DLC</h2><span class="muted">loading…</span></div>';
  let rows = [];
  try { rows = (await api(`/api/games/${g.id}/dlc`)).dlc || []; } catch { /* hide below */ }
  if (!rows.length) { el.innerHTML = ''; return; }
  const here = rows.filter((r) => r.inLibrary).length;
  // on a DLC's own page this is the base game's full catalog (its siblings)
  const label = isDlc(g) && g.meta_parent_title ? `DLC for ${esc(g.meta_parent_title)}` : 'DLC';
  el.innerHTML = `
    <div class="section-head"><h2>${label}</h2><span class="muted">${here} of ${rows.length} on your server</span></div>
    <div class="dlc-list">
      ${rows.map((r) => {
        if (isDlc(g) && String(r.appid) === String(g.provider_id)) {
          return `<div class="dlc-row here"><span class="dlc-check">✓</span><span class="dlc-name">${esc(r.name)}</span><span class="dlc-state">This package</span></div>`;
        }
        if (!r.inLibrary) {
          return `<div class="dlc-row absent">
              <span class="dlc-check"></span><span class="dlc-name">${esc(r.name)}</span>
              <span class="dlc-state">Not in library</span>
            </div>`;
        }
        return `<div class="dlc-row here" data-open-dlc="${r.gameId}" title="Open this DLC">
            <span class="dlc-check">✓</span><span class="dlc-name">${esc(r.name)}</span>
            <span class="dlc-state">${r.included ? 'Included with the game' : 'On server'}</span>
          </div>`;
      }).join('')}
    </div>`;
  el.querySelectorAll('[data-open-dlc]').forEach((x) => {
    x.onclick = () => { location.hash = `#/game/${x.dataset.openDlc}`; };
  });
}

async function renderGameDetail(id) {
  const box = $('#game-detail');
  box.innerHTML = '<div class="empty">Loading…</div>';
  let g, files;
  try {
    [g, files] = await Promise.all([api(`/api/games/${id}`), api(`/api/games/${id}/files`).catch(() => [])]);
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const title = g.meta_title || g.clean_name;
  const heroArt = g.meta_hero || g.meta_cover;
  const dlKey = authToken ? `&token=${encodeURIComponent(authToken)}` : '';
  const dlHref = (p) => `/api/games/${g.id}/download?path=${encodeURIComponent(p)}${dlKey}`;

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const single = files.length === 1;
  const packages = packagesOf(g.id);
  const multiPkg = packages.length > 1;
  const newestPkg = packages[0] || g; // packages are newest-first
  // with multiple versions the primary button grabs the LATEST; single-package
  // games behave as before
  const mainHref = multiPkg
    ? `/api/games/${newestPkg.id}/zip?x=1${dlKey}`
    : (single ? dlHref(files[0].path) : `/api/games/${g.id}/zip?x=1${dlKey}`);
  const shown = files.slice(0, 60);
  const filesHtml = files.length
    ? `<details class="file-list">
        <summary class="muted">${files.length} file${files.length === 1 ? '' : 's'} — download individually</summary>
        ${shown
          .map(
            (f) => `<div class="file-row">
              <span class="file-name">${esc(f.path || g.raw_name)}</span>
              <span class="file-size">${fmtSize(f.size)}</span>
              <a class="btn sm" href="${dlHref(f.path)}" download>↓</a>
            </div>`
          )
          .join('')}
        ${files.length > shown.length ? `<div class="file-row"><span class="file-name muted">…and ${files.length - shown.length} more</span></div>` : ''}
      </details>`
    : '<div class="muted">No files found on disk.</div>';

  // synthetic DLC (split out of a bundle): no files of its own — its content
  // ships inside the base game's package, so point the user there
  const includedParent = g.payload_type === 'dlc-included'
    ? allGames.find((x) => x.status === 'matched' && x.provider === 'steam' && String(x.provider_id) === String(g.meta_parent_id || ''))
    : null;
  const dlBar = g.payload_type === 'dlc-included'
    ? `<div class="dl-bar">
        <div class="dl-bar-info">
          <div class="dl-bar-head">Included with ${esc(g.meta_parent_title || 'the base game')}</div>
          <div class="dl-bar-sub">This DLC ships inside the base game's package — there's nothing separate to download.</div>
        </div>
        ${includedParent ? `<button class="btn primary dl-main" id="detail-open-parent" data-parent-id="${includedParent.id}">View ${esc(titleOf(includedParent))}</button>` : ''}
      </div>`
    : isGuest()
    ? `<div class="dl-bar">
        <div class="dl-bar-info">
          <div class="dl-bar-head">Get this game</div>
          <div class="dl-bar-sub">Browsing as a guest — sign in to download and track your library.</div>
        </div>
        <button class="btn primary dl-main" id="detail-signin">Sign in to download</button>
      </div>`
    : files.length
      ? `<div class="dl-bar">
          <div class="dl-bar-info">
            <div class="dl-bar-head">Ready to download · ${fmtSize(multiPkg ? newestPkg.size_bytes : (single ? files[0].size : totalSize))}</div>
            <div class="dl-bar-sub">${multiPkg ? 'Grabs the latest version — pick another under Versions below.' : (single ? 'Single file, served as-is.' : `${files.length} files packed into one zip on the fly — originals are never modified.`)} For automatic unpack + install + shortcuts, use the desktop app.</div>
          </div>
          <a class="btn primary dl-main" href="${mainHref}" download>Download${multiPkg ? ' latest (zip)' : (single ? '' : ' (zip)')}</a>
        </div>
        ${filesHtml}`
      : `<div class="dl-bar">
          <div class="dl-bar-info">
            <div class="dl-bar-head">Download</div>
            <div class="dl-bar-sub">No files found on disk.</div>
          </div>
        </div>`;

  const vRow = (p) => {
    const v = pkgVersion(p);
    const isNewest = p.id === packages[0].id;
    const action = isGuest()
      ? '<span class="muted sm">sign in to download</span>'
      : `<a class="btn sm primary" href="/api/games/${p.id}/zip?x=1${dlKey}" download>Download</a>`;
    return `<div class="version-row">
      <div class="version-main">
        <div class="version-label">${esc(v ? v.label : 'Unversioned')}${isNewest ? '<span class="v-badge newest">NEWEST</span>' : ''}</div>
        <div class="version-meta">${esc(p.raw_name)} · ${fmtSize(p.size_bytes)}</div>
      </div>
      <div class="version-action">${action}</div>
    </div>`;
  };
  const olderPkgs = packages.slice(1);
  const versionsHtml = packages.length ? `
    <div class="gp-versions">
      <div class="section-head"><h2>Versions</h2><span class="muted">${packages.length === 1 ? '1 version' : `${packages.length} versions`}</span></div>
      <div class="version-list">
        ${vRow(packages[0])}
        ${olderPkgs.length ? `<details class="older-versions">
          <summary>Older versions (${olderPkgs.length})</summary>
          ${olderPkgs.map(vRow).join('')}
        </details>` : ''}
      </div>
    </div>` : '';

  box.innerHTML = `
    <button class="btn back-btn" onclick="history.back()">← Back</button>
    <div class="detail-hero">
      ${heroArt ? `<div class="hero-bg" style="background-image:url('${esc(heroArt)}')"></div>` : ''}
      <div class="hero-fade"></div>
      <div class="hero-content">
        <div class="hero-title-row">
          <div class="hero-title">${esc(title)}</div>
          ${ratingBadges(g.meta_ratings)}
        </div>
        <div class="hero-meta" style="margin-top:10px">
          ${isDlc(g) ? dlcParentChip(g) : ''}
          ${g.meta_year ? `<span class="chip">${g.meta_year}</span>` : ''}
          ${gameGenres(g).map((x) => `<button class="chip genre-chip" data-genre="${esc(x)}" title="Browse ${esc(x)} games">${esc(x)}</button>`).join('')}
          ${g.size_bytes ? `<span class="chip">${fmtSize(g.size_bytes)}</span>` : ''}
          ${g.payload_type === 'dlc-included' ? '' : `<span class="chip">${esc(g.payload_type)}</span>`}
        </div>
        ${priceHtml(g) ? `<div class="hero-price">${priceHtml(g)}${steamLink(g)}</div>` : ''}
      </div>
    </div>
    <div class="dl-section">${dlBar}</div>
    ${mediaHtml(g)}
    <div class="detail-col">
      ${aboutHtml(g)}
      ${compatHtml(g)}
      <div class="card-form">
        <h3>Release info</h3>
        <div>
          ${g.meta_released ? `<div class="kv"><span class="k">Release date</span><span class="v">${esc(g.meta_released)}</span></div>` : ''}
          <div class="kv"><span class="k">Source name</span><span class="v">${esc(g.raw_name)}</span></div>
          <div class="kv"><span class="k">Interpreted as</span><span class="v">${esc(g.clean_name)}</span></div>
          <div class="kv"><span class="k">Matched via</span><span class="v">${esc(g.provider || '—')} · ${g.provider === 'manual' ? 'manual' : `${Math.round((g.confidence || 0) * 100)}%`}</span></div>
          <div class="kv"><span class="k">Payload</span><span class="v">${esc(g.payload_type)}</span></div>
          <div class="kv"><span class="k">Size on disk</span><span class="v">${fmtSize(g.size_bytes)}</span></div>
        </div>
        ${isAdmin()
          ? `<div class="form-actions">
              <button class="btn" id="detail-rematch">Re-match metadata…</button>
              <button class="btn" id="detail-artwork">Change artwork…</button>
              <button class="btn danger" id="detail-ignore">Ignore</button>
            </div>`
          : ''}
      </div>
    </div>
    <div id="dlc-section"></div>
    ${versionsHtml}
    <div id="rematch-panel"></div>`;

  loadDlcSection(g); // fills in async — name resolution can take a moment
  box.querySelector('[data-open-parent]') && (box.querySelector('[data-open-parent]').onclick = (ev) => {
    location.hash = `#/game/${ev.currentTarget.dataset.openParent}`;
  });
  $('#detail-open-parent') && ($('#detail-open-parent').onclick = (ev) => {
    location.hash = `#/game/${ev.currentTarget.dataset.parentId}`;
  });
  box.querySelectorAll('[data-media-idx]').forEach((el) => {
    el.onclick = () => openLightbox(g, parseInt(el.dataset.mediaIdx, 10));
  });
  // genre chips → browse that genre back in the store
  box.querySelectorAll('[data-genre]').forEach((el) => {
    el.onclick = () => { storeFilter = { type: 'genre', value: el.dataset.genre }; storeSort = 'featured'; $('#search').value = ''; location.hash = '#/library'; };
  });
  wireAbout(box);
  wireAboutMedia(box);
  $('#detail-signin') && ($('#detail-signin').onclick = () =>
    showAuth('login', 'Sign in to download this game and track your library.'));

  if (isAdmin()) {
    $('#detail-rematch') && ($('#detail-rematch').onclick = () => openRematch(g));
    $('#detail-artwork') && ($('#detail-artwork').onclick = () => openArtworkPicker(g));
    $('#detail-ignore') && ($('#detail-ignore').onclick = async () => {
      await api(`/api/games/${g.id}/ignore`, { method: 'POST' });
      toast('Ignored');
      location.hash = '#/library';
    });
  }
}

// ---------- cover override: pick from available art or paste a URL ----------
// providers sometimes serve stale portraits (renamed games keep old capsules)
function openArtworkPicker(g) {
  const panel = $('#rematch-panel');
  if (!panel) return;
  let media;
  try { media = JSON.parse(g.meta_media || '{}'); } catch { media = {}; }
  const options = [
    { label: 'Current cover', url: g.meta_cover },
    { label: 'Wide art (header)', url: g.meta_hero },
    ...(media.screenshots || []).slice(0, 6).map((s, i) => ({ label: `Screenshot ${i + 1}`, url: s })),
  ].filter((o, i, arr) => o.url && arr.findIndex((x) => x.url === o.url) === i);

  panel.innerHTML = `<div class="card-form" style="margin-top:16px">
    <h3>Change artwork</h3>
    <p class="hint">The cover comes from the metadata source — if it's stale (renamed games often keep old capsule art on Steam), pick another image or paste a URL.</p>
    <div class="art-options">
      ${options
        .map((o, i) => `<div class="art-opt" data-ai="${i}" title="${esc(o.label)}">
          <img src="${esc(o.url)}" loading="lazy" />
          <span>${esc(o.label)}</span>
        </div>`)
        .join('')}
    </div>
    <div class="queue-actions">
      <input type="text" id="art-url" placeholder="…or paste an image URL" />
      <button class="btn primary" id="art-apply">Use URL</button>
    </div>
  </div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  async function setCover(url) {
    try {
      await api(`/api/games/${g.id}/cover`, { method: 'POST', body: JSON.stringify({ cover: url }) });
      toast('Cover updated');
      lastDataHash = '';
      renderGameDetail(g.id);
    } catch (err) {
      toast(err.message, true);
    }
  }
  $$('#rematch-panel .art-opt').forEach((el) => {
    el.onclick = () => setCover(options[Number(el.dataset.ai)].url);
  });
  $('#art-apply').onclick = () => {
    const url = $('#art-url').value.trim();
    if (url) setCover(url);
  };
}

// ---------- re-match metadata: search providers, pick the right game ----------
async function openRematch(g, query) {
  const panel = $('#rematch-panel');
  if (!panel) return;
  const q = query != null ? query : g.clean_name;
  panel.innerHTML = `<div class="card-form" style="margin-top:16px">
    <h3>Re-match metadata</h3>
    <p class="hint">Currently “${esc(g.meta_title || g.clean_name)}” via ${esc(g.provider || '—')}. Search for the correct game and pick it — this updates the cover, description, and ratings.</p>
    <div class="queue-actions">
      <input type="search" id="rematch-q" value="${esc(q)}" placeholder="Search game title…" />
      <button class="btn" id="rematch-search">Search</button>
    </div>
    <div id="rematch-results"><div class="muted" style="padding:8px 2px">Searching…</div></div>
  </div>`;
  $('#rematch-q').onkeydown = (e) => { if (e.key === 'Enter') openRematch(g, $('#rematch-q').value); };
  $('#rematch-search').onclick = () => openRematch(g, $('#rematch-q').value);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let results;
  try {
    results = await api(`/api/games/${g.id}/search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    $('#rematch-results').innerHTML = `<div class="muted" style="padding:8px 2px">${esc(err.message)}</div>`;
    return;
  }
  if (!results.length) {
    $('#rematch-results').innerHTML = '<div class="muted" style="padding:8px 2px">No candidates — try a different search.</div>';
    return;
  }
  $('#rematch-results').innerHTML = results
    .slice(0, 10)
    .map(
      (c, i) => `<div class="cand" data-ri="${i}">
        <img src="${esc(c.cover || '')}" loading="lazy" onerror="this.style.visibility='hidden'" />
        <div>
          <div class="cand-title">${esc(c.title)}</div>
          <div class="cand-sub">${c.year || '—'} · ${esc(c.genres || 'unknown genre')} · ${esc(c.provider)}</div>
        </div>
        <div class="cand-right ${scoreClass(c.score)}"><div class="cand-pct">${Math.round(c.score * 100)}%</div></div>
      </div>`
    )
    .join('');
  $$('#rematch-results .cand').forEach((row) => {
    row.onclick = async () => {
      const c = results[Number(row.dataset.ri)];
      try {
        await api(`/api/games/${g.id}/match`, {
          method: 'POST',
          body: JSON.stringify({
            provider: c.provider,
            providerId: c.providerId,
            title: c.title,
            year: c.year,
            cover: c.cover,
            summary: c.summary,
            genres: c.genres,
          }),
        });
        toast(`Re-matched to “${c.title}”`);
        lastDataHash = ''; // force library refresh with new cover
        renderGameDetail(g.id);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
}

// ============================================================ activity
let pendingHighlight = null; // gameId to scroll to after next render

async function renderActivity() {
  const list = $('#activity-list');
  const items = allGames.filter((g) => ['pending', 'unmatched', 'downloading'].includes(g.status));
  const needsAction = items.filter((g) => g.status !== 'downloading');
  const badge = $('#nav-badge-activity');
  badge.textContent = needsAction.length;
  badge.classList.toggle('hidden', needsAction.length === 0);

  if (items.length === 0) {
    list.innerHTML = '<div class="empty">Nothing needs attention. Everything is identified. ✓</div>';
    return;
  }
  const details = await Promise.all(
    items.map((g) => (g.status === 'downloading' ? g : api(`/api/games/${g.id}`)))
  );
  list.innerHTML = details.map(renderQueueItem).join('');
  attachActivityHandlers(details);

  if (pendingHighlight != null) {
    const el = document.getElementById(`activity-${pendingHighlight}`);
    pendingHighlight = null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
    }
  }
}

function renderQueueItem(g) {
  if (g.status === 'downloading') {
    return `<div class="queue-item">
      <h3>${esc(g.raw_name)}</h3>
      <div class="meta"><span class="chip">downloading in qBittorrent</span><span>will be identified automatically when complete</span></div>
    </div>`;
  }
  const cands = (g.candidates || [])
    .map((c, i) => {
      const pct = Math.round(c.score * 100);
      return `
    <div class="cand" data-game="${g.id}" data-idx="${i}">
      ${c.cover
        ? `<img src="${esc(c.cover)}" loading="lazy" onerror="this.style.visibility='hidden'" />`
        : `<div class="cand-thumb">${esc((c.title || '?').slice(0, 1))}</div>`}
      <div>
        <div class="cand-title">${esc(c.title)}</div>
        <div class="cand-sub">${c.year || '—'} · ${esc(c.genres || 'unknown genre')} · ${esc(c.provider)}</div>
      </div>
      <div class="cand-right ${scoreClass(c.score)}">
        <div class="cand-pct">${pct}%</div>
        <div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
    })
    .join('');
  return `<div class="queue-item" id="activity-${g.id}">
    <h3>${esc(g.raw_name)}</h3>
    <div class="meta">
      <span class="chip">read as “${esc(g.clean_name)}”${g.hint_year ? ` (${g.hint_year})` : ''}</span>
      <span class="chip">${esc(g.payload_type)}</span>
      <span class="chip">${fmtSize(g.size_bytes)}</span>
      <span>${g.status === 'unmatched' ? 'no confident match' : 'needs review'}</span>
    </div>
    ${cands || '<div class="muted" style="padding:4px 2px 0">No candidates found — try a manual search below.</div>'}
    <div class="queue-actions">
      <input type="search" placeholder="Search metadata manually…" data-search="${g.id}" />
      <button class="btn" data-dosearch="${g.id}">Search</button>
      <button class="btn primary hidden" data-apply="${g.id}">Apply match</button>
      <button class="btn danger" data-ignore="${g.id}">Ignore</button>
    </div>
  </div>`;
}

function attachActivityHandlers(details) {
  const byId = Object.fromEntries(details.filter((d) => d.candidates).map((d) => [d.id, d]));
  const selected = {};

  $$('.cand').forEach((row) => {
    row.onclick = () => {
      const gameId = row.dataset.game;
      $$(`.cand[data-game="${gameId}"]`).forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      selected[gameId] = byId[gameId].candidates[row.dataset.idx];
      $(`[data-apply="${gameId}"]`).classList.remove('hidden');
    };
  });

  $$('[data-apply]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.apply;
      const c = selected[id];
      if (!c) return;
      try {
        await api(`/api/games/${id}/match`, {
          method: 'POST',
          body: JSON.stringify({
            provider: c.provider,
            providerId: c.provider_id || c.providerId,
            title: c.title,
            year: c.year,
            cover: c.cover,
            summary: c.summary,
            genres: c.genres,
          }),
        });
        toast(`Matched as “${c.title}”`);
        refresh(true);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });

  $$('[data-ignore]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/games/${btn.dataset.ignore}/ignore`, { method: 'POST' });
      toast('Ignored');
      refresh(true);
    };
  });

  $$('[data-dosearch]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.dosearch;
      const input = $(`[data-search="${id}"]`);
      const q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      try {
        const results = await api(`/api/games/${id}/search?q=${encodeURIComponent(q)}`);
        byId[id].candidates = results.map((r) => ({ ...r, provider_id: r.providerId }));
        document.getElementById(`activity-${id}`).outerHTML = renderQueueItem(byId[id]);
        attachActivityHandlers(Object.values(byId));
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
  });

  $$('[data-search]').forEach((input) => {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') $(`[data-dosearch="${input.dataset.search}"]`)?.click();
    };
  });
}

// ============================================================ errors / events
let eventFilter = 'all';
$$('#event-filter .subtab').forEach((btn) => {
  btn.onclick = () => {
    eventFilter = btn.dataset.level;
    $$('#event-filter .subtab').forEach((b) => b.classList.toggle('active', b === btn));
    renderEvents();
  };
});
$('#clear-events').onclick = async () => {
  await api('/api/events', { method: 'DELETE' });
  toast('Event log cleared');
  renderEvents();
  refresh(true);
};

async function renderEvents() {
  const list = $('#events-list');
  let events;
  try {
    events = await api(`/api/events?level=${eventFilter}`);
  } catch (err) {
    list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (events.length === 0) {
    list.innerHTML = `<div class="empty">${eventFilter === 'all' ? 'No events logged yet.' : `No ${eventFilter === 'warn' ? 'warnings' : 'errors'}. ✓`}</div>`;
    return;
  }
  const chipClass = { error: 'err', warn: 'warn', info: '' };
  list.innerHTML = events
    .map(
      (e) => `
    <details class="event-row">
      <summary>
        <span class="chip ${chipClass[e.level] || ''}">${esc(e.level)}</span>
        <span class="chip">${esc(e.source)}</span>
        <span class="event-msg">${esc(e.message)}</span>
        <span class="event-actions">
          ${e.action ? `<button class="btn sm primary" data-resolve="${e.id}">${esc(e.action.label || 'Resolve')} →</button>` : ''}
          <button class="btn sm" data-dismiss="${e.id}" title="Dismiss this event">✕</button>
        </span>
        <span class="event-time">${relTime(e.created_at)}</span>
      </summary>
      ${e.detail ? `<div class="event-detail">${esc(e.detail)}</div>` : ''}
    </details>`
    )
    .join('');

  const byId = Object.fromEntries(events.map((e) => [String(e.id), e]));

  $$('[data-dismiss]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await api(`/api/events/${btn.dataset.dismiss}`, { method: 'DELETE' });
      renderEvents();
      refresh(true);
    };
  });

  $$('[data-resolve]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const e = byId[btn.dataset.resolve];
      const action = e.action;
      if (action.gameId != null) {
        // only meaningful if the game still needs attention
        const g = allGames.find((x) => x.id === action.gameId);
        if (!g || !['pending', 'unmatched', 'downloading'].includes(g.status)) {
          await api(`/api/events/${e.id}`, { method: 'DELETE' });
          toast('Already resolved — event dismissed');
          renderEvents();
          refresh(true);
          return;
        }
        pendingHighlight = action.gameId;
      }
      location.hash = action.route || '#/activity';
    };
  });
}

// ============================================================ settings
$$('#settings-tabs .subtab').forEach((btn) => {
  btn.onclick = () => selectSettingsTab(btn.dataset.stab);
});

const pct = (v) => Math.round(v * 100);
$('#set-threshold').oninput = () => ($('#set-threshold-val').textContent = `${$('#set-threshold').value}%`);
$('#set-minscore').oninput = () => ($('#set-minscore-val').textContent = `${$('#set-minscore').value}%`);

async function loadSettingsForm() {
  let s, status;
  try {
    [s, status] = await Promise.all([api('/api/settings'), api('/api/status')]);
  } catch (err) {
    toast(`Could not load settings: ${err.message}`, true);
    return;
  }
  $('#set-librarydir').value = s.libraryDir;
  const libState = $('#library-state');
  if (status.library.ok) {
    libState.textContent = `accessible · ${status.library.entries} item${status.library.entries === 1 ? '' : 's'}`;
    libState.className = 'chip ok';
  } else {
    libState.textContent = 'not accessible';
    libState.className = 'chip err';
    libState.title = status.library.error || '';
  }
  $('#set-threshold').value = pct(s.autoMatchThreshold);
  $('#set-threshold-val').textContent = `${pct(s.autoMatchThreshold)}%`;
  $('#set-minscore').value = pct(s.minCandidateScore);
  $('#set-minscore-val').textContent = `${pct(s.minCandidateScore)}%`;
  $('#set-interval').value = s.scanIntervalMinutes;
  $('#set-rawg').value = s.rawgApiKey;
  $('#set-igdb-id').value = s.igdbClientId;
  $('#set-igdb-secret').value = s.igdbClientSecret;
  $('#set-apikey').value = s.apiKey;
  $('#set-steam').checked = s.steamEnabled;
  $('#src-steam-state').textContent = s.steamEnabled ? 'built-in · no key needed' : 'disabled';
  $('#src-steam-state').className = `chip ${s.steamEnabled ? 'ok' : ''}`;
  $('#src-rawg-state').textContent = s.rawgApiKey ? 'configured' : 'not configured';
  $('#src-rawg-state').className = `chip ${s.rawgApiKey ? 'ok' : ''}`;
  const igdbOk = s.igdbClientId && s.igdbClientSecret;
  $('#src-igdb-state').textContent = igdbOk ? 'configured' : 'not configured';
  $('#src-igdb-state').className = `chip ${igdbOk ? 'ok' : ''}`;
}

async function putSettings(patch, okMessage) {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    toast(okMessage);
    loadSettingsForm();
    refresh(true);
  } catch (err) {
    toast(err.message, true);
  }
}

$('#save-general').onclick = () =>
  putSettings(
    {
      autoMatchThreshold: parseInt($('#set-threshold').value, 10) / 100,
      minCandidateScore: parseInt($('#set-minscore').value, 10) / 100,
      scanIntervalMinutes: parseInt($('#set-interval').value, 10) || 15,
    },
    'General settings saved'
  );

$('#save-library').onclick = async () => {
  await putSettings({ libraryDir: $('#set-librarydir').value.trim() }, 'Library path saved');
  await api('/api/rescan', { method: 'POST' });
  setTimeout(() => {
    loadSettingsForm();
    refresh(true);
  }, 1500);
};

$('#save-sources').onclick = () =>
  putSettings(
    {
      steamEnabled: $('#set-steam').checked,
      rawgApiKey: $('#set-rawg').value.trim(),
      igdbClientId: $('#set-igdb-id').value.trim(),
      igdbClientSecret: $('#set-igdb-secret').value.trim(),
    },
    'Metadata sources saved'
  );

$('#save-security').onclick = async () => {
  const key = $('#set-apikey').value.trim();
  await putSettings({ apiKey: key }, key ? 'API key set' : 'API auth disabled');
  apiKey = key;
  localStorage.setItem('gamehub_apikey', key);
};

$('#test-sources').onclick = async () => {
  const btn = $('#test-sources');
  btn.disabled = true;
  $('#test-results').innerHTML = '<div class="muted">Testing…</div>';
  try {
    const results = await api('/api/settings/test-sources', { method: 'POST' });
    $('#test-results').innerHTML = results.length
      ? results
          .map(
            (r) => `<div class="test-row">
              <span class="chip ${r.ok ? 'ok' : 'err'}">${r.ok ? 'working' : 'failed'}</span>
              <strong>${esc(r.name)}</strong>
              <span class="muted">${r.ok ? `${r.results} results for “Portal”` : esc(r.error)}</span>
            </div>`
          )
          .join('')
      : '<div class="muted">No sources configured — add a key above and save first.</div>';
  } catch (err) {
    $('#test-results').innerHTML = `<div class="test-row"><span class="chip err">error</span><span class="muted">${esc(err.message)}</span></div>`;
  }
  btn.disabled = false;
};

$('#rematch-all').onclick = async () => {
  const r = await api('/api/rematch-all', { method: 'POST' });
  toast(`Re-matching ${r.queued} unresolved item(s)…`);
  setTimeout(() => refresh(true), 3000);
};

// ============================================================ refresh loop
async function refresh(force = false) {
  try {
    const [status, games] = await Promise.all([api('/api/status'), api('/api/games')]);
    loaded = true;

    // sidebar footer + badges
    const dot = $('#source-dot');
    if (status.providers.length) {
      dot.className = 'dot ok';
      $('#side-status').textContent = `${status.providers.join(' + ')} · v${status.version}`;
    } else {
      dot.className = 'dot warn';
      $('#side-status').textContent = 'no sources configured';
    }
    const errBadge = $('#nav-badge-errors');
    errBadge.textContent = status.errorCount;
    errBadge.classList.toggle('hidden', !status.errorCount);

    const banner = $('#banner');
    if (!status.library.ok) {
      banner.innerHTML = `⚠ Library folder “${esc(status.library.path)}” is not accessible — fix it in <a href="#/settings/library">Settings → Library</a>.`;
      banner.classList.remove('hidden');
    } else if (status.providers.length === 0) {
      banner.innerHTML =
        '⚠ No metadata source configured — add one in <a href="#/settings/sources">Settings → Metadata Sources</a>.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const hash = JSON.stringify([games, status.errorCount]);
    if (!force && hash === lastDataHash) return;
    lastDataHash = hash;
    allGames = games;
    rebuildGroups(); // recompute duplicate-package groups
    renderHero();
    renderLibrary();
    renderActivity();
    if (currentRoute() === 'errors') renderEvents();
  } catch (err) {
    if (loaded) toast(`Connection lost: ${err.message}`, true);
    else $('#library-grid').innerHTML = `<div class="empty">Cannot reach server: ${esc(err.message)}</div>`;
  }
}

// ============================================================ auth
let authMode = 'login';

function showAuth(mode, note) {
  authMode = mode;
  $('#auth-screen').classList.remove('hidden');
  $('#auth-title').textContent = mode === 'setup' ? 'Welcome to Gamehub' : 'Sign in';
  $('#auth-sub').textContent =
    note ||
    (mode === 'setup'
      ? 'Create the admin account for this server. You can add more users later in Settings → Users.'
      : 'Sign in to download games and track your library.');
  $('#auth-pass2').classList.toggle('hidden', mode !== 'setup');
  $('#auth-submit').textContent = mode === 'setup' ? 'Create admin account' : 'Sign in';
  $('#auth-error').classList.add('hidden');
  // guests can dismiss the prompt and keep browsing (never in setup mode)
  $('#auth-guest').classList.toggle('hidden', mode === 'setup');
}
$('#auth-guest').onclick = () => hideAuth();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#auth-screen').classList.contains('hidden') && authMode !== 'setup') hideAuth();
});

function hideAuth() {
  $('#auth-screen').classList.add('hidden');
}

async function submitAuth() {
  const username = $('#auth-user').value.trim();
  const password = $('#auth-pass').value;
  const errBox = $('#auth-error');
  errBox.classList.add('hidden');
  if (authMode === 'setup' && password !== $('#auth-pass2').value) {
    errBox.textContent = 'Passwords do not match.';
    errBox.classList.remove('hidden');
    return;
  }
  try {
    const r = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    authToken = data.token;
    localStorage.setItem('gamehub_token', authToken);
    me = data.user;
    profileData = null; socialData = null; // fresh user → drop cached stats
    hideAuth();
    $('#auth-pass').value = '';
    $('#auth-pass2').value = '';
    start();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
}
$('#auth-submit').onclick = submitAuth;
$('#auth-pass').onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };
$('#auth-pass2').onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };
$('#auth-user').onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };

$('#logout-btn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
  authToken = '';
  localStorage.removeItem('gamehub_token');
  me = null;
  location.reload();
};

function isGuest() { return !me || me.role === 'guest'; }
function isAdmin() { return !me || me.role === 'admin' || me.setupMode; }

function applyRole() {
  const admin = isAdmin();
  const guest = isGuest();
  // admin-only nav (Activity / Errors / Settings) hidden for guests & plain users
  $$('aside nav a[data-admin]').forEach((a) => a.classList.toggle('hidden', !admin));
  // sign-in-only nav (Profile / Social) hidden for guests
  $$('aside nav a[data-auth]').forEach((a) => a.classList.toggle('hidden', guest));
  ['general', 'library', 'sources', 'security'].forEach((t) => {
    const tab = $(`#settings-tabs .subtab[data-stab="${t}"]`);
    if (tab) tab.classList.toggle('hidden', !admin);
  });
  $('#users-admin-card')?.classList.toggle('hidden', !admin);
  // sign-in vs sign-out affordance
  $('#signin-btn').classList.toggle('hidden', !guest);
  $('#logout-btn').classList.toggle('hidden', guest);
  if (!guest && me) $('#logout-btn').title = `Sign out ${me.username}`;
  // if a guest is parked on an admin route, send them to the library
  if (!admin && ['activity', 'errors', 'settings'].includes(currentRoute())) {
    location.hash = '#/library';
  }
  // guests can't see profile/social — bounce them to the store
  if (guest && ['profile', 'social'].includes(currentRoute())) {
    location.hash = '#/library';
  }
}
$('#signin-btn').onclick = () => showAuth('login');

// ============================================================ users tab
async function loadUsersTab() {
  $('#acct-name').textContent = me?.username || '— (no account yet)';
  if (!me || me.role !== 'admin') return;
  let users;
  try {
    users = await api('/api/users');
  } catch {
    return;
  }
  $('#users-list').innerHTML = users
    .map(
      (u) => `<div class="user-row">
        <span class="u-name">${esc(u.username)}${me && u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</span>
        <span class="chip ${u.role === 'admin' ? 'conf-manual' : ''}">${esc(u.role)}</span>
        <button class="btn sm" data-ureset="${u.id}">Reset password</button>
        <button class="btn sm danger" data-udel="${u.id}" ${me && u.id === me.id ? 'disabled' : ''}>✕</button>
      </div>`
    )
    .join('');
  $$('#users-list [data-ureset]').forEach((btn) => {
    btn.onclick = async () => {
      const pw = prompt('New password (min 6 characters):');
      if (!pw) return;
      try {
        await api(`/api/users/${btn.dataset.ureset}/reset`, { method: 'POST', body: JSON.stringify({ password: pw }) });
        toast('Password reset');
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  $$('#users-list [data-udel]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this user?')) return;
      try {
        await api(`/api/users/${btn.dataset.udel}`, { method: 'DELETE' });
        toast('User deleted');
        loadUsersTab();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
}

$('#new-user-add').onclick = async () => {
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#new-user-name').value.trim(),
        password: $('#new-user-pass').value,
        role: $('#new-user-role').value,
      }),
    });
    $('#new-user-name').value = '';
    $('#new-user-pass').value = '';
    toast('User created');
    loadUsersTab();
  } catch (err) {
    toast(err.message, true);
  }
};

$('#acct-save').onclick = async () => {
  try {
    const r = await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#acct-current').value, next: $('#acct-next').value }),
    });
    authToken = r.token;
    localStorage.setItem('gamehub_token', authToken);
    $('#acct-current').value = '';
    $('#acct-next').value = '';
    toast('Password changed');
  } catch (err) {
    toast(err.message, true);
  }
};

// ============================================================ boot
let started = false;
function start() {
  applyRole();
  if (started) { refresh(true); return; }
  started = true;
  applyRoute();
  renderLibrary(); // skeletons
  refresh();
  setInterval(refresh, 30_000);
}

(async () => {
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    if (st.setupRequired) {
      showAuth('setup');
      start(); // library visible behind the setup screen
      return;
    }
    // browse as guest by default; a token upgrades to the account
    me = await api('/api/auth/me').catch(() => ({ role: 'guest', username: null }));
    if (me.role === 'guest') { authToken = ''; localStorage.removeItem('gamehub_token'); }
    start();
  } catch {
    start(); // still show the (empty) shell if the server is unreachable
  }
})();
