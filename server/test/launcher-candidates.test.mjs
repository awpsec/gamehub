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
// itself can't be imported — it needs Electron — but this is its logic).
function selectCandidates(gamesDir, entry, allEntries) {
  const pool = [];
  if (entry.dir && fs.existsSync(entry.dir)) {
    for (const c of installer.rankGameExes(entry.dir, entry.title)) {
      pool.push({ ...c, rel: path.relative(entry.dir, c.path) });
    }
  }
  const ownConfident = pool.some((c) => c.score >= 45);
  if (!ownConfident) {
    const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
    const owned = new Set(allEntries.map((en) => norm(en.dir)).filter(Boolean));
    owned.add(norm(entry.dir));
    for (const d of fs.readdirSync(gamesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(gamesDir, d.name);
      if (owned.has(norm(p))) continue;
      if (!installer.folderMatchesGame(path.basename(p), entry.title)) continue;
      for (const c of installer.rankGameExes(p, entry.title)) {
        pool.push({ ...c, rel: path.relative(gamesDir, c.path) });
      }
    }
  }
  pool.sort((a, b) => b.score - a.score);
  return pool;
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
    check('own confident match skips the orphan scan entirely', cands.length === 2, String(cands.length));

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
