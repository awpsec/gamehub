// The launcher picker must never surface exes from OTHER games' folders. This
// recreates the exact reported scenario — a games dir holding Total War plus
// Age of Mythology / MW2CR / Skyve / Hollow Knight — and verifies Total War's
// candidate list contains only Total War's own exes.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const installer = require('../../client/lib/installer.js');

// Faithful replica of main.js `game:candidates` selection (the IPC handler
// itself can't be imported — it needs Electron — but this is its logic):
// folder evidence weights each folder's exes, a desolate own dir is never
// "confident", orphan folders must name-match the game, top + 2 alternates.
function selectCandidates(gamesDir, entry, allEntries, expectedBytes = 0) {
  const pool = [];
  const rankDir = (dir, relBase) => {
    const ev = installer.folderEvidence(dir, expectedBytes);
    for (const c of installer.rankGameExes(dir, entry.title)) {
      let { score } = c;
      const reasons = [...c.reasons];
      if (ev.desolate) { score -= 25; reasons.push('folder holds no game data'); }
      else if (ev.sizeMatches) { score += 12; reasons.push('folder size matches the download'); }
      else if (ev.substantial) { score += 8; reasons.push('folder holds the game data'); }
      pool.push({ ...c, score, reasons, rel: path.relative(relBase, c.path) });
    }
    return ev;
  };
  const ownEv = entry.dir && fs.existsSync(entry.dir) ? rankDir(entry.dir, entry.dir) : null;
  const ownConfident = !!ownEv && !ownEv.desolate && pool.some((c) => c.score >= 45);
  if (!ownConfident) {
    const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
    const owned = new Set(allEntries.map((en) => norm(en.dir)).filter(Boolean));
    owned.add(norm(entry.dir));
    for (const d of fs.readdirSync(gamesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(gamesDir, d.name);
      if (owned.has(norm(p))) continue;
      if (!installer.folderMatchesGame(path.basename(p), entry.title)) continue;
      rankDir(p, gamesDir);
    }
  }
  pool.sort((a, b) => b.score - a.score);
  return pool.filter((c, i) => i === 0 || c.score > 0).slice(0, 3);
}

test('launcher picker: never lists another game’s exe', () => {
  const { check, done } = checker();
  const games = tmp('games');
  const KB = 1024;
  const MB = 1024 * 1024;
  try {
    // the reported library
    writeFile(games, 'Total War SHOGUN 2/shogun2.exe', 305 * KB);
    writeFile(games, 'Total War SHOGUN 2/AwesomiumProcess.exe', 1.3 * MB);
    writeFile(games, 'Age of Mythology Retold Immortal Pillars.REPACK-KaOs/AoMRT_s.exe', 72 * MB);
    writeFile(games, 'Age of Mythology Retold Immortal Pillars.REPACK-KaOs/BattleServer.exe', 3.6 * MB);
    writeFile(games, 'Call of Duty - Modern Warfare 2 CR/MW2CR.exe', 14 * MB);
    writeFile(games, 'Call of Duty - Modern Warfare 2 CR/MW2CR_Old_Crack_Run_Once.exe', 14.8 * MB);
    writeFile(games, 'Skyve CS-II/Skyve.exe', 1.5 * MB);
    writeFile(games, 'Hollow Knight - Silksong/Hollow Knight Silksong.exe', 657 * KB);

    // --- folderMatchesGame: the core guard ---
    check('own folder matches', installer.folderMatchesGame('Total War SHOGUN 2', 'Total War: SHOGUN 2') === true);
    check('AoM folder does NOT match Total War', installer.folderMatchesGame('Age of Mythology Retold Immortal Pillars.REPACK-KaOs', 'Total War: SHOGUN 2') === false);
    check('MW2CR folder does NOT match', installer.folderMatchesGame('Call of Duty - Modern Warfare 2 CR', 'Total War: SHOGUN 2') === false);
    check('Skyve folder does NOT match', installer.folderMatchesGame('Skyve CS-II', 'Total War: SHOGUN 2') === false);
    check('Hollow Knight folder does NOT match', installer.folderMatchesGame('Hollow Knight - Silksong', 'Total War: SHOGUN 2') === false);
    // the FitGirl case still works: a wizard-installed folder that names the game
    check('wizard install folder still matches its game', installer.folderMatchesGame('Age of Mythology Retold', 'Age of Mythology: Retold - Immortal Pillars') === true);

    // --- the actual picker for Total War (mode installer = repack) ---
    const twDir = path.join(games, 'Total War SHOGUN 2');
    const allEntries = [{ dir: twDir }]; // only TW is a Gamehub install; the rest are loose folders
    const cands = selectCandidates(games, { dir: twDir, title: 'Total War: SHOGUN 2', mode: 'installer' }, allEntries);

    const names = cands.map((c) => c.rel);
    check('top candidate is Total War’s own exe', /shogun2\.exe$/i.test(cands[0]?.path || ''), cands[0]?.rel);
    check('every candidate lives in the Total War folder', cands.every((c) => path.normalize(c.path).startsWith(path.normalize(twDir) + path.sep)), JSON.stringify(names));
    check('NO Age of Mythology exe', !names.some((n) => /mythology|aomrt|battleserver/i.test(n)), JSON.stringify(names));
    check('NO MW2CR exe', !names.some((n) => /mw2cr|modern warfare/i.test(n)), JSON.stringify(names));
    check('NO Skyve / Hollow Knight exe', !names.some((n) => /skyve|silksong/i.test(n)), JSON.stringify(names));
    check('list stays tight — top pick + sensible alternates only', cands.length === 2, String(cands.length));

    // --- a genuinely orphaned wizard install IS found (fallback still works) ---
    // AoM entry.dir is the repack folder (only a BattleServer + a setup-less
    // helper), and the real game sits in a matching sibling folder.
    writeFile(games, 'AoM.Repack/setup.exe', 5 * MB); // blacklisted as an installer
    writeFile(games, 'Age of Mythology Retold/AoMRT_s.exe', 90 * MB); // the wizard's real install
    const aomRepack = path.join(games, 'AoM.Repack');
    const aomCands = selectCandidates(
      games,
      { dir: aomRepack, title: 'Age of Mythology: Retold', mode: 'installer' },
      [{ dir: aomRepack }, { dir: twDir }]
    );
    check('wizard install found via a name-matching orphan folder', aomCands.some((c) => /Age of Mythology Retold[\\/]AoMRT_s\.exe$/i.test(c.path)), JSON.stringify(aomCands.map((c) => c.rel)));
    check('…and STILL no unrelated game exe leaks in', !aomCands.some((c) => /shogun2|mw2cr|skyve|silksong/i.test(c.path)), JSON.stringify(aomCands.map((c) => c.rel)));
  } finally {
    rm(games);
  }
  done(assert);
});

test('launcher picker: desolate repack husk loses to the folder holding the game data', () => {
  const { check, done } = checker();
  const games = tmp('games-husk');
  const KB = 1024;
  const MB = 1024 * 1024;
  try {
    // The reported repack pattern: after the wizard runs, the ORIGINAL folder
    // (entry.dir) is a husk — checksums and a readme — while the real game
    // landed in a fresh sibling folder. Foreign games sit alongside.
    writeFile(games, 'Age of Mythology Retold/fg-checksums.md5', 2 * KB);
    writeFile(games, 'Age of Mythology Retold/readme.txt', 1 * KB);
    writeFile(games, 'Age of Mythology - Retold (2024)/AoMRT_s.exe', 60 * MB);
    writeFile(games, 'Age of Mythology - Retold (2024)/BattleServer.exe', 3 * MB);
    writeFile(games, 'Age of Mythology - Retold (2024)/data/textures.pak', 20 * MB);
    writeFile(games, 'Sekiro/sekiro.exe', 5 * MB);
    writeFile(games, 'Hollow Knight - Silksong/Hollow Knight Silksong.exe', 1 * MB);

    const husk = path.join(games, 'Age of Mythology Retold');
    const real = path.join(games, 'Age of Mythology - Retold (2024)');
    const EXPECTED = 60 * MB; // store package size from metadata

    // --- folderEvidence: the size-vs-metadata signals themselves ---
    const evHusk = installer.folderEvidence(husk, EXPECTED);
    const evReal = installer.folderEvidence(real, EXPECTED);
    check('husk is desolate', evHusk.desolate === true, JSON.stringify(evHusk));
    check('real folder holds the data', evReal.substantial === true, JSON.stringify(evReal));
    check('real folder size matches the download', evReal.sizeMatches === true, JSON.stringify(evReal));

    // --- the picker: entry.dir is the husk ---
    const cands = selectCandidates(
      games,
      { dir: husk, title: 'Age of Mythology: Retold', mode: 'installer' },
      [{ dir: husk }],
      EXPECTED
    );
    const rels = cands.map((c) => `${c.rel} (${Math.round(c.score)})`);
    check('top candidate is the real install’s launcher', /AoMRT_s\.exe$/i.test(cands[0]?.path || ''), JSON.stringify(rels));
    check('top candidate carries the size-match evidence', (cands[0]?.reasons || []).some((r) => /folder size matches/i.test(r)), JSON.stringify(cands[0]?.reasons));
    check('at most 3 candidates', cands.length <= 3, String(cands.length));
    check('every alternate still makes sense (score > 0)', cands.slice(1).every((c) => c.score > 0), JSON.stringify(rels));
    check('all candidates live in THIS game’s folders', cands.every((c) => c.path.startsWith(real + path.sep) || c.path.startsWith(husk + path.sep)), JSON.stringify(rels));
    check('NO Sekiro exe', !cands.some((c) => /sekiro/i.test(c.path)), JSON.stringify(rels));
    check('NO Silksong exe', !cands.some((c) => /silksong/i.test(c.path)), JSON.stringify(rels));
  } finally {
    rm(games);
  }
  done(assert);
});
