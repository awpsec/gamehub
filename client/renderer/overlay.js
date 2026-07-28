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

// ---------------------------------------------------------------- panes
function selectPane(which) {
  $('#nav-browser').classList.toggle('active', which === 'browser');
  $('#nav-shots').classList.toggle('active', which === 'shots');
  $('#pane-browser').classList.toggle('hidden', which !== 'browser');
  $('#pane-shots').classList.toggle('hidden', which !== 'shots');
  if (which === 'shots') renderShots();
}
$('#nav-browser').onclick = () => selectPane('browser');
$('#nav-shots').onclick = () => selectPane('shots');

// ---------------------------------------------------------------- browser
const web = $('#ov-web');
const urlBox = $('#bb-url');
function normUrl(input) {
  const v = (input || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v)) return `https://${v}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
}
function syncNavButtons() {
  $('#bb-back').disabled = !web.canGoBack();
  $('#bb-fwd').disabled = !web.canGoForward();
}
$('#bb-go').onclick = () => { const u = normUrl(urlBox.value); if (u) web.loadURL(u).catch(() => {}); };
urlBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bb-go').click(); });
$('#bb-back').onclick = () => web.canGoBack() && web.goBack();
$('#bb-fwd').onclick = () => web.canGoForward() && web.goForward();
$('#bb-reload').onclick = () => web.reload();
$('#bb-external').onclick = () => {
  const u = web.getURL();
  if (/^https?:\/\//i.test(u)) ov.openExternal(u);
};
web.addEventListener('did-navigate', (e) => { urlBox.value = e.url; syncNavButtons(); });
web.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { urlBox.value = e.url; syncNavButtons(); } });
web.addEventListener('new-window', (e) => { // target=_blank opens inside the guest
  e.preventDefault();
  if (/^https?:\/\//i.test(e.url)) web.loadURL(e.url).catch(() => {});
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
  $('#hint-close').innerHTML = `<b>${esc(st.keys.overlay)}</b> or <b>Esc</b> — back to game`;
  $('#hint-shot').innerHTML = `<b>${esc(st.keys.screenshot)}</b> — take a screenshot`;
  $('#shot-key-hint').textContent = st.keys.screenshot;
  $('#shots-capture').textContent = `Capture now (${st.keys.screenshot})`;
  renderShots();
}

async function capture() {
  const entry = await ov.capture();
  if (entry) {
    st.shots = [entry, ...(st.shots || []).filter((s) => s.file !== entry.file)];
    renderShots();
  }
}
$('#nav-capture').onclick = capture;
$('#shots-capture').onclick = capture;
$('#shots-refresh').onclick = refresh;

$('#nav-quit').onclick = async () => { await ov.exitGame(); };

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

// ---------------------------------------------------------------- chrome
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#viewer').classList.contains('hidden')) closeViewer();
    else if (document.activeElement === urlBox) urlBox.blur();
    else ov.close();
  }
  if (!$('#viewer').classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') $('#viewer-prev').click();
    if (e.key === 'ArrowRight') $('#viewer-next').click();
  }
});

setInterval(() => {
  if (st?.game) $('#ov-timer').textContent = fmtElapsed(st.game.started);
  const d = new Date();
  $('#ov-clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}, 1000);

selectPane('browser'); // every open starts on the browser, like Steam
refresh();
