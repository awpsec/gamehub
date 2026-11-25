// Scene releases (RUNE/CODEX/TENOKE…): multi-part RAR → ISO → setup.exe with
// the group's crack folder beside it. Volume naming, missing parts, crack
// detection/application and "is this still an installer?" decisions.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const installer = require('../../client/lib/installer.js');
const scene = require('../../client/lib/sceneRelease.js');

const touch = (base, rel, body = 'x') => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const oldStyleName = (i) => `rune-game.${String.fromCharCode(114 + Math.floor(i / 100))}${String(i % 100).padStart(2, '0')}`;

test('old-style RAR set past .r99 (.s00…) is complete, sized and removed as one set', () => {
  const d = tmp('rar-s00');
  try {
    touch(d, 'rune-game.rar', 'aaaa');
    for (let i = 0; i < 130; i++) touch(d, oldStyleName(i), 'bb'); // .r00–.r99, .s00–.s29
    touch(d, 'rune-game.nfo');
    const first = path.join(d, 'rune-game.rar');
    assert.deepStrictEqual(installer.missingVolumes(first), []);
    assert.strictEqual(installer.volumeSetSize(first), 4 + 130 * 2);
    assert.ok(!installer.isArchiveFirstVolume('rune-game.s05', d), '.s05 is not a first volume');
  } finally { rm(d); }
});

test('missing middle part of an old-style set is named', () => {
  const d = tmp('rar-gap');
  try {
    touch(d, 'rune-game.rar');
    for (let i = 0; i < 120; i++) if (i !== 57 && i !== 103) touch(d, oldStyleName(i));
    assert.deepStrictEqual(installer.missingVolumes(path.join(d, 'rune-game.rar')), ['rune-game.r57', 'rune-game.s03']);
  } finally { rm(d); }
});

test('.partNN.rar and .001 sets report gaps; the .sfv catches a missing LAST part', () => {
  const d = tmp('rar-parts');
  try {
    for (const n of [1, 2, 4]) touch(d, `game.part0${n}.rar`);
    assert.deepStrictEqual(installer.missingVolumes(path.join(d, 'game.part01.rar')), ['game.part03.rar']);

    for (const n of ['001', '002', '004']) touch(d, `big.7z.${n}`);
    assert.deepStrictEqual(installer.missingVolumes(path.join(d, 'big.7z.001')), ['big.7z.003']);

    const e = tmp('rar-sfv');
    touch(e, 'rune-x.rar');
    touch(e, 'rune-x.r00');
    touch(e, 'rune-x.sfv', '; generated\nrune-x.rar 0a1b2c3d\nrune-x.r00 11223344\nrune-x.r01 55667788\n');
    assert.deepStrictEqual(installer.missingVolumes(path.join(e, 'rune-x.rar')), ['rune-x.r01']);
    rm(e);
  } finally { rm(d); }
});

test('7-Zip errors become plain sentences', () => {
  const f = (m) => installer.friendly7zError(new Error(m), '/x/rune-game.rar');
  assert.match(f('7z exited 2: ERROR: Missing volume : rune-game.r12'), /part “rune-game\.r12” is missing/);
  assert.match(f('ERROR: CRC Failed : game.iso'), /damaged or incomplete/);
  assert.match(f('Wrong password'), /password-protected/);
  assert.match(f('There is not enough space on the disk'), /disk space/);
  assert.match(f('Can not open the file as archive'), /full 7-Zip/);
});

test('crack folder names: group/crack names match, game folders never do', () => {
  for (const n of ['RUNE', 'Crack', 'CODEX', 'TENOKE', 'SKIDROW', 'Steam Emu', 'crackfix', 'PLAZA']) assert.ok(scene.isCrackDirName(n), n);
  for (const n of ['Content', 'Engine', 'Binaries', 'Win64', 'Redist', 'Data', 'Runes', 'crackle']) assert.ok(!scene.isCrackDirName(n), n);
  assert.ok(scene.isInCrackDir(path.join('RUNE', 'Game-Win64-Shipping.exe')));
  assert.ok(scene.isInCrackDir(path.join('ISO', 'RUNE', 'x.exe')));
  assert.ok(!scene.isInCrackDir(path.join('Game', 'Content', 'Crack', 'tex.pak'))); // deep = game data
  assert.ok(!scene.isInCrackDir('RUNE')); // a FILE called RUNE is not "in" a folder
});

// The layout a RUNE ISO unpacks to.
function sceneIsoLayout(d, { leftoverVolumes = false } = {}) {
  writeFile(d, 'setup.exe', 3 * 1024 * 1024);
  writeFile(d, 'setup-1.bin', 80 * 1024 * 1024);
  touch(d, 'autorun.inf', '[autorun]\nopen=setup.exe\n');
  touch(d, 'rune.nfo');
  writeFile(d, path.join('RUNE', 'Mygame', 'Binaries', 'Win64', 'Mygame-Win64-Shipping.exe'), 90 * 1024 * 1024);
  touch(d, path.join('RUNE', 'Mygame', 'Binaries', 'Win64', 'steam_api64.dll'));
  touch(d, path.join('RUNE', 'Mygame', 'Binaries', 'Win64', 'steam_emu.ini'));
  if (leftoverVolumes) for (let i = 0; i < 6; i++) writeFile(d, oldStyleName(100 + i), 400 * 1024 * 1024);
}

test('scene ISO: setup is the next step — the crack exe is never “the game”', () => {
  const d = tmp('scene-iso');
  try {
    sceneIsoLayout(d, { leftoverVolumes: true }); // .s00+ parts moved over by older builds
    const ranked = installer.rankGameExes(d, 'Mygame');
    assert.ok(!ranked.some((r) => /RUNE/.test(r.path)), 'crack exe excluded from launcher candidates');
    assert.strictEqual(path.basename(installer.findInstaller(d)), 'setup.exe');
    assert.ok(installer.isInstallerPrimary(d, 'Mygame'), 'installer-primary');
  } finally { rm(d); }
});

test('applyCrack: exact path, same-name anywhere, new files beside them, backups + restore', () => {
  const rel = path.join('Mygame', 'Binaries', 'Win64');
  const release = tmp('crack-src');
  const game = tmp('crack-dst');
  try {
    touch(release, path.join('RUNE', rel, 'Mygame-Win64-Shipping.exe'), 'CRACKED');
    touch(release, path.join('RUNE', rel, 'steam_api64.dll'), 'EMU');
    touch(release, path.join('RUNE', rel, 'steam_settings', 'force_language.txt'), 'english');
    touch(release, path.join('RUNE', 'rune.nfo'), 'nfo');
    touch(release, path.join('RUNE', 'readme.txt'), 'crack readme');

    // installed game: same layout, plus the steam dll ALSO under Engine/ThirdParty
    touch(game, path.join(rel, 'Mygame-Win64-Shipping.exe'), 'ORIGINAL');
    touch(game, path.join(rel, 'steam_api64.dll'), 'STEAM');
    touch(game, 'readme.txt', 'game readme');

    const [crackDir] = scene.findCrackDirs(release);
    assert.strictEqual(path.basename(crackDir), 'RUNE');
    const r = scene.applyCrack(crackDir, game);
    const read = (p) => fs.readFileSync(path.join(game, p), 'utf8');
    assert.strictEqual(read(path.join(rel, 'Mygame-Win64-Shipping.exe')), 'CRACKED');
    assert.strictEqual(read(path.join(rel, 'Mygame-Win64-Shipping.exe') + scene.BACKUP_SUFFIX), 'ORIGINAL');
    assert.strictEqual(read(path.join(rel, 'steam_api64.dll')), 'EMU');
    assert.strictEqual(read(path.join(rel, 'steam_settings', 'force_language.txt')), 'english');
    assert.strictEqual(read('readme.txt'), 'game readme', 'crack readme must not clobber the game’s');
    assert.ok(!fs.existsSync(path.join(game, 'rune.nfo')), 'nfo skipped');
    assert.strictEqual(r.replaced.length, 2);

    // re-applying keeps the FIRST backup (the real original)
    scene.applyCrack(crackDir, game);
    assert.strictEqual(read(path.join(rel, 'Mygame-Win64-Shipping.exe') + scene.BACKUP_SUFFIX), 'ORIGINAL');

    assert.ok(scene.restoreOriginals(game) >= 2);
    assert.strictEqual(read(path.join(rel, 'Mygame-Win64-Shipping.exe')), 'ORIGINAL');
  } finally { rm(release, game); }
});

test('applyCrack: flattened install (no matching sub-path) still finds the dll by name', () => {
  const release = tmp('crack-flat-src');
  const game = tmp('crack-flat-dst');
  try {
    touch(release, path.join('CODEX', 'steam_api64.dll'), 'EMU');
    touch(release, path.join('CODEX', 'steam_emu.ini'), 'ini');
    touch(game, path.join('bin', 'game.exe'), 'G');
    touch(game, path.join('bin', 'steam_api64.dll'), 'STEAM');
    scene.applyCrack(path.join(release, 'CODEX'), game);
    assert.strictEqual(fs.readFileSync(path.join(game, 'bin', 'steam_api64.dll'), 'utf8'), 'EMU');
    assert.strictEqual(fs.readFileSync(path.join(game, 'bin', 'steam_emu.ini'), 'utf8'), 'ini', 'new file lands beside the replaced dll');
  } finally { rm(release, game); }
});

test('applyCrack: portable release with Crack/ inside the game folder', () => {
  const game = tmp('crack-portable');
  try {
    touch(game, 'Game.exe', 'ORIGINAL');
    touch(game, path.join('Crack', 'Game.exe'), 'CRACKED');
    const [c] = scene.findCrackDirs(game);
    const r = scene.applyCrack(c, game, { gameExe: path.join(game, 'Game.exe') });
    assert.strictEqual(fs.readFileSync(path.join(game, 'Game.exe'), 'utf8'), 'CRACKED');
    assert.strictEqual(fs.readFileSync(path.join(game, 'Crack', 'Game.exe'), 'utf8'), 'CRACKED', 'crack copy untouched');
    assert.deepStrictEqual(r.replaced, ['Game.exe']);
  } finally { rm(game); }
});

test('a crack-named folder holding a whole game is not a crack', () => {
  const d = tmp('crack-huge');
  try {
    for (let i = 0; i < 450; i++) touch(d, path.join('Fix', `f${i}.dat`));
    touch(d, path.join('Fix', 'x.dll'));
    assert.deepStrictEqual(scene.findCrackDirs(d), []);
  } finally { rm(d); }
});

test('crack kept with the game for repair; missing files (antivirus) detected and restorable', () => {
  const release = tmp('keep-src');
  const game = tmp('keep-dst');
  try {
    touch(release, path.join('RUNE', 'GTA5_Enhanced.exe'), 'CRACKED');
    touch(release, path.join('RUNE', 'rune64.dll'), 'LOADER');
    touch(game, 'GTA5_Enhanced.exe', 'ORIGINAL');
    const crackDir = path.join(release, 'RUNE');
    const r = scene.applyCrack(crackDir, game);
    const files = [...r.replaced, ...r.added];
    assert.deepStrictEqual(files.sort(), ['GTA5_Enhanced.exe', 'rune64.dll']);
    const kept = scene.keepCrack(crackDir, game);
    assert.ok(fs.existsSync(path.join(kept, 'rune64.dll')), 'copy kept under _gamehub/release-fix');
    assert.deepStrictEqual(scene.keptCrackDirs(game), [kept]);
    // the kept cracked exe is never a launcher candidate
    assert.ok(!installer.rankGameExes(game, 'GTA5 Enhanced').some((x) => x.path.includes('_gamehub')));
    // antivirus quarantines the loader …
    fs.rmSync(path.join(game, 'rune64.dll'));
    assert.deepStrictEqual(scene.missingCrackFiles(game, files), ['rune64.dll']);
    // … Verify / repair re-applies from the kept copy
    for (const k of scene.keptCrackDirs(game)) scene.applyCrack(k, game);
    assert.deepStrictEqual(scene.missingCrackFiles(game, files), []);
    assert.strictEqual(fs.readFileSync(path.join(game, 'GTA5_Enhanced.exe') + scene.BACKUP_SUFFIX, 'utf8'), 'ORIGINAL', 'original backup survives a repair');
  } finally { rm(release, game); }
});
