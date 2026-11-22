// Small, testable pieces of the app's lifecycle around updates:
//   • a rotating updater log (electron-updater only logged to a console nobody
//     sees, so a failed update left no trace)
//   • the installer's "please quit" request: the Windows installer drops a file
//     in userData before its own "is Gamehub running?" check. A per-user
//     installer can't kill an ELEVATED Gamehub (Settings → Run as
//     administrator), but Gamehub can see the file and quit itself.
const fs = require('node:fs');
const path = require('node:path');

const QUIT_REQUEST_FILE = 'quit-for-update';
const LOG_MAX_BYTES = 256 * 1024;

function makeLogger(dir, name = 'updater.log', { maxBytes = LOG_MAX_BYTES, now = () => new Date() } = {}) {
  const file = path.join(dir, name);
  return {
    file,
    write(level, ...parts) {
      const msg = parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
      const line = `${now().toISOString()} [${level}] ${msg}\n`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        try {
          if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`); // keep one old copy
        } catch { /* no file yet */ }
        fs.appendFileSync(file, line, 'utf8');
      } catch { /* logging must never break the app */ }
      return line;
    },
  };
}

/**
 * Poll userData for the installer's quit request. Polling (not fs.watch) so it
 * works whoever wrote the file and on every filesystem. Clears a stale request
 * on start. Returns stop().
 */
function watchQuitRequest(dir, onRequest, { intervalMs = 1500, _setInterval = setInterval, _clearInterval = clearInterval } = {}) {
  const file = path.join(dir, QUIT_REQUEST_FILE);
  try { fs.rmSync(file, { force: true }); } catch { /* */ }
  let fired = false;
  const timer = _setInterval(() => {
    if (fired) return;
    let present = false;
    try { present = fs.existsSync(file); } catch { /* */ }
    if (!present) return;
    fired = true;
    try { fs.rmSync(file, { force: true }); } catch { /* */ }
    try { onRequest(); } catch { /* */ }
  }, intervalMs);
  timer?.unref?.();
  return () => _clearInterval(timer);
}

module.exports = { makeLogger, watchQuitRequest, QUIT_REQUEST_FILE };
