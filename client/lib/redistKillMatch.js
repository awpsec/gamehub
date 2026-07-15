// Pure matching rules for FitGirl/Inno redistributable + promo process kills.
// Kept in JS so we can stress-test without Windows. PowerShell runners must
// stay semantically aligned (see server/test/silent-install-stress.test.mjs).

function baseName(name) {
  if (!name) return '';
  const s = String(name).replace(/^.*[\\/]/, '');
  return s.replace(/\.(exe|msi|bat|cmd)$/i, '').toLowerCase();
}

function isRedistProcessName(name) {
  const n = baseName(name);
  if (!n) return false;
  if (n === 'dxsetup' || n === 'dxwebsetup' || n === 'oalinst') return true;
  if (/vcredist|vc_redist/.test(n)) return true;
  if (/^dotnetfx|^ndp\d|physx|xnafx|ue4prereq|ue5prereq/.test(n)) return true;
  if (/directx/.test(n)) return true;
  return false;
}

function isRedistCommandLine(cmd) {
  if (!cmd) return false;
  const c = String(cmd);
  if (/vcredist|VC_redist|VCRedist|DXSETUP|dxwebsetup|oalinst/i.test(c)) return true;
  if (/DirectX.{0,80}(Setup|Redistributable|Runtime)|\\DirectX\\/i.test(c)) return true;
  if (/\\_?CommonRedist\\|\\_Redist\\|\\Redist\\/i.test(c)) return true;
  if (/dotnetfx|NDP\d+|PhysX|XNAFX/i.test(c)) return true;
  if (/fitgirl-repacks|fitgirl\.site|paste\.fitgirl|fg-repacks/i.test(c)) return true;
  return false;
}

function isPromoHost(name) {
  const n = baseName(name);
  return /^(chrome|msedge|firefox|iexplore|brave|opera|cmd|powershell|pwsh|rundll32|explorer)$/.test(n);
}

function isPromoCommandLine(cmd) {
  if (!cmd) return false;
  return /fitgirl-repacks|fitgirl\.site|fitgirl\.repacks|paste\.fitgirl|fg-repacks/i.test(String(cmd));
}

/**
 * Decide whether a process should be killed during silent install.
 * @param {{ pid:number, name:string, commandLine?:string }} proc
 * @param {{ protectPid?:number, selfPid?:number }} opts
 */
function shouldKillInstallerExtra(proc, { protectPid = 0, selfPid = 0 } = {}) {
  const pid = Number(proc.pid) || 0;
  if (!pid) return false;
  if (protectPid > 0 && pid === protectPid) return false;
  if (selfPid > 0 && pid === selfPid) return false;

  const base = baseName(proc.name);
  const cmd = proc.commandLine ? String(proc.commandLine) : '';

  if (isRedistProcessName(base)) return true;

  if (isRedistCommandLine(cmd)) {
    if (/^(msiexec|cmd|powershell|pwsh|conhost)$/.test(base) || isRedistProcessName(base)) {
      return true;
    }
    if (isPromoCommandLine(cmd) && isPromoHost(base)) return true;
    // setup.exe / installers living under redist folders (not the protected game setup)
    if (/\\_?CommonRedist\\|\\_Redist\\|\\DirectX\\/i.test(cmd)) {
      if (/^(setup|install|redist|dx|vc)/.test(base) || /setup|install|redist|dx|vc/.test(base)) {
        return true;
      }
    }
  }

  if (isPromoCommandLine(cmd) && isPromoHost(base)) return true;
  return false;
}

module.exports = {
  baseName,
  isRedistProcessName,
  isRedistCommandLine,
  isPromoHost,
  isPromoCommandLine,
  shouldKillInstallerExtra,
};
