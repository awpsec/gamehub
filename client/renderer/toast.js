// Toast payload arrives as query params (title/body/img/ms) — no IPC needed.
const q = new URLSearchParams(location.search);
const ms = Math.min(Math.max(parseInt(q.get('ms') || '4500', 10) || 4500, 1200), 12000);
document.getElementById('title').textContent = q.get('title') || '';
const body = q.get('body') || '';
const bodyEl = document.getElementById('body');
bodyEl.textContent = body;
bodyEl.style.display = body ? '' : 'none';
const img = q.get('img');
if (img) {
  const t = document.getElementById('thumb');
  t.src = img;
  t.classList.remove('hidden');
  t.onerror = () => t.remove();
  document.getElementById('logo').style.display = 'none';
}
setTimeout(() => document.getElementById('bubble').classList.add('done'), ms);
