// Update packages through the REAL pipeline: they classify as updates, match
// their BASE game (peeling the update's own name, and re-pointing off a DLC the
// name collides with), never split, share the base's provider_id, heal on boot,
// and never source the DLC catalog.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { scanLibrary } from '../src/scanner.js';
import { matchPendingGames, backfillMedia, adoptDlcIdentities, resolveBundles, reclassifyUpdates } from '../src/matcher.js';
import { createApi } from '../src/api.js';

test('updates: classify, resolve-to-base, heal, catalog-source', async () => {
  const { check, done } = checker();
  const dataDir = tmp('upd-db');
  const libDir = tmp('upd-lib');
  const MB = 1024 * 1024;
  const write = (rel, bytes) => {
    const p = path.join(libDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
  };
  write('Age.of.Mythology.Retold-RUNE/aomrt.exe', 48 * MB);
  write('Age.of.Mythology.Retold.Update.v17.22308-TENOKE/patch/aomrt.exe', 40 * MB);
  write('Age.of.Mythology.Retold.Obsidian.Mirror.Update.v100.19.15437-RUNE/data/game.dat', 300 * MB);

  const BASE = { provider: 'steam', providerId: '1934680', title: 'Age of Mythology: Retold' };
  // "Obsidian Mirror" is a REAL DLC — the update's name matches it (the trap).
  const DLC_OM = { provider: 'steam', providerId: '2777780', title: 'Age of Mythology: Retold - Obsidian Mirror' };
  const steam = {
    name: 'steam',
    async search(q) {
      const s = q.toLowerCase();
      const out = [];
      if (s.includes('obsidian mirror')) out.push({ ...DLC_OM });
      if (s.includes('age of mythology')) out.push({ ...BASE });
      return out.map((c) => ({ ...c, year: 2024, cover: 'c', summary: null, genres: null }));
    },
    async enrich(appid) {
      if (String(appid) === BASE.providerId) {
        return {
          year: 2024, released: 'Sep 4, 2024', summary: 's', about: 'AOM ABOUT', genres: 'Strategy',
          cover: 'c', hero: 'h', ratings: {}, media: { screenshots: ['x'], trailer: 't', trailerThumb: 'tt' },
          compat: {}, price: null, tags: [], kind: 'game', parent: null, dlc: [DLC_OM.providerId],
        };
      }
      if (String(appid) === DLC_OM.providerId) {
        return {
          year: 2025, released: 'Mar 4, 2025', summary: 'om', about: 'OM ABOUT', genres: 'Strategy',
          cover: 'omc', hero: 'omh', ratings: {}, media: { screenshots: ['y'], trailer: null },
          compat: {}, price: null, tags: [], kind: 'dlc', parent: { id: BASE.providerId, title: BASE.title },
        };
      }
      return {};
    },
    async appName(id) { return String(id) === DLC_OM.providerId ? DLC_OM.title : null; },
  };

  const db = initDb({ dataDir });
  let server = null;
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('libraryDir', ?)").run(libDir);
    const settings = { autoMatchThreshold: 0.85, minCandidateScore: 0.4, libraryDir: libDir };
    const fullScan = async () => {
      scanLibrary(db, { libraryDir: libDir });
      await matchPendingGames(db, settings, [steam]);
      await backfillMedia(db, [steam]);
      await adoptDlcIdentities(db, [steam]);
      await resolveBundles(db, [steam], libDir);
    };
    await fullScan();
    await fullScan(); // idempotency

    const rows = db.prepare('SELECT * FROM games ORDER BY id').all();
    const dump = () => rows.map((r) => `${r.rel_path} → ${r.provider_id} ${r.meta_kind} upd=${r.is_update}`).join(' | ');
    check('3 rows, no synthetic children (updates never split)', rows.length === 3, dump());
    const base = rows.find((r) => r.rel_path === 'Age.of.Mythology.Retold-RUNE');
    check('base game matched normally, not an update', base?.is_update === 0 && base?.provider_id === BASE.providerId, dump());
    const upd1 = rows.find((r) => r.rel_path.includes('Update.v17'));
    check('simple update matched to the base game', upd1?.status === 'matched' && upd1?.provider_id === BASE.providerId, upd1 && `${upd1.status}/${upd1.provider_id}`);
    check('simple update flagged is_update', upd1?.is_update === 1, String(upd1?.is_update));
    const upd2 = rows.find((r) => r.rel_path.includes('Obsidian.Mirror'));
    check('DLC-codename update resolved to the BASE game, not the DLC', upd2?.provider_id === BASE.providerId, upd2 && `${upd2.provider_id} (DLC would be ${DLC_OM.providerId})`);
    check('…kind=game, not dlc', upd2?.meta_kind === 'game', upd2?.meta_kind);
    check('…flagged is_update + matched', upd2?.is_update === 1 && upd2?.status === 'matched', `${upd2?.is_update}/${upd2?.status}`);
    check('updates share the base provider_id', rows.every((r) => r.provider_id === BASE.providerId), dump());
    check('updates kept kind=game', rows.every((r) => r.meta_kind === 'game'), dump());

    // reclassifyUpdates heals rows matched BEFORE update classification existed
    db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_kind, is_update)
       VALUES ('Legacy.Update.Row', 'Some.Game.Update.v2.1-RUNE', 'some game', 'folder', 100, 'matched', 'steam', '999', 'Some Game', 'game', 0)`
    ).run();
    let changed = reclassifyUpdates(db);
    const legacy = db.prepare("SELECT is_update FROM games WHERE rel_path = 'Legacy.Update.Row'").get();
    check('boot reclassify flags a legacy matched update row', changed >= 1 && legacy.is_update === 1, `${changed}/${legacy.is_update}`);
    check('…without touching real games', db.prepare("SELECT is_update FROM games WHERE rel_path = 'Age.of.Mythology.Retold-RUNE'").get().is_update === 0);
    changed = reclassifyUpdates(db);
    check('boot reclassify is idempotent', changed === 0, String(changed));

    // an update that already SETTLED as a DLC must be re-queued and re-resolved
    db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_kind, meta_parent_id, meta_parent_title, is_update)
       VALUES ('AoM.OM.Update.settled', 'Age.of.Mythology.Retold.Obsidian.Mirror.Update.v100.19.15437-RUNE', 'age of mythology retold obsidian mirror', 'folder', 300000000, 'matched', 'steam', @pid, 'Age of Mythology: Retold - Obsidian Mirror', 'dlc', @base, 'Age of Mythology: Retold', 0)`
    ).run({ pid: DLC_OM.providerId, base: BASE.providerId });
    const req = reclassifyUpdates(db);
    const settled = db.prepare("SELECT * FROM games WHERE rel_path = 'AoM.OM.Update.settled'").get();
    check('misfiled-as-DLC update re-queued for re-resolution', req >= 1 && settled.status === 'new' && settled.is_update === 1 && settled.meta_kind === null, `${settled.status}/${settled.is_update}/${settled.meta_kind}`);
    await matchPendingGames(db, settings, [steam]);
    const healed = db.prepare("SELECT * FROM games WHERE rel_path = 'AoM.OM.Update.settled'").get();
    check('re-resolved update now a base-game update', healed.provider_id === BASE.providerId && healed.meta_kind === 'game' && healed.is_update === 1 && healed.status === 'matched', `${healed.provider_id}/${healed.meta_kind}/${healed.is_update}`);
    db.prepare("DELETE FROM games WHERE rel_path = 'AoM.OM.Update.settled'").run();

    // /dlc must source the official list from the FULL base row, never an update row
    db.prepare("UPDATE games SET meta_dlc = ? WHERE rel_path = 'Age.of.Mythology.Retold-RUNE'").run(JSON.stringify([{ id: 'ip1', name: 'AoM DLC One' }]));
    db.prepare("UPDATE games SET meta_dlc = '[]' WHERE is_update = 1").run();
    const app = createApi({
      config: { dataDir, port: 0 }, db,
      getSettings: () => settings, getProviders: () => [steam],
      triggerScan: () => {}, localUser: { id: 1, username: 'test', role: 'admin' },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const updRowId = db.prepare("SELECT id FROM games WHERE rel_path LIKE '%Update.v17%'").get().id;
    const viaUpdate = await (await fetch(`http://127.0.0.1:${port}/api/games/${updRowId}/dlc`)).json();
    check('catalog served from the FULL base row even when queried via an update row', viaUpdate.dlc.length === 1 && viaUpdate.dlc[0].name === 'AoM DLC One', JSON.stringify(viaUpdate));

    // client-logic replicas
    const verNewer = (uvNum, ivNum) => {
      for (let i = 0; i < Math.max(uvNum.length, ivNum.length); i++) {
        const d = (uvNum[i] || 0) - (ivNum[i] || 0);
        if (d > 0) return true;
        if (d < 0) return false;
      }
      return false;
    };
    check('verCmp: newer update flags', verNewer([1, 6], [1, 5, 9]) === true);
    check('verCmp: older update suppressed', verNewer([1, 4, 9], [1, 5]) === false);
    check('verCmp: equal suppressed', verNewer([1, 5], [1, 5]) === false);
    const nk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wraps = (dirName, gameTitle, installBase) => {
      const dn = nk(dirName), gn = nk(gameTitle), bn = nk(installBase);
      return !!(dn && ((gn && (dn.includes(gn) || gn.includes(dn))) || (bn && (dn.includes(bn) || bn.includes(dn)))));
    };
    check('wrapper: game-named folder descends', wraps('Age of Mythology Retold', 'Age of Mythology: Retold', 'Age of Mythology Retold') === true);
    check('wrapper: content folder (Data) does NOT descend', wraps('Data', 'Age of Mythology: Retold', 'Age of Mythology Retold') === false);
    check('wrapper: crack folder does NOT descend', wraps('CODEX', 'Age of Mythology: Retold', 'Age of Mythology Retold') === false);
  } finally {
    if (server) await new Promise((res) => server.close(res));
    db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
