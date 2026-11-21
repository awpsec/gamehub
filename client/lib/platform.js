// Host-platform abstraction — Windows + Linux (Wine/Proton) launch & shortcuts.
//
// Windows paths are unchanged. Linux uses wineRunner for .exe install/play and
// writes .desktop shortcuts instead of .lnk files.
const path = require('node:path');
const wineRunner = require('./wineRunner');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';

/**
 * How to launch a game executable on this host.
 * Returns { cmd, args, cwd, env? } for child_process.spawn.
 *
 * Linux: wraps Windows .exe via wine / proton / umu (config.linuxRunner).
 * Per-game WINEPREFIX comes from config.winePrefix or entry-level override
 * passed via config by the caller.
 */
function launchCommand(exePath, config = {}) {
  if (isWindows) {
    return { cmd: exePath, args: [], cwd: path.dirname(exePath) };
  }
  if (isLinux) {
    return wineRunner.launchWindowsExe(exePath, config, {
      prefixDir: config.winePrefix || null,
      forInstall: false,
    });
  }
  // macOS: not supported yet (CrossOver/Whisky could slot in here)
  return { cmd: exePath, args: [], cwd: path.dirname(exePath) };
}

/** Whether this host can create desktop / app-menu shortcuts. */
function supportsShortcuts() {
  return isWindows || isLinux;
}

/**
 * Candidate 7-Zip binaries per host (first existing wins; caller verifies).
 * Bundled 7za (via 7zip-bin) is the fallback in installer.find7zip().
 */
function sevenZipCandidates() {
  if (isWindows) {
    return ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'];
  }
  return [
    '/usr/bin/7z',
    '/usr/bin/7za',
    '/usr/local/bin/7z',
    '/usr/local/bin/7za',
    '/app/bin/7z', // flatpak-ish
  ];
}

/** True when Linux has a usable Wine/Proton/umu runner for Windows .exe files. */
function hasWineRunner(config = {}) {
  if (!isLinux) return isWindows; // Windows can run .exe natively
  return wineRunner.hasCompatibleRunner(config);
}

/**
 * Open a Windows .exe (setup wizard / uninstaller) with the right host tool.
 * On Windows: returns null so callers keep using shell.openPath.
 * On Linux: spawns via Wine and returns the ChildProcess.
 */
function openWindowsExe(exePath, config = {}, opts = {}) {
  if (isWindows) return null;
  if (!isLinux) {
    const err = new Error('Opening Windows executables is only supported on Windows and Linux.');
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  return wineRunner.spawnWindowsExe(exePath, config, opts);
}

module.exports = {
  isWindows,
  isLinux,
  isMac,
  launchCommand,
  supportsShortcuts,
  sevenZipCandidates,
  hasWineRunner,
  openWindowsExe,
  wineRunner,
};
