// Post-download processing: assemble/extract archives, handle ISOs,
// locate installers or game executables, create/remove shortcuts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const platform = require('./platform');

// ---------- 7-Zip resolution ----------
// A full 7-Zip install is preferred because 7za (the bundled reduced build)
// cannot extract RAR archives. ISO/zip/7z work with either.
function find7zip() {
  for (const c of platform.sevenZipCandidates()) {
    if (fs.existsSync(c)) return { path: c, supportsRar: true };
  }
  try {
    const { path7za } = require('7zip-bin');
    if (fs.existsSync(path7za)) return { path: path7za, supportsRar: false };
  } catch { /* not installed */ }
  return null;
}

function abortErr(signal) {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  err.reason = signal?.reason;
  return err;
}

function run(cmd, args, opts = {}) {
  const { signal, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr(signal));
    const child = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    let stderr = '';
    let settled = false;
    const onAbort = () => {
      try { child.kill(); } catch { /* */ }
      // On Windows kill may be async — also reject immediately so callers stop waiting.
      if (!settled) {
        settled = true;
        reject(abortErr(signal));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortErr(signal));
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// ---------- archive discovery ----------
// Given a set of files, return only the *first volumes* of archive sets so we
// extract each set exactly once. 7-Zip auto-loads subsequent volumes.
function isArchiveFirstVolume(fileName, dir = null) {
  const l = fileName.toLowerCase();
  if (/\.part(\d+)\.rar$/.test(l)) return /\.part0*1\.rar$/.test(l); // x.part01.rar
  if (/\.rar$/.test(l)) return true;                                 // x.rar (+ .r00 chain)
  if (/\.(7z|zip)\.0*1$/.test(l)) return true;                       // x.7z.001
  if (/\.(7z|zip)$/.test(l)) return true;
  // Bare *.001 — only treat as a split archive when a sibling .002 exists or
  // the file starts with a known archive magic (avoids game asset .001 files).
  if (/\.001$/.test(l)) {
    if (dir) {
      const stem = fileName.slice(0, -4);
      try {
        if (fs.existsSync(path.join(dir, `${stem}.002`))) return true;
      } catch { /* */ }
      try {
        const fd = fs.openSync(path.join(dir, fileName), 'r');
        const buf = Buffer.alloc(8);
        const n = fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        if (n >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return true; // 7z
        if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return true; // zip
        if (n >= 4 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return true; // rar
      } catch { /* */ }
      return false;
    }
    return true; // no dir context — keep prior permissive behavior
  }
  return false;
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function extractArchive(sevenZip, archivePath, destDir, onLine, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  onLine?.(`Extracting ${path.basename(archivePath)}…`);
  await run(sevenZip.path, ['x', archivePath, `-o${destDir}`, '-y', '-aoa'], { signal });
}

// remove every volume of an archive set (only ever called on OUR copies,
// never on library originals)
function removeVolumeSet(firstVolume) {
  const dir = path.dirname(firstVolume);
  const base = path.basename(firstVolume);
  const targets = [firstVolume];
  let m;
  if ((m = base.match(/^(.*)\.part\d+\.rar$/i))) {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().startsWith(m[1].toLowerCase() + '.part') && /\.rar$/i.test(f)) {
        targets.push(path.join(dir, f));
      }
    }
  } else if ((m = base.match(/^(.*)\.rar$/i))) {
    for (const f of fs.readdirSync(dir)) {
      if (new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.r\\d{2}$`, 'i').test(f)) {
        targets.push(path.join(dir, f));
      }
    }
  } else if ((m = base.match(/^(.*\.(7z|zip|rar))\.\d{2,3}$/i)) || (m = base.match(/^(.*)\.\d{3}$/i))) {
    const stem = m[1];
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().startsWith(stem.toLowerCase() + '.') && /\.\d{2,3}$/.test(f)) {
        targets.push(path.join(dir, f));
      }
    }
  }
  for (const t of new Set(targets)) fs.rmSync(t, { force: true });
}

function isMultiVolume(fileName, dir) {
  const l = fileName.toLowerCase();
  if (/\.part\d+\.rar$/.test(l)) return true;
  if (/\.(7z|zip|rar)\.\d{2,3}$/.test(l)) return true;
  if (/\.\d{3}$/.test(l)) return true;
  if (/\.rar$/.test(l) && dir) {
    try {
      return fs.readdirSync(dir).some((f) => /\.r00$/i.test(f));
    } catch {
      return false;
    }
  }
  return false;
}

function checkRarSupport(sevenZip, volumes) {
  const hasRar = volumes.some((f) => /\.(rar|r00)$/i.test(f));
  if (hasRar && !sevenZip.supportsRar) {
    throw new Error(
      'This game uses RAR archives, which the bundled 7za cannot extract. Install full 7-Zip from https://www.7-zip.org and retry.'
    );
  }
}

// Extract every archive set found under stagingDir into destDir, then keep
// unwrapping archives that came out NESTED inside the release (rar-in-a-folder
// -in-a-zip …). Guards against exploding game *asset* archives: nested
// single archives are only unpacked when they clearly ARE the payload.
// Returns the number of archive sets extracted.
// signal — AbortSignal; kills the running 7-Zip child on abort.
async function extractAll(stagingDir, destDir, onLine, signal) {
  const sevenZip = find7zip();
  if (!sevenZip) {
    throw new Error(
      '7-Zip not found. Install 7-Zip (https://www.7-zip.org) or run npm install in the client folder.'
    );
  }

  fs.mkdirSync(destDir, { recursive: true });
  const files = walkFiles(stagingDir);
  const firstVolumes = files.filter((f) => isArchiveFirstVolume(path.basename(f), path.dirname(f)));
  checkRarSupport(sevenZip, firstVolumes);

  let count = 0;
  for (const vol of firstVolumes) {
    if (signal?.aborted) throw abortErr(signal);
    try {
      await extractArchive(sevenZip, vol, destDir, onLine, signal);
      count++;
    } catch (err) {
      // Soft-fail a single volume so a stray non-archive *.001 can't abort the install.
      onLine?.(`Skipping ${path.basename(vol)} (${err.message || 'extract failed'})`);
    }
  }

  // nested passes: archives that appeared inside destDir (max depth 1 —
  // scene nesting is Folder/{parts}, while deep .zips are game assets)
  const processed = new Set();
  for (let pass = 0; pass < 4; pass++) {
    const totalSize = walkFiles(destDir).reduce((s, f) => s + safeSize(f), 0);
    const inner = [];
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      const level = [path.join(destDir, entry.name)];
      if (entry.isDirectory()) {
        try {
          level.length = 0;
          for (const f of fs.readdirSync(path.join(destDir, entry.name))) {
            level.push(path.join(destDir, entry.name, f));
          }
        } catch { /* skip */ }
      }
      for (const p of level) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        const name = path.basename(p);
        if (!isArchiveFirstVolume(name, path.dirname(p)) || processed.has(p)) continue;
        if (/\.(iso|bin|img)$/i.test(name)) continue; // handled by the disc pass
        const multi = isMultiVolume(name, path.dirname(p));
        // single nested archive: only unpack when it dominates the payload
        if (!multi && st.size < totalSize * 0.5) continue;
        inner.push(p);
      }
    }
    if (inner.length === 0) break;
    checkRarSupport(sevenZip, inner);
    for (const vol of inner) {
      if (signal?.aborted) throw abortErr(signal);
      processed.add(vol);
      onLine?.(`Unpacking nested ${path.basename(vol)}…`);
      try {
        await extractArchive(sevenZip, vol, path.dirname(vol), onLine, signal);
        removeVolumeSet(vol); // our copy — free the space
        count++;
      } catch (err) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
        onLine?.(`Could not unpack ${path.basename(vol)}: ${err.message}`);
      }
    }
  }

  // disc-image pass: .iso always; .bin/.img ONLY with a .cue/.ccd next to them
  // (bare .bin files are usually game data — v8_context_snapshot.bin etc.)
  const isDiscImage = (f) => {
    if (/\.iso$/i.test(f)) return true;
    if (/\.(bin|img)$/i.test(f)) {
      const stem = f.replace(/\.(bin|img)$/i, '');
      return fs.existsSync(`${stem}.cue`) || fs.existsSync(`${stem}.ccd`);
    }
    return false;
  };
  const isoSources = [...walkFiles(destDir), ...(firstVolumes.length === 0 ? files : [])];
  const discs = isoSources.filter(isDiscImage);
  for (const disc of discs) {
    if (signal?.aborted) throw abortErr(signal);
    onLine?.(`Extracting disc image ${path.basename(disc)}…`);
    try {
      await extractArchive(sevenZip, disc, destDir, onLine, signal);
      if (disc.startsWith(destDir)) fs.rmSync(disc, { force: true }); // our copy — free the space
      count++;
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
      // not actually extractable — leave it where it is, count nothing
      onLine?.(`Could not extract ${path.basename(disc)} (${err.message}) — leaving it in place.`);
    }
  }

  return count;
}

// while our copy contains exactly one folder and nothing else, hoist its
// contents up ("Zombiehood/Zombiehood/game.exe" -> "Zombiehood/game.exe")
function flattenSingleDir(dir) {
  for (let i = 0; i < 3; i++) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length !== 1 || !entries[0].isDirectory()) return;
    const inner = path.join(dir, entries[0].name);
    const tmp = path.join(path.dirname(dir), `.flatten-${Date.now()}`);
    try {
      fs.renameSync(inner, tmp);
      for (const e of fs.readdirSync(tmp)) {
        fs.renameSync(path.join(tmp, e), path.join(dir, e));
      }
      fs.rmdirSync(tmp);
    } catch {
      try { fs.renameSync(tmp, inner); } catch { /* leave as-is */ }
      return;
    }
  }
}

// ---------- executable discovery ----------
const INSTALLER_NAME = /(setup|install)/i;
const INSTALLER_EXCLUDE = /(unins|dxweb|dxsetup|directx|vcredist|dotnet|redist|oalinst|xnafx|launcher|kexsetup)/i;
const INSTALLER_BAT = /^(setup|install)\.bat$/i; // KaOs-style repack installers
// dirs whose "installers" are incidental: compat fixes, mod caches, patches —
// NOT the release's own installer
const INSTALLER_DIR_EXCLUDE = /([\\/])(\.[^\\/]+|[^\\/]*fix[^\\/]*|patch(es)?|updates?|mods?|tools?|extras?)([\\/]|$)/i;
const EXE_BLACKLIST =
  /(unins|setup|install|redist|vcredist|dxsetup|dxwebsetup|directx|dotnet|ue4prereq|ueprereq|crash|report|launcher_helper|unitycrashhandler|touchup|activation|register|benchmark|easyanticheat|eac_|battleye|be_?service|epiconlineservices|eossdk|notification_helper|unarc|decomp|7za|7zr|watchdog|cleanup|repair_|python|nodejs|updater|dotnetfx|quicksfv|language)/i;
const DIR_BLACKLIST =
  /([\\/])(redist|_redist|directx|dotnet|vcredist|commonredist|_commonredist|support|easyanticheat|battleye|crashpad|crashreportclient|engine[\\/]binaries[\\/]thirdparty|_installer|prerequisites)([\\/]|$)/i;

function findInstaller(dir) {
  const files = walkFiles(dir).filter(
    (f) => !DIR_BLACKLIST.test(f) && !INSTALLER_DIR_EXCLUDE.test(path.relative(dir, f))
  );
  const candidates = files.filter((f) => {
    // a release's own installer lives near the root, not buried in game data
    const depth = path.relative(dir, f).split(path.sep).length - 1;
    if (depth > 2) return false;
    const name = path.basename(f);
    if (INSTALLER_EXCLUDE.test(name)) return false;
    if (/\.msi$/i.test(name)) return true;
    if (INSTALLER_BAT.test(name)) return true;
    return /\.exe$/i.test(name) && INSTALLER_NAME.test(name);
  });
  if (candidates.length === 0) return null;
  // Prefer shallowest, then canonical setup.exe/bat, then largest.
  const isSetup = (f) => /^setup\.(exe|bat)$/i.test(path.basename(f));
  candidates.sort((a, b) => {
    const da = path.relative(dir, a).split(path.sep).length - 1;
    const db = path.relative(dir, b).split(path.sep).length - 1;
    if (da !== db) return da - db;
    const sa = isSetup(a) ? 0 : 1;
    const sb = isSetup(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return safeSize(b) - safeSize(a);
  });
  return candidates[0];
}

// ---------- game-exe scoring ----------
// Multiple signals instead of "largest exe wins": name similarity to the
// matched title, depth in the tree, size, and engine conventions.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Strip engine suffixes so MyGame-Win64-Shipping compares as MyGame. */
function titleCompareStem(rawName) {
  return String(rawName || '')
    .replace(/-(win64|win32)-shipping$/i, '')
    .replace(/-shipping$/i, '');
}

/** Tiny Unity/Godot/etc. launchers are real games — don't treat them as stubs. */
function hasCompanionGameData(exePath) {
  const dir = path.dirname(exePath);
  const base = path.basename(exePath, path.extname(exePath));
  try {
    if (fs.existsSync(path.join(dir, `${base}_Data`))) return true; // Unity
    if (fs.existsSync(path.join(dir, `${base}.pck`))) return true; // Godot
    if (fs.existsSync(path.join(dir, `${base}.exe.lnk`))) return false;
    // Strong engine markers only — bare Data/engine/mono are too common as false positives.
    for (const name of ['GameData', 'baselib.dll', 'UnityPlayer.dll', 'GameAssembly.dll']) {
      if (fs.existsSync(path.join(dir, name))) return true;
    }
  } catch { /* */ }
  return false;
}

const HELPER_EXE = /(^|[^a-z])(crack|awesomium|battleserver|unrealceditor|unrealeditor)([^a-z]|$)/i;

function rankGameExes(dir, title) {
  const nTitle = normName(title);
  const exes = walkFiles(dir).filter(
    (f) => /\.exe$/i.test(f) && !EXE_BLACKLIST.test(path.basename(f)) && !DIR_BLACKLIST.test(f)
  );
  const MIN_SIZE = 48 * 1024; // below this it's a stub/tool, not a game
  const ranked = exes
    .map((f) => {
      const name = path.basename(f, path.extname(f));
      // Title compare uses a shipping-stripped stem; other heuristics use the raw name.
      const nName = normName(titleCompareStem(name));
      const size = safeSize(f);
      const rel = path.relative(dir, f);
      const depth = rel.split(path.sep).length - 1;
      let score = 0;
      const reasons = [];
      // name similarity to the game title — the strongest signal
      if (nTitle && nName === nTitle) {
        score += 50; reasons.push('exact title match');
      } else if (nTitle && nName.length >= 3) {
        const shortEnough = nName.length >= 5 && nName.length >= Math.ceil(0.4 * nTitle.length);
        if (nTitle.includes(nName) && shortEnough) {
          // Exe is a shortened form of the title (e.g. shogun2 ⊂ Total War SHOGUN 2).
          // Require length ≥5 and ~40% of the title so war.exe / game.exe can't win.
          score += 30; reasons.push('title match');
        } else if (nName.includes(nTitle) && nName.length > nTitle.length) {
          // Exe name is LONGER than the title — usually a sequel/DLC
          // ("Hollow Knight Silksong" when looking for "Hollow Knight"). Do not reward.
          score -= 25; reasons.push('longer title (likely different game)');
        }
      }
      // location: root-level exes are canonical launch points
      if (depth === 0) { score += 25; reasons.push('at install root'); }
      else if (depth === 1) score += 8;
      else score -= 4 * depth;
      // Repack leftover: tiny title-exact stub at the install root often outranks
      // the real (generic-named) game binary buried in data/binaries. Cap that —
      // but not for real small launchers (Unity/Godot) that ship with companion data.
      const STUB_CEILING = 2 * 1024 * 1024;
      if (nTitle && nName === nTitle && depth === 0 && size > 0 && size < STUB_CEILING
          && !hasCompanionGameData(f)) {
        score -= 55;
        reasons.push('small root title stub');
      }
      // games often keep the real exe in a binaries/bin/Win64 folder (Paradox, UE, etc.)
      {
        const parent = path.basename(path.dirname(f));
        const grand = depth >= 2 ? path.basename(path.dirname(path.dirname(f))) : '';
        if (/^(binaries|bin|win64|win32)$/i.test(parent) || /^(binaries|bin)$/i.test(grand)) {
          score += 12;
          reasons.push('in binaries folder');
        }
      }
      // …and store-launcher bootstraps live in launcher/ folders
      if (/^launchers?$/i.test(path.basename(path.dirname(f)))) {
        score -= 6; reasons.push('in launcher folder');
      }
      // Unreal shipping binaries are real games even when buried deep
      if (/-(win64|win32)-shipping$/i.test(name)) { score += 22; reasons.push('UE shipping binary'); }
      // size still matters, but capped so decoys can't win on bulk alone
      score += Math.min(size / (50 * 1024 * 1024), 12);
      if (size < MIN_SIZE) score -= 40;
      // generic launchers only win if nothing else does
      if (/launcher/i.test(name) && !nName.includes(nTitle)) score -= 6;
      // Soft-penalize common helper/web-process binaries (keep them visible but not preferred).
      if (HELPER_EXE.test(name)) { score -= 20; reasons.push('helper binary'); }
      return { path: f, score, size, reasons };
    })
    .sort((a, b) => b.score - a.score);
  return ranked;
}

function findGameExe(dir, title = '') {
  const ranked = rankGameExes(dir, title);
  return ranked.length ? ranked[0].path : null;
}

// Folder-level evidence for the launcher picker: does this folder actually HOLD
// the game? Repack wizards often leave the original folder desolate (checksums,
// a readme, installer volumes) and unpack the real game into a sibling folder —
// the folder's bulk, compared to the store package's size, tells them apart.
// Bounded walk so a huge tree can't stall the picker.
function folderEvidence(dir, expectedBytes = 0) {
  let size = 0;
  let files = 0;
  let hasUnityMarker = false;
  const stack = [[dir, 0]];
  while (stack.length && files < 5000) {
    const [d, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/_Data$/i.test(e.name)) hasUnityMarker = true;
        if (depth < 5) stack.push([p, depth + 1]);
        continue;
      }
      files++;
      if (/^(GameAssembly|UnityPlayer)\.dll$/i.test(e.name)) hasUnityMarker = true;
      size += safeSize(p);
    }
  }
  const MB = 1024 * 1024;
  return {
    size,
    // a checksum/readme husk — a real game never fits in 10 MB (unless Unity
    // markers prove a tiny real install)
    desolate: size < 10 * MB && !hasUnityMarker,
    // holds enough data to plausibly BE the game (repacks unpack larger than
    // the download, so ≥half the package size is the coarse floor; with no
    // package size to compare, half a GB of data counts)
    substantial: expectedBytes > 0 ? size >= expectedBytes * 0.5 : size >= 500 * MB,
    // in the right ballpark of the store package (unpacked installs run up to
    // ~4× the compressed download)
    sizeMatches: expectedBytes > 0 && size >= expectedBytes * 0.5 && size <= expectedBytes * 4,
  };
}

// Does a folder plausibly belong to THIS game? Compares the folder name to the
// game title. Used to scope the "wizard installed the game into a new folder"
// launcher search to folders that match the game — so another game's folder
// never leaks into the picker.
//
// Important: a LONGER folder name that merely *contains* the title is often a
// different product ("Hollow Knight - Silksong" ≠ "Hollow Knight"). Extra
// tokens beyond noise/years mean "no". The inverse also matters: a shorter
// folder must not match a sequel title when discriminating tokens are missing
// ("Hollow Knight" ⊈ "Hollow Knight: Silksong").
const FOLDER_NAME_NOISE = new Set([
  'repack', 'fitgirl', 'dodi', 'kaos', 'gog', 'steam', 'setup', 'install', 'installer',
  'edition', 'remastered', 'definitive', 'complete', 'goty', 'deluxe', 'standard',
  'gold', 'premium', 'collection', 'bundle', 'dlc', 'update', 'patch', 'crack',
  'fix', 'proper', 'incl', 'hotfix', 'multi', 'offline',
]);
// Sequel / product-discriminating tokens: if the TITLE has these and the folder
// doesn't, it's a different game. Keep this narrow — "immortal"/"pillars" must
// NOT be here so Age of Mythology Retold still matches Immortal Pillars.
const TITLE_DISCRIMINATORS = new Set([
  'silksong', 'eternal', 'remake', 'reboot',
  '2', '3', '4', '5', '6', '7', '8', '9',
  'ii', 'iii', 'iv', 'v', 'vi',
]);

function folderMatchesGame(folderName, title) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nf = norm(folderName);
  const nt = norm(title);
  if (!nf || !nt) return false;
  const cf = nf.replace(/ /g, '');
  const ct = nt.replace(/ /g, '');
  if (cf === ct) return true;

  const folderWords = new Set(nf.split(' ').filter(Boolean));
  const titleWords = nt.split(' ').filter(Boolean);
  const titleWordSet = new Set(titleWords);

  // Years stay noise; short sequel digits / named sequels are discriminating.
  const significantExtra = (w) => {
    if (!w || titleWordSet.has(w)) return false;
    if (/^(19|20)\d{2}$/.test(w)) return false; // years only
    if (FOLDER_NAME_NOISE.has(w)) return false;
    if (w.length <= 1 && !/^\d$/.test(w)) return false;
    return true;
  };

  // Folder is a shortened form of the title (wizard folder without subtitle) —
  // only OK when the title's sequel discriminators aren't missing from the folder.
  if (ct.includes(cf) && cf.length >= 4) {
    const missing = titleWords.filter((w) => TITLE_DISCRIMINATORS.has(w) && !folderWords.has(w));
    return missing.length === 0;
  }

  // Folder contains the full title as a substring — only OK if leftover words
  // are noise (repack tags, years). "Hollow Knight - Silksong" keeps "silksong".
  if (cf.includes(ct)) {
    const extras = nf.split(' ').filter(significantExtra);
    return extras.length === 0;
  }

  const want = titleWords.filter((w) => w.length > 1 || /^\d$/.test(w));
  if (!want.length) return false;
  const hits = want.filter((w) => folderWords.has(w)).length;
  if (hits / want.length < 0.6) return false; // ≥60% of the title's words present
  // Reject when the folder has significant words the title doesn't (sequel/DLC).
  const extras = nf.split(' ').filter(significantExtra);
  return extras.length === 0;
}

// ---------- post-install audit ----------
// "did we ACTUALLY set this up right?" — checked after install/repair,
// so Play never points at nothing.
function auditInstall(entry) {
  const issues = [];
  if (!entry.dir || !fs.existsSync(entry.dir)) issues.push('install folder missing');
  if (entry.exe) {
    if (!fs.existsSync(entry.exe)) issues.push('game executable missing');
    else if (safeSize(entry.exe) < 16 * 1024) issues.push('game executable looks like a stub');
  } else if (entry.mode !== 'rom' && entry.status === 'installed') {
    issues.push('no game executable recorded');
  }
  const missingShortcuts = (entry.shortcuts || []).filter((s) => !fs.existsSync(s));
  if (missingShortcuts.length) issues.push(`${missingShortcuts.length} shortcut(s) missing`);
  return { ok: issues.length === 0, issues, missingShortcuts };
}

function safeSize(f) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

function findUninstaller(exePath) {
  const dir = path.dirname(exePath);
  try {
    const hit = fs.readdirSync(dir).find((n) => /^unins.*\.exe$/i.test(n));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

// ---------- shortcuts (Windows .lnk / Linux .desktop) ----------
function psEscape(s) {
  return s.replace(/'/g, "''");
}

async function createShortcut(lnkPath, targetPath) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
  const script =
    `$ws = New-Object -ComObject WScript.Shell; ` +
    `$s = $ws.CreateShortcut('${psEscape(lnkPath)}'); ` +
    `$s.TargetPath = '${psEscape(targetPath)}'; ` +
    `$s.WorkingDirectory = '${psEscape(path.dirname(targetPath))}'; ` +
    `$s.Save()`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function desktopEscape(s) {
  // Desktop Entry Exec= quoting: wrap in double quotes, escape \, ", and %
  // (literal % must be %% or the desktop parser treats %X as a field code).
  return `"${String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')}"`;
}

function buildDesktopExec(exePath, { winePrefix = null, linuxRunner = 'wine' } = {}) {
  try {
    const launch = platform.wineRunner.launchWindowsExe(exePath, {
      linuxRunner,
      winePrefix,
    }, { prefixDir: winePrefix || null });
    const envParts = [];
    if (launch.env?.WINEPREFIX) envParts.push(`WINEPREFIX=${desktopEscape(launch.env.WINEPREFIX)}`);
    if (launch.env?.STEAM_COMPAT_DATA_PATH) {
      envParts.push(`STEAM_COMPAT_DATA_PATH=${desktopEscape(launch.env.STEAM_COMPAT_DATA_PATH)}`);
    }
    if (launch.env?.STEAM_COMPAT_CLIENT_INSTALL_PATH) {
      envParts.push(`STEAM_COMPAT_CLIENT_INSTALL_PATH=${desktopEscape(launch.env.STEAM_COMPAT_CLIENT_INSTALL_PATH)}`);
    }
    envParts.push('WINEDEBUG=-all');
    const args = launch.args.map(desktopEscape).join(' ');
    const prefix = envParts.length ? `env ${envParts.join(' ')} ` : '';
    return `${prefix}${desktopEscape(launch.cmd)} ${args}`;
  } catch {
    // Fallback: bare wine + exe (still better than a dead .desktop)
    const wine = platform.wineRunner.findWineBinary() || 'wine';
    return `${desktopEscape(wine)} ${desktopEscape(path.resolve(exePath))}`;
  }
}

function writeDesktopShortcut(desktopPath, title, exePath, opts = {}) {
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  const name = String(title || 'Game').replace(/[\r\n]/g, ' ').trim() || 'Game';
  const body = [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    `Name=${name}`,
    `Comment=Play ${name} with Gamehub (Wine/Proton)`,
    `Exec=${buildDesktopExec(exePath, opts)}`,
    `Path=${path.dirname(path.resolve(exePath))}`,
    'Terminal=false',
    'Categories=Game;',
    'StartupNotify=true',
    '',
  ].join('\n');
  fs.writeFileSync(desktopPath, body, 'utf8');
  try { fs.chmodSync(desktopPath, 0o755); } catch { /* */ }
  return desktopPath;
}

function shortcutLocations(title) {
  const safe = title.replace(/[<>:"/\\|?*]/g, '').trim() || 'Game';
  if (platform.isLinux) {
    const desktopDir = process.env.XDG_DESKTOP_DIR
      || path.join(os.homedir(), 'Desktop');
    return {
      desktop: path.join(desktopDir, `${safe}.desktop`),
      startMenu: path.join(
        os.homedir(),
        '.local',
        'share',
        'applications',
        `gamehub-${safe.toLowerCase().replace(/\s+/g, '-')}.desktop`
      ),
    };
  }
  return {
    desktop: path.join(os.homedir(), 'Desktop', `${safe}.lnk`),
    startMenu: path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Gamehub',
      `${safe}.lnk`
    ),
  };
}

async function createShortcuts(title, exePath, {
  desktop = true,
  startMenu = true,
  winePrefix = null,
  linuxRunner = 'wine',
} = {}) {
  if (!platform.supportsShortcuts()) return [];
  const locs = shortcutLocations(title);
  const created = [];
  if (platform.isLinux) {
    const opts = { winePrefix, linuxRunner };
    const make = (p) => {
      writeDesktopShortcut(p, title, exePath, opts);
      if (fs.existsSync(p)) created.push(p);
    };
    if (desktop) make(locs.desktop);
    if (startMenu) make(locs.startMenu);
    return created;
  }
  const make = async (lnk) => {
    await createShortcut(lnk, exePath);
    if (!fs.existsSync(lnk)) await createShortcut(lnk, exePath); // one retry
    if (fs.existsSync(lnk)) created.push(lnk);
  };
  if (desktop) await make(locs.desktop);
  if (startMenu) await make(locs.startMenu);
  return created;
}

function removeShortcuts(paths = []) {
  for (const p of paths) fs.rmSync(p, { force: true });
}

module.exports = {
  find7zip,
  extractAll,
  flattenSingleDir,
  findInstaller,
  findGameExe,
  rankGameExes,
  folderMatchesGame,
  folderEvidence,
  isArchiveFirstVolume,
  auditInstall,
  findUninstaller,
  createShortcuts,
  removeShortcuts,
  writeDesktopShortcut,
  buildDesktopExec,
  shortcutLocations,
  walkFiles,
};
