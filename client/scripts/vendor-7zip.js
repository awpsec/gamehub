#!/usr/bin/env node
// Put a FULL 7-Zip (RAR + ISO capable) into client/vendor/7zip/<os>/ so
// electron-builder ships it under resources/7zip (see package.json
// extraResources). The 7za from 7zip-bin reads neither RAR nor ISO — scene
// releases (multi-part RAR → ISO → setup) can't be unpacked without this.
//
//   Windows:  copies 7z.exe + 7z.dll + License.txt from an installed 7-Zip
//             (GitHub's Windows runners ship it in Program Files).
//   Linux:    --linux-tarball <7zXXXX-linux-x64.tar.xz> from 7-zip.org; takes
//             the statically linked 7zzs (Debian/Ubuntu "+dfsg" builds have
//             RAR removed, so the distro package is no good).
//
//   --require   exit 1 if nothing could be vendored (CI release builds)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const vendorRoot = path.join(__dirname, '..', 'vendor', '7zip');

function fail(msg) {
  console.error(`[vendor-7zip] ${msg}`);
  process.exit(flag('--require') ? 1 : 0);
}

function vendorWindows() {
  const dirs = [
    process.env.SEVENZIP_DIR,
    'C:\\Program Files\\7-Zip',
    'C:\\Program Files (x86)\\7-Zip',
  ].filter(Boolean);
  const src = dirs.find((d) => fs.existsSync(path.join(d, '7z.exe')) && fs.existsSync(path.join(d, '7z.dll')));
  if (!src) return fail('no installed 7-Zip (7z.exe + 7z.dll) found');
  const out = path.join(vendorRoot, 'win');
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['7z.exe', '7z.dll', 'License.txt']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(out, f));
  }
  return path.join(out, '7z.exe');
}

function vendorLinux() {
  const tarball = opt('--linux-tarball');
  if (!tarball || !fs.existsSync(tarball)) return fail('pass --linux-tarball <7z…-linux-x64.tar.xz>');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '7z-'));
  execFileSync('tar', ['-xJf', tarball, '-C', tmp], { stdio: 'inherit' });
  const bin = ['7zzs', '7zz'].map((n) => path.join(tmp, n)).find((p) => fs.existsSync(p));
  if (!bin) return fail('tarball has no 7zzs/7zz');
  const out = path.join(vendorRoot, 'linux');
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(bin, path.join(out, '7zz'));
  fs.chmodSync(path.join(out, '7zz'), 0o755);
  for (const f of ['License.txt', 'readme.txt']) {
    if (fs.existsSync(path.join(tmp, f))) fs.copyFileSync(path.join(tmp, f), path.join(out, f));
  }
  return path.join(out, '7zz');
}

const exe = process.platform === 'win32' ? vendorWindows() : vendorLinux();
if (!exe) process.exit(flag('--require') ? 1 : 0);

// Prove it: the binary runs and lists the RAR + ISO handlers.
const info = execFileSync(exe, ['i'], { encoding: 'utf8' });
const formats = ['Rar', 'Rar5', 'Iso', 'Udf'].filter((f) => new RegExp(`\\b${f}\\b`).test(info));
console.log(`[vendor-7zip] ${exe}\n[vendor-7zip] ${info.split(/\r?\n/).find((l) => /7-Zip/.test(l)) || ''}\n[vendor-7zip] formats: ${formats.join(', ')}`);
if (!formats.includes('Rar') || !formats.includes('Iso')) fail('vendored 7-Zip lacks RAR or ISO support');
