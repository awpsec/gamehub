// Emulators Gamehub can set up and launch games with.
//
// One record per emulator: what it plays, how to find an existing install,
// where its OFFICIAL builds come from, how to make the copy portable (so its
// keys/saves live next to it), and how to start a game. Download sources are
// tried in order; CI resolves and downloads each one for real
// (test-e2e/emulators.e2e.js) so a moved host is caught before users see it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

const EMULATORS = {
  eden: {
    id: 'eden',
    name: 'Eden',
    platforms: ['switch'],
    exe: { win32: ['eden.exe', 'yuzu.exe'], linux: ['eden', 'Eden*.AppImage', 'eden*.AppImage'] },
    args: (rom, { fullscreen = true } = {}) => [...(fullscreen ? ['-f'] : []), '-g', rom],
    // "user" next to the exe = portable mode (keys, firmware, saves inside)
    portable: { dir: 'user' },
    userDirs: { win32: ['%APPDATA%\\eden'], linux: ['~/.local/share/eden'] },
    keysSub: 'keys',
    firmwareSub: path.join('nand', 'system', 'Contents', 'registered'),
    sources: [
      // Eden's own Forgejo (verified in CI); GitHub mirror as a fallback
      { type: 'forgejo', base: 'https://git.eden-emu.dev', repo: 'eden-emu/eden', asset: { win32: /windows.*(amd64|x64|x86_64).*\.(zip|7z)$/i, linux: /(amd64|x86_64).*\.AppImage$/i } },
      { type: 'github', repo: 'eden-emulator/Releases', asset: { win32: /windows.*(amd64|x64|x86_64).*\.(zip|7z)$/i, linux: /(amd64|x86_64).*\.AppImage$/i } },
    ],
    needs: ['keys', 'firmware'],
  },
  ryujinx: {
    id: 'ryujinx',
    name: 'Ryujinx',
    platforms: ['switch'],
    exe: { win32: ['Ryujinx.exe'], linux: ['Ryujinx', 'ryujinx*.AppImage', 'Ryujinx*.AppImage'] },
    args: (rom, { fullscreen = true } = {}) => [...(fullscreen ? ['--fullscreen'] : []), rom],
    portable: { dir: 'portable' },
    userDirs: { win32: ['%APPDATA%\\Ryujinx'], linux: ['~/.config/Ryujinx'] },
    keysSub: 'system',
    firmwareSub: path.join('bis', 'system', 'Contents', 'registered'),
    sources: [
      // the community continuation hosts on its own GitLab
      { type: 'gitlab', base: 'https://git.ryujinx.app', project: 'ryubing/ryujinx', asset: { win32: /win[_-]?x64\.zip$/i, linux: /linux[_-]?x64\.AppImage$/i } },
      { type: 'gitlab', base: 'https://git.ryujinx.app', project: 'Ryubing/Ryujinx', asset: { win32: /win[_-]?x64\.zip$/i, linux: /linux[_-]?x64\.AppImage$/i } },
    ],
    needs: ['keys', 'firmware'],
  },
  dolphin: {
    id: 'dolphin',
    name: 'Dolphin',
    platforms: ['wii', 'gamecube'],
    exe: { win32: ['Dolphin.exe'], linux: ['dolphin-emu', 'Dolphin*.AppImage'] },
    // -b: close Dolphin when the game stops (so playtime ends with the game)
    args: (rom, { fullscreen = true } = {}) => ['-b', ...(fullscreen ? ['-C', 'Dolphin.Display.Fullscreen=True'] : []), '-e', rom],
    portable: { file: 'portable.txt' },
    userDirs: { win32: ['%USERPROFILE%\\Documents\\Dolphin Emulator', '%APPDATA%\\Dolphin Emulator'], linux: ['~/.local/share/dolphin-emu'] },
    sources: [
      // Official release builds live on dl.dolphin-emu.org as
      // releases/<YYMM>/dolphin-<YYMM>-x64.7z (the website blocks scripted
      // page loads, the file host doesn't) — newest month that exists wins.
      { type: 'probe', months: 36, url: { win32: (v) => `https://dl.dolphin-emu.org/releases/${v}/dolphin-${v}-x64.7z` } },
      { type: 'html', page: 'https://dolphin-emu.org/download/', link: { win32: /https:\/\/dl\.dolphin-emu\.org\/releases\/[\w.-]+\/dolphin-[\w.-]+-x64\.7z/i } },
    ],
    needs: [],
  },
};

// Platform → emulators, recommended first.
const PLATFORM_EMULATORS = {
  switch: ['eden', 'ryujinx'],
  wii: ['dolphin'],
  gamecube: ['dolphin'],
};

const expand = (p) => String(p)
  .replace(/^~(?=[\\/])/, os.homedir())
  .replace(/%([^%]+)%/g, (_, k) => process.env[k] || process.env[k.toUpperCase()] || `%${k}%`);

const nameMatches = (file, patterns) => patterns.some((pat) => {
  if (!pat.includes('*')) return path.basename(file).toLowerCase() === pat.toLowerCase();
  const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return re.test(path.basename(file));
});

/** First executable for emu under dir (depth-limited). */
function findExe(dir, emu, platformName = process.platform, maxDepth = 4) {
  const names = emu.exe[platformName] || [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.shift(); // breadth-first: the shallowest copy wins
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && nameMatches(p, names)) return p;
    }
    if (depth < maxDepth) for (const e of entries) if (e.isDirectory() && !/^(user|portable|cache|shaders?)$/i.test(e.name)) stack.push([path.join(d, e.name), depth + 1]);
  }
  return null;
}

/** Existing installs: common folders, Scoop, and our own emulators dir. */
function detectInstalled(emuId, { roots = [] } = {}) {
  const emu = EMULATORS[emuId];
  if (!emu) return null;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const names = [emu.name, emu.id, `${emu.name} Emulator`, `${emu.name}-emu`];
  const candidates = [
    ...roots.map((r) => path.join(r, emu.id)),
    ...(isWin ? pf.flatMap((p) => names.map((n) => path.join(p, n))) : []),
    ...(isWin ? [path.join(os.homedir(), 'scoop', 'apps', emu.id, 'current')] : []),
    ...(!isWin ? [path.join(os.homedir(), 'Applications'), '/usr/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')] : []),
  ];
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    const exe = findExe(dir, emu, process.platform, isWin ? 3 : 0);
    if (exe) return { id: emu.id, exe, dir: path.dirname(exe), managed: false };
  }
  return null;
}

/** Folder holding the emulator's keys/firmware/saves for THIS install. */
function dataDir(emuId, exe) {
  const emu = EMULATORS[emuId];
  if (!emu || !exe) return null;
  const here = path.dirname(exe);
  if (emu.portable?.dir && fs.existsSync(path.join(here, emu.portable.dir))) return path.join(here, emu.portable.dir);
  if (emu.portable?.file && fs.existsSync(path.join(here, emu.portable.file))) return path.join(here, 'User');
  const dirs = emu.userDirs[process.platform] || [];
  return dirs.map(expand).find((d) => fs.existsSync(d)) || (dirs[0] ? expand(dirs[0]) : null);
}

/** Make a downloaded copy portable so its data stays next to it. */
function makePortable(emuId, exe) {
  const emu = EMULATORS[emuId];
  const here = path.dirname(exe);
  if (emu.portable?.dir) fs.mkdirSync(path.join(here, emu.portable.dir), { recursive: true });
  if (emu.portable?.file) fs.writeFileSync(path.join(here, emu.portable.file), '');
}

/**
 * What still stands between this platform and Play: [] when ready.
 * Switch needs the user's own prod.keys (never downloaded) and firmware.
 */
function missingRequirements(emuId, exe) {
  const emu = EMULATORS[emuId];
  if (!emu || !exe || !fs.existsSync(exe)) return ['emulator'];
  const out = [];
  const data = dataDir(emuId, exe);
  if (emu.needs.includes('keys')) {
    const keys = data && path.join(data, emu.keysSub, 'prod.keys');
    if (!keys || !fs.existsSync(keys)) out.push('keys');
  }
  if (emu.needs.includes('firmware')) {
    const fw = data && path.join(data, emu.firmwareSub);
    let n = 0;
    try { n = fs.readdirSync(fw).length; } catch { /* none */ }
    if (n < 5) out.push('firmware');
  }
  return out;
}

/** Copy the user's prod.keys / title.keys into this emulator's keys folder. */
function importKeys(emuId, exe, files) {
  const emu = EMULATORS[emuId];
  const data = dataDir(emuId, exe);
  if (!emu?.keysSub || !data) throw new Error('This emulator has no keys folder.');
  const dest = path.join(data, emu.keysSub);
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of files) {
    const name = path.basename(f).toLowerCase();
    if (!/^(prod|title)\.keys$/.test(name)) continue;
    fs.copyFileSync(f, path.join(dest, name));
    copied.push(name);
  }
  if (!copied.length || (!copied.includes('prod.keys') && !fs.existsSync(path.join(dest, 'prod.keys')))) {
    throw new Error('Pick your prod.keys file (title.keys is optional).');
  }
  return { dest, copied };
}

/** How to start rom in this emulator. */
function launchCommand(emuId, exe, rom, opts = {}) {
  const emu = EMULATORS[emuId];
  if (!emu) throw new Error(`Unknown emulator "${emuId}".`);
  return { cmd: exe, args: emu.args(rom, opts), cwd: path.dirname(exe) };
}

// ---------- official build lookup + download ----------

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'Gamehub', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/**
 * Newest official build for this OS: { version, url, name, source } —
 * tries each source in order and reports why each failed.
 */
async function resolveLatest(emuId, { platformName = process.platform, fetchImpl = globalThis.fetch, _now = () => new Date() } = {}) {
  const emu = EMULATORS[emuId];
  if (!emu) throw new Error(`Unknown emulator "${emuId}".`);
  const errors = [];
  for (const src of emu.sources) {
    try {
      if (src.type === 'github' || src.type === 'forgejo') {
        const re = src.asset[platformName];
        if (!re) continue;
        const api = src.type === 'github'
          ? `https://api.github.com/repos/${src.repo}/releases/latest`
          : `${src.base}/api/v1/repos/${src.repo}/releases/latest`;
        const rel = await getJson(api, fetchImpl);
        const asset = (rel.assets || []).find((a) => re.test(a.name));
        if (!asset) throw new Error(`no ${platformName} asset in ${rel.tag_name || 'latest release'} (${(rel.assets || []).map((a) => a.name).join(', ')})`);
        return { version: String(rel.tag_name || rel.name || '').replace(/^v/i, ''), url: asset.browser_download_url, name: asset.name, source: api };
      }
      if (src.type === 'gitlab') {
        const re = src.asset[platformName];
        if (!re) continue;
        const api = `${src.base}/api/v4/projects/${encodeURIComponent(src.project)}/releases/permalink/latest`;
        const rel = await getJson(api, fetchImpl);
        const links = rel.assets?.links || [];
        const asset = links.find((a) => re.test(a.name || a.url || ''));
        if (!asset) throw new Error(`no ${platformName} asset in ${rel.tag_name || 'latest release'} (${links.map((a) => a.name).join(', ')})`);
        return { version: String(rel.tag_name || '').replace(/^v/i, ''), url: asset.direct_asset_url || asset.url, name: asset.name || asset.url.split('/').pop(), source: api };
      }
      if (src.type === 'probe') {
        const make = src.url[platformName];
        if (!make) continue;
        const now = _now();
        for (let i = 0; i < (src.months || 24); i++) {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
          const v = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
          const url = make(v);
          const r = await fetchImpl(url, { method: 'HEAD', headers: { 'User-Agent': 'Gamehub' } }).catch(() => null);
          if (r && r.ok) return { version: v, url, name: url.split('/').pop(), source: url };
        }
        throw new Error(`no release in the last ${src.months || 24} months`);
      }
      if (src.type === 'html') {
        const re = src.link[platformName];
        if (!re) continue;
        const r = await fetchImpl(src.page, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', Accept: 'text/html' } });
        if (!r.ok) throw new Error(`${src.page} → HTTP ${r.status}`);
        const m = (await r.text()).match(re);
        if (!m) throw new Error(`no ${platformName} download link on ${src.page}`);
        const name = m[0].split('/').pop();
        const ver = (name.match(/-(\d[\w.]*)-x64/) || [])[1] || '';
        return { version: ver, url: m[0], name, source: src.page };
      }
    } catch (err) {
      errors.push(`${src.type}: ${err.message}`);
    }
  }
  throw new Error(`Couldn’t find a ${emu.name} download for this PC — ${errors.join(' · ') || 'no source for this OS'}`);
}

/**
 * Download + unpack the official build into root/<id>, make it portable.
 * extract(archive, dest) is installer.extractArchive-compatible (7-Zip).
 * Returns { id, exe, dir, version, managed: true }.
 */
async function installEmulator(emuId, {
  root, extract, onProgress = () => {}, signal, fetchImpl = globalThis.fetch, platformName = process.platform,
} = {}) {
  const emu = EMULATORS[emuId];
  const rel = await resolveLatest(emuId, { platformName, fetchImpl });
  const dir = path.join(root, emu.id);
  const tmp = path.join(root, `.${emu.id}-download`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, rel.name);
  onProgress({ phase: 'downloading', pct: 0, message: `Downloading ${emu.name} ${rel.version}…` });
  const r = await fetchImpl(rel.url, { headers: { 'User-Agent': 'Gamehub' }, signal });
  if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of r.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : null;
    if (pct != null && pct !== lastPct) { lastPct = pct; onProgress({ phase: 'downloading', pct, message: `Downloading ${emu.name} ${rel.version}…` }); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));

  onProgress({ phase: 'extracting', message: `Unpacking ${emu.name}…` });
  const staging = path.join(tmp, 'x');
  if (/\.AppImage$/i.test(rel.name)) {
    fs.mkdirSync(staging, { recursive: true });
    fs.renameSync(file, path.join(staging, rel.name));
    fs.chmodSync(path.join(staging, rel.name), 0o755);
  } else {
    await extract(file, staging);
  }
  const found = findExe(staging, emu, platformName, 5);
  if (!found) throw new Error(`${emu.name} downloaded, but its program wasn’t found inside ${rel.name}.`);
  // keep the folder that holds the exe (archives often nest one level)
  const keepData = fs.existsSync(dir) ? findExe(dir, emu, platformName, 5) : null;
  const oldData = keepData && (emu.portable?.dir ? path.join(path.dirname(keepData), emu.portable.dir) : path.join(path.dirname(keepData), 'User'));
  const stash = oldData && fs.existsSync(oldData) ? path.join(tmp, 'keep-data') : null;
  if (stash) fs.renameSync(oldData, stash); // an update must not lose keys/saves
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(path.dirname(found), dir);
  const exe = path.join(dir, path.basename(found));
  if (stash) fs.renameSync(stash, emu.portable?.dir ? path.join(dir, emu.portable.dir) : path.join(dir, 'User'));
  makePortable(emuId, exe);
  fs.rmSync(tmp, { recursive: true, force: true });
  onProgress({ phase: 'done', message: `${emu.name} ${rel.version} ready` });
  return { id: emu.id, exe, dir, version: rel.version, managed: true };
}

module.exports = {
  EMULATORS,
  PLATFORM_EMULATORS,
  findExe,
  detectInstalled,
  dataDir,
  makePortable,
  missingRequirements,
  importKeys,
  launchCommand,
  resolveLatest,
  installEmulator,
};
