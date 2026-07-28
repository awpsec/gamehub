// Linux application-menu integration for portable runs (AppImage).
// .deb installs already ship /usr/share/applications/*.desktop via electron-builder.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const DESKTOP_ID = 'gamehub-client.desktop';

function isLinux() {
  return process.platform === 'linux';
}

/** True when running from an AppImage (APPIMAGE env set by the runtime). */
function isAppImage() {
  return !!(process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE));
}

function applicationsDir() {
  return path.join(os.homedir(), '.local', 'share', 'applications');
}

function iconsDir(size = 256) {
  return path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps');
}

function desktopPath() {
  return path.join(applicationsDir(), DESKTOP_ID);
}

function resolveIconSource() {
  // Packaged: prefer unpacked build resources; fall back to renderer logo.
  const candidates = [
    path.join(process.resourcesPath || '', 'icons', '256x256.png'),
    path.join(__dirname, '..', 'build', 'icons', '256x256.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'renderer', 'logo.svg'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function resolveExec() {
  if (isAppImage()) return process.env.APPIMAGE;
  // Packaged .deb / unpacked: Electron executable
  if (process.defaultApp) return null; // npm start — skip
  return process.execPath;
}

function desktopEntryInstalled() {
  return fs.existsSync(desktopPath());
}

/**
 * Write ~/.local/share/applications/gamehub-client.desktop (+ icon) so the
 * AppImage (or portable build) appears in the application menu.
 */
function installUserDesktopEntry() {
  if (!isLinux()) return { ok: false, reason: 'not-linux' };
  const exec = resolveExec();
  if (!exec) return { ok: false, reason: 'dev-mode' };

  fs.mkdirSync(applicationsDir(), { recursive: true });
  const iconSrc = resolveIconSource();
  let iconName = 'gamehub-client';
  if (iconSrc && iconSrc.endsWith('.png')) {
    const destDir = iconsDir(256);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'gamehub-client.png');
    fs.copyFileSync(iconSrc, dest);
    // Also drop smaller sizes when we have a 256 — DEs pick nearest.
    for (const size of [48, 128]) {
      try {
        const sized = path.join(__dirname, '..', 'build', 'icons', `${size}x${size}.png`);
        if (fs.existsSync(sized)) {
          const d = iconsDir(size);
          fs.mkdirSync(d, { recursive: true });
          fs.copyFileSync(sized, path.join(d, 'gamehub-client.png'));
        }
      } catch { /* optional */ }
    }
  } else if (iconSrc) {
    iconName = iconSrc; // absolute path fallback (svg)
  }

  const execEsc = String(exec).replace(/(["`$\\])/g, '\\$1');
  const body = [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=Gamehub',
    'GenericName=Game Library',
    'Comment=Self-hosted game library — install and play via Wine/Proton',
    `Exec="${execEsc}" %U`,
    `Icon=${iconName}`,
    'Terminal=false',
    'Categories=Game;Utility;',
    'Keywords=games;library;wine;proton;',
    'StartupWMClass=Gamehub',
    'StartupNotify=true',
    'X-AppImage-Integrate=true',
    '',
  ].join('\n');

  const dest = desktopPath();
  fs.writeFileSync(dest, body, 'utf8');
  try { fs.chmodSync(dest, 0o755); } catch { /* */ }

  // Refresh caches (best-effort; ignore failures on minimal systems)
  try { spawnSync('update-desktop-database', [applicationsDir()], { stdio: 'ignore' }); } catch { /* */ }
  try {
    spawnSync('gtk-update-icon-cache', ['-f', '-t', path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')], { stdio: 'ignore' });
  } catch { /* */ }
  try { spawnSync('xdg-desktop-menu', ['forceupdate'], { stdio: 'ignore' }); } catch { /* */ }

  return { ok: true, path: dest, exec, appImage: isAppImage() };
}

function removeUserDesktopEntry() {
  if (!isLinux()) return { ok: false, reason: 'not-linux' };
  const dest = desktopPath();
  try { fs.rmSync(dest, { force: true }); } catch { /* */ }
  try { spawnSync('update-desktop-database', [applicationsDir()], { stdio: 'ignore' }); } catch { /* */ }
  return { ok: true };
}

function status() {
  return {
    linux: isLinux(),
    appImage: isAppImage(),
    installed: desktopEntryInstalled(),
    path: desktopPath(),
    exec: resolveExec(),
  };
}

module.exports = {
  isAppImage,
  desktopEntryInstalled,
  installUserDesktopEntry,
  removeUserDesktopEntry,
  status,
};
