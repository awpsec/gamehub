// Emulation: console platform detection (file headers, never just the
// extension), launch-file choice, the emulator registry (launch commands,
// keys/firmware readiness, official-build lookup), and scanner tagging.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const platforms = require('../src/platforms.cjs');
const emulators = require('../../client/lib/emulators.js');

// ---- synthetic images with the real header bytes ----
function nsp(dir, name) { const b = Buffer.alloc(0x400); b.write('PFS0', 0, 'latin1'); return put(dir, name, b); }
function xci(dir, name) { const b = Buffer.alloc(0x400); b.write('HEAD', 0x100, 'latin1'); return put(dir, name, b); }
function wiiIso(dir, name, id = 'RMGE01', title = 'Super Test Galaxy') {
  const b = Buffer.alloc(0x800); b.write(id, 0, 'latin1'); b.writeUInt32BE(0x5D1C9EA3, 0x18); b.write(title, 0x20, 'latin1'); return put(dir, name, b);
}
function gcIso(dir, name, id = 'GALE01') { const b = Buffer.alloc(0x800); b.write(id, 0, 'latin1'); b.writeUInt32BE(0xC2339F3D, 0x1C); return put(dir, name, b); }
function rvz(dir, name, discType, id = 'RSBE01') {
  const b = Buffer.alloc(0x200); b.write('RVZ\x01', 0, 'latin1'); b.writeUInt32BE(discType, 0x48); b.write(id, 0x58, 'latin1'); return put(dir, name, b);
}
function put(dir, name, buf) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; }

test('headers decide the platform — a PC ISO stays PC', () => {
  const d = tmp('plat-headers');
  try {
    assert.strictEqual(platforms.detectFile(nsp(d, 'Game [0100ABCD12340000][v0].nsp')).platform, 'switch');
    assert.strictEqual(platforms.detectFile(xci(d, 'Game.xci')).platform, 'switch');
    const w = platforms.detectFile(wiiIso(d, 'wii.iso'));
    assert.deepStrictEqual([w.platform, w.ids.gameId, w.ids.title], ['wii', 'RMGE01', 'Super Test Galaxy']);
    assert.strictEqual(platforms.detectFile(gcIso(d, 'gc.iso')).platform, 'gamecube');
    assert.strictEqual(platforms.detectFile(rvz(d, 'a.rvz', 2)).platform, 'wii');
    assert.strictEqual(platforms.detectFile(rvz(d, 'b.rvz', 1)).platform, 'gamecube');
    assert.strictEqual(platforms.detectFile(rvz(d, 'b.rvz', 1)).ids.gameId, 'RSBE01');
    // a PC scene ISO (ISO9660, no console magic) and a fake .nsp are not console games
    const pc = Buffer.alloc(0x9000); pc.write('CD001', 0x8001, 'latin1');
    assert.strictEqual(platforms.detectFile(put(d, 'rune-game.iso', pc)), null);
    assert.strictEqual(platforms.detectFile(put(d, 'notreally.nsp', Buffer.from('hello world'))), null);
  } finally { rm(d); }
});

test('Switch base / update / DLC from the usual naming; base is what launches', () => {
  assert.strictEqual(platforms.switchIds('Game [0100ABCD12340000][v0].nsp').role, 'base');
  assert.strictEqual(platforms.switchIds('Game [0100ABCD12340800][v196608].nsp').role, 'update');
  assert.strictEqual(platforms.switchIds('Game [0100ABCD12341001][v0].nsp').role, 'dlc');
  assert.strictEqual(platforms.switchIds('Game [UPD].nsp').role, 'update');
  const d = tmp('plat-switch-set');
  try {
    nsp(d, 'Game [0100ABCD12340000][v0].nsp');
    nsp(d, 'Game [0100ABCD12340800][v196608].nsp');
    writeFile(d, 'Game [0100ABCD12341001][v0].nsp', 0);
    fs.writeFileSync(path.join(d, 'Game [0100ABCD12341001][v0].nsp'), Buffer.concat([Buffer.from('PFS0'), Buffer.alloc(5000)])); // DLC bigger than base
    const r = platforms.detectPath(d);
    assert.strictEqual(r.platform, 'switch');
    assert.strictEqual(path.basename(r.launch), 'Game [0100ABCD12340000][v0].nsp', 'launch the base game, not the bigger DLC');
  } finally { rm(d); }
});

test('multi-disc: disc 1 launches; release tags hint while still archived', () => {
  const d = tmp('plat-discs');
  try {
    gcIso(d, 'Tales (Disc 2).iso');
    gcIso(d, 'Tales (Disc 1).iso');
    assert.match(platforms.detectPath(d).launch, /Disc 1/);
  } finally { rm(d); }
  assert.strictEqual(platforms.hintFromName('Super.Mario.Odyssey.NSW-VENOM'), 'switch');
  assert.strictEqual(platforms.hintFromName('Zelda Skyward Sword [Wii]'), 'wii');
  assert.strictEqual(platforms.hintFromName('Mario Kart 8 [Wii U]'), null, 'Wii U is not Wii');
  assert.strictEqual(platforms.hintFromName('Metroid Prime NGC'), 'gamecube');
  assert.strictEqual(platforms.hintFromName('Elden Ring-RUNE'), null);
});

test('launch commands: Eden, Ryujinx, Dolphin (spaced paths stay one argument)', () => {
  const rom = 'C:\\Program Files (x86)\\Gamehub\\games\\Switch\\My Game\\game.nsp';
  assert.deepStrictEqual(emulators.launchCommand('eden', 'C:\\E\\eden.exe', rom).args, ['-f', '-g', rom]);
  assert.deepStrictEqual(emulators.launchCommand('ryujinx', 'C:\\R\\Ryujinx.exe', rom, { fullscreen: false }).args, [rom]);
  const dol = emulators.launchCommand('dolphin', 'C:\\D\\Dolphin.exe', 'C:\\g\\w.rvz');
  assert.deepStrictEqual(dol.args, ['-b', '-C', 'Dolphin.Display.Fullscreen=True', '-e', 'C:\\g\\w.rvz']);
  assert.deepStrictEqual(emulators.PLATFORM_EMULATORS.switch, ['eden', 'ryujinx'], 'Eden is the Switch default');
  assert.deepStrictEqual(emulators.PLATFORM_EMULATORS.wii, ['dolphin']);
});

test('readiness: portable Eden needs keys + firmware; importKeys puts them in place', () => {
  const d = tmp('emu-ready');
  try {
    const exe = path.join(d, 'eden', 'eden.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    emulators.makePortable('eden', exe);
    assert.ok(fs.existsSync(path.join(d, 'eden', 'user')), 'portable user folder');
    assert.deepStrictEqual(emulators.missingRequirements('eden', exe), ['keys', 'firmware']);
    const keysSrc = path.join(d, 'dump', 'prod.keys');
    fs.mkdirSync(path.dirname(keysSrc), { recursive: true });
    fs.writeFileSync(keysSrc, 'header_key = 00');
    emulators.importKeys('eden', exe, [keysSrc]);
    assert.ok(fs.existsSync(path.join(d, 'eden', 'user', 'keys', 'prod.keys')));
    assert.deepStrictEqual(emulators.missingRequirements('eden', exe), ['firmware']);
    const fw = path.join(d, 'eden', 'user', 'nand', 'system', 'Contents', 'registered');
    fs.mkdirSync(fw, { recursive: true });
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(fw, `${i}.nca`), '');
    assert.deepStrictEqual(emulators.missingRequirements('eden', exe), []);
    assert.throws(() => emulators.importKeys('eden', exe, [path.join(d, 'dump', 'other.txt')]), /prod\.keys/);
    // Dolphin needs nothing but itself
    const dol = path.join(d, 'dolphin', 'Dolphin.exe');
    fs.mkdirSync(path.dirname(dol), { recursive: true });
    fs.writeFileSync(dol, 'x');
    assert.deepStrictEqual(emulators.missingRequirements('dolphin', dol), []);
    assert.deepStrictEqual(emulators.missingRequirements('dolphin', path.join(d, 'nope.exe')), ['emulator']);
  } finally { rm(d); }
});

test('official build lookup: GitHub / Forgejo releases and the Dolphin download page', async () => {
  const fake = (routes) => async (url) => {
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, json: async () => hit, text: async () => hit };
  };
  const eden = await emulators.resolveLatest('eden', {
    platformName: 'win32',
    fetchImpl: fake({ 'https://api.github.com/repos/eden-emulator/Releases/releases/latest': {
      tag_name: 'v0.0.3', assets: [{ name: 'Eden-Linux-v0.0.3-amd64.AppImage', browser_download_url: 'L' }, { name: 'Eden-Windows-v0.0.3-amd64-msvc.zip', browser_download_url: 'W' }],
    } }),
  });
  assert.deepStrictEqual([eden.version, eden.url], ['0.0.3', 'W']);
  // first source down → falls through to the next one
  const eden2 = await emulators.resolveLatest('eden', {
    platformName: 'linux',
    fetchImpl: fake({ 'https://git.eden-emu.dev/api/v1/repos/eden-emu/eden/releases/latest': {
      tag_name: 'v0.0.4', assets: [{ name: 'Eden-Linux-v0.0.4-amd64.AppImage', browser_download_url: 'L4' }],
    } }),
  });
  assert.strictEqual(eden2.url, 'L4');
  const dol = await emulators.resolveLatest('dolphin', {
    platformName: 'win32',
    fetchImpl: fake({ 'https://dolphin-emu.org/download/': '<a href="https://dl.dolphin-emu.org/releases/2509/dolphin-2509-x64.7z">Windows x64</a>' }),
  });
  assert.deepStrictEqual([dol.version, dol.name], ['2509', 'dolphin-2509-x64.7z']);
  // Dolphin's file host: newest YYMM release that exists (website may 403 scripts)
  const probe = await emulators.resolveLatest('dolphin', {
    platformName: 'win32',
    _now: () => new Date(Date.UTC(2026, 10, 15)), // Nov 2026
    fetchImpl: async (url, o) => ({ ok: o?.method === 'HEAD' && url === 'https://dl.dolphin-emu.org/releases/2609/dolphin-2609-x64.7z', status: 404 }),
  });
  assert.deepStrictEqual([probe.version, probe.url], ['2609', 'https://dl.dolphin-emu.org/releases/2609/dolphin-2609-x64.7z']);
  const ryu = await emulators.resolveLatest('ryujinx', {
    platformName: 'win32',
    fetchImpl: fake({ 'https://git.ryujinx.app/api/v1/repos/ryubing/ryujinx/releases/latest': {
      tag_name: '1.3.3', assets: [{ name: 'ryujinx-1.3.3-win_x64.zip', browser_download_url: 'RW' }, { name: 'ryujinx-1.3.3-linux_x64.AppImage', browser_download_url: 'RL' }],
    } }),
  });
  assert.deepStrictEqual([ryu.version, ryu.url], ['1.3.3', 'RW']);
  await assert.rejects(emulators.resolveLatest('ryujinx', { platformName: 'win32', fetchImpl: fake({}) }), /Couldn’t find a Ryujinx download/);
});

test('scanner tags console games; PC releases untouched', async () => {
  const { scanLibrary } = await import('../src/scanner.js');
  const { initDb } = await import('../src/db.js');
  const lib = tmp('scan-plat');
  const dataDir = tmp('scan-plat-db');
  try {
    nsp(path.join(lib, 'Pocket Tides [NSP]'), 'Pocket Tides [0100ABCD12340000][v0].nsp');
    wiiIso(lib, 'Lantern Bay.iso');
    rvz(path.join(lib, 'Cube Rally'), 'Cube Rally.rvz', 1);
    writeFile(lib, 'Some.PC.Game-RUNE/rune-game.rar', 1000);
    writeFile(lib, 'Zelda.Archived.NSW-VENOM/venom.rar', 1000);
    const db = initDb({ dataDir });
    scanLibrary(db, { libraryDir: lib });
    const rows = Object.fromEntries(db.prepare('SELECT rel_path, payload_type, platform FROM games').all().map((r) => [r.rel_path, [r.payload_type, r.platform]]));
    assert.deepStrictEqual(rows['Pocket Tides [NSP]'], ['switch-rom', 'switch']);
    assert.deepStrictEqual(rows['Lantern Bay.iso'], ['rom', 'wii']);
    assert.deepStrictEqual(rows['Cube Rally'], ['rom', 'gamecube']);
    assert.deepStrictEqual(rows['Some.PC.Game-RUNE'], ['multipart-archive', null]);
    assert.deepStrictEqual(rows['Zelda.Archived.NSW-VENOM'], ['multipart-archive', 'switch'], 'archived: name hint');
    db.close();
  } finally { rm(lib, dataDir); }
});
