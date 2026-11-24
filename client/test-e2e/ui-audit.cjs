// UI audit (CI): render every view/state of the client renderer with fake data
// and FAIL on layout bleed — oversized icons/images (2.1.1's giant update
// button), horizontal overflow, giant / off-screen buttons, text spilling out
// of buttons, render errors.   node test-e2e/ui-audit.cjs <screenshotDir>
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.argv[2] || require('os').tmpdir();
require('fs').mkdirSync(OUT, { recursive: true });
const titles = ['Hollow Lantern', 'Iron Coast', 'Night Relay', 'Saltwind', 'Glass Orchard', 'Dune Static', 'Ember Rail', 'Quiet Signal', 'A Very Long Game Title That Goes On And On: Definitive Edition', 'Moss DLC'];
const games = titles.map((t, i) => ({
  id: i + 1, rel_path: t, raw_name: t + (i === 2 ? '-RUNE' : ''), clean_name: t, meta_title: t, status: 'matched',
  payload_type: ['folder', 'multipart-archive', 'iso', 'archive'][i % 4], size_bytes: 3e9 + i * 7e8, meta_year: 2018 + i,
  meta_genres: 'Action, Adventure, RPG', meta_summary: 'A game. '.repeat(30), created_at: '2026-11-20 10:00:00',
  meta_kind: i === 9 ? 'dlc' : 'game', meta_parent_id: i === 9 ? 1 : null,
  meta_ratings: JSON.stringify({ metacritic: { score: 80 + i } }),
}));
const installed = {
  1: { title: titles[0], status: 'installed', exe: 'C:\\G\\a.exe', dir: 'C:\\Program Files (x86)\\Gamehub\\games\\Hollow Lantern', packageId: 1 },
  2: { title: titles[1], status: 'needs-install', installer: 'C:\\G\\setup.exe', dir: 'C:\\G\\Iron Coast', packageId: 2 },
  3: { title: titles[2], status: 'needs-exe', dir: 'C:\\G\\Night Relay', packageId: 3 },
  9: { title: titles[8], status: 'installed', exe: 'C:\\G\\x.exe', dir: 'C:\\G\\Long', packageId: 9 },
};
const stub = `(() => {
  const games = ${JSON.stringify(games)};
  const installed = ${JSON.stringify(installed)};
  const base = {
    getConfig: async () => ({ hostPlatform: 'win32', gamesDir: 'C:\\\\Program Files (x86)\\\\Gamehub\\\\games', suggestedGamesDir: 'C:\\\\Program Files (x86)\\\\Gamehub\\\\games', serverUrl: 'http://nas:8686', authToken: 'x', username: 'zedd', autoSilentInstall: true, applyReleaseCrack: true, theme: window.__theme || 'light' }),
    authStatus: async () => ({ signedIn: true, user: { username: 'zedd', role: 'admin' }, setupRequired: false, authRequired: true }),
    getLibrary: async () => ({ status: { games: games.length }, games, installed, myLibrary: [1, 2, 3, 4, 9], favorites: [1], playtime: { 1: { seconds: 51234, lastPlayed: new Date().toISOString() } }, categories: { categories: [{ id: 'c1', name: 'Favourites of all time with a long name', games: [1] }], collapsed: {} } }),
    getUpdateStatus: async () => ({ status: 'idle' }),
    getCategories: async () => ({ categories: [], collapsed: {} }),
    getDlc: async () => ({ dlc: [] }),
    listScreenshots: async () => [],
    myStats: async () => ({ totalSeconds: 51234, games: [] }),
  };
  window.gamehub = new Proxy(base, { get: (t, k) => t[k] || ((...a) => { if (String(k).startsWith('on')) return; return Promise.resolve(null); }) });
})();`;

const detect = () => {
  const out = [];
  const vw = innerWidth;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const where = (el) => { const p = []; for (let e = el; e && e !== document.body && p.length < 4; e = e.parentElement) p.unshift(e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}${e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''}`); return p.join(' > '); };
  const art = '.hero-bg, .cover, .card-cover, .lb-stage, .lightbox, .media-strip, .gp-media, .hp-media, .featured, .hero-media, .shot-thumb, .auth-brand, .sb-brand, .empty, .empty-state, .pfp, .profile-avatar, .media';
  for (const el of document.querySelectorAll('svg, img, video')) {
    if (!vis(el) || el.closest(art)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 44 || r.height > 44) out.push(`BIG ${el.tagName.toLowerCase()}.${el.getAttribute('class') || ''} ${Math.round(r.width)}x${Math.round(r.height)} @ ${where(el)}`);
  }
  // list rows must stay rows: thumbnail beside the text, not stacked (the
  // shared .empty class once turned art-less Downloads rows into a tall stack)
  for (const row of document.querySelectorAll('.dl-row')) {
    if (!vis(row)) continue;
    const t = row.querySelector('.dl-thumb')?.getBoundingClientRect();
    const m = row.querySelector('.dl-main')?.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.height > 170) out.push(`ROW TOO TALL ${where(row)} h=${Math.round(r.height)}`);
    if (t && m && m.left < t.right - 1) out.push(`ROW STACKED ${where(row)} (text under the thumbnail)`);
  }
  if (document.documentElement.scrollWidth > vw + 1) out.push(`PAGE OVERFLOW x: ${document.documentElement.scrollWidth} > ${vw}`);
  for (const el of document.querySelectorAll('button, .btn, a.btn, .chip, .nav-btn, .pill')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 60 && !el.closest(art) && !el.matches('.card, .card *, .lib-row, .hero-arrow, .sb-account, .theme-opt, .theme-opt *, .profile-card, .tile')) out.push(`TALL ${where(el)} h=${Math.round(r.height)}`);
    if (r.right > vw + 2 && !el.closest('.lb-strip, .hero, .media, .shelf, .row-scroll, .carousel')) out.push(`OFFSCREEN ${where(el)} right=${Math.round(r.right)}`);
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === 'visible' && !el.closest('.card')) out.push(`TEXT SPILLS ${where(el)} (${el.textContent.trim().slice(0, 30)})`);
  }
  return out;
};

(async () => {
  const browser = await chromium.launch();
  const report = [];
  let failures = 0;
  for (const [vw, vh, theme] of [[1440, 900, 'light'], [960, 640, 'dark']]) {
    const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.exposeFunction('__renderError', (m) => errs.push(m));
    await page.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => { setTimeout(() => { const t = window.toast; if (t) window.toast = (m, e) => { if (/Render error/.test(m)) window.__renderError(m); return t(m, e); }; }, 0); }); });
    await page.addInitScript(`window.__theme=${JSON.stringify(theme)};`);
    await page.addInitScript(stub);
    await page.goto('file://' + path.resolve(process.env.UI_AUDIT_INDEX || path.join(__dirname, '..', 'renderer', 'index.html')));
    await page.waitForTimeout(1800);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const shot = async (name, setup) => {
      try { await page.evaluate(setup); } catch (e) { report.push(`[${vw}] ${name}: setup error ${e.message}`); }
      await page.waitForTimeout(450);
      const found = await page.evaluate(detect);
      // the welcome screen's two choice cards are big on purpose
      const real = found.filter((f) => !/#choose-(server|local)/.test(f));
      failures += real.length;
      report.push(`[${vw} ${theme}] ${name}: ${real.length ? '\n   ' + real.join('\n   ') : 'clean'}`);
      await page.screenshot({ path: `${OUT}/${vw}-${name}.png` });
    };
    const S = (js) => new Function(js);
    await shot('store', S("switchView('store')"));
    await shot('store-search', S("$('#search').value='a'; $('#search').dispatchEvent(new Event('input')); "));
    await shot('game-not-installed', S("$('#search').value=''; openGamePage(4)"));
    await shot('game-options-open', S("openGamePage(4); setTimeout(()=>document.querySelector('.gp-options-btn')?.click(),100)"));
    await shot('game-installed', S("openGamePage(1)"));
    await shot('game-needs-install', S("openGamePage(2)"));
    await shot('game-needs-exe', S("openGamePage(3)"));
    await shot('game-long-title', S("openGamePage(9)"));
    await shot('game-busy', S("state.tasks[5]={phase:'downloading',pct:42,message:'Downloading part 31 of 111 — rune-mygame.r30 (12.4 MB/s, 3 min left)'}; openGamePage(5)"));
    await shot('game-installing-auto', S("state.tasks[6]={phase:'installing-auto',message:'Installing automatically — approve the Windows permission prompt if asked'}; openGamePage(6)"));
    await shot('library', S("switchView('library')"));
    await shot('library-selected', S("state.selectedLib=1; render()"));
    await shot('library-needs-exe', S("state.selectedLib=3; render()"));
    await shot('downloads', S("switchView('downloads')"));
    await shot('screenshots', S("switchView('shots')"));
    await shot('update-downloading', S("switchView('store'); applyUpdateStatus({status:'downloading',version:'2.1.2',percent:7})"));
    await shot('update-ready', S("applyUpdateStatus({status:'ready',version:'2.1.2'})"));
    await shot('account-menu', S("document.querySelector('#account-btn').click()"));
    await shot('install-options-dialog', S("document.body.click(); openInstallDialog(4)"));
    await shot('confirm-dialog', S("document.querySelectorAll('.modal:not(#ask-modal):not(#edit-modal)').forEach(m=>m.remove()); askLocal({title:'Update Gamehub?',message:'Version 2.1.2 is ready to install.',detail:'Gamehub will restart to finish the update.',confirmLabel:'Update & restart',cancelLabel:'Later'})"));
    await shot('toasts', S("document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden')); toast('Installed & verified. Ready to play.'); toast('Gamehub needs your OK once to set up its games folder (C:\\\\Program Files (x86)\\\\Gamehub\\\\games), like Steam does for its own. Click Install again and choose Yes.', true)"));
    for (const tab of ['connection', 'downloads', 'shortcuts', 'ingame', 'appearance', 'updates']) {
      await shot(`settings-${tab}`, S(`openSettings('${tab}')`));
    }
    for (const step of ['choose', 'server', 'login', 'register', 'local', 'folder']) {
      await shot(`auth-${step}`, S(`switchView('store'); $('#auth-screen').classList.remove('hidden'); document.querySelectorAll('.auth-box').forEach(b=>b.classList.add('hidden')); const b=document.getElementById('auth-step-${step}'); if(b) b.classList.remove('hidden');`));
    }
    await page.evaluate(() => $('#auth-screen').classList.add('hidden'));
    if (errs.length) { failures += errs.length; report.push(`[${vw}] page errors: ${[...new Set(errs)].join(' | ')}`); }
    await page.close();
  }
  console.log(report.join('\n'));
  await browser.close();
  console.log(failures ? `\n${failures} problem(s)` : '\nUI audit clean');
  process.exit(failures ? 1 : 0);
})();
