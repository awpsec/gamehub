// Host-platform abstraction — the seam where Linux support plugs in.
//
// GROUNDWORK ONLY for now: Windows is fully supported; the Linux branches are
// scaffolded and marked TODO(linux) so the Linux install/launch flow can be
// built without touching the Windows paths.
const path = require('node:path');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';

// How to launch a game executable on this host.
// Returns { cmd, args, cwd } for child_process.spawn.
//
// TODO(linux): flesh out the runner strategy —
//  - config.linuxRunner: 'wine' (default) | 'proton' | 'umu' | custom template
//  - Proton needs STEAM_COMPAT_DATA_PATH + STEAM_COMPAT_CLIENT_INSTALL_PATH env
//    and is invoked as `proton run <exe>`; umu-launcher wraps this nicely.
//  - Lutris integration: `lutris -e <exe>` or per-game yml configs.
//  - Per-game runner override should live in installed.json entry.runner.
//  - Wine prefix per game: WINEPREFIX under the install dir keeps saves tidy.
function launchCommand(exePath, config = {}) {
  if (isWindows) {
    return { cmd: exePath, args: [], cwd: path.dirname(exePath) };
  }
  if (isLinux) {
    const runner = config.linuxRunner || 'wine';
    // TODO(linux): proton/umu need env + different arg shapes (see above)
    return { cmd: runner, args: [exePath], cwd: path.dirname(exePath) };
  }
  // TODO(mac): CrossOver/whisky could slot in here
  return { cmd: exePath, args: [], cwd: path.dirname(exePath) };
}

// Whether this host can create the shortcut types we support.
// TODO(linux): .desktop files in ~/.local/share/applications instead of .lnk
function supportsShortcuts() {
  return isWindows;
}

// Candidate 7-Zip binaries per host (first existing wins; caller verifies).
// TODO(linux): p7zip ships as 7z/7za on PATH; flatpak users may differ.
function sevenZipCandidates() {
  if (isWindows) {
    return ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'];
  }
  return ['/usr/bin/7z', '/usr/bin/7za', '/usr/local/bin/7z'];
}

module.exports = { isWindows, isLinux, isMac, launchCommand, supportsShortcuts, sevenZipCandidates };
