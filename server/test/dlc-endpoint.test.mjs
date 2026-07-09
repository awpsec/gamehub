// GET /api/games/:id/dlc against a REAL embedded server: the catalog unions the
// base game's official list with reverse-edges (owned DLC linking back), works
// from either the base or a DLC's page, and flags bundle-included children.
import test from 'node:test';
import assert from 'node:assert';
import { checker, tmp, rm } from './_helpers.mjs';
import { startEmbeddedServer } from '../src/embed.js';

test('dlc endpoint: official list ∪ reverse edges, both directions', async () => {
  const { check, done } = checker();
  const dataDir = tmp('dlc-ep-db');
  const libDir = tmp('dlc-ep-lib');
  const srv = startEmbeddedServer({ dataDir, libraryDir: libDir, port: 0, host: '127.0.0.1', localMode: true });
  try {
    const port = await srv.ready;
    const db = srv.db;
    const ins = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_kind, meta_parent_id, meta_parent_title, meta_dlc)
       VALUES (@rp, @rp, @rp, 'folder', 1, 'matched', 'steam', @pid, @title, @kind, @parent, @ptitle, @dlc)`
    );
    // House Flipper 2: base game, DLC list NOT stamped yet
    ins.run({ rp: 'HF2', pid: 'hf2', title: 'House Flipper 2', kind: 'game', parent: null, ptitle: null, dlc: null });
    const hf2 = db.prepare("SELECT id FROM games WHERE rel_path = 'HF2'").get().id;
    // the owned Scooby-Doo DLC, classified + linked to HF2
    ins.run({ rp: 'HF2.Scooby', pid: 'scooby', title: 'House Flipper 2 - Scooby-Doo DLC', kind: 'dlc', parent: 'hf2', ptitle: 'House Flipper 2', dlc: '[]' });
    const scoobyId = db.prepare("SELECT id FROM games WHERE rel_path = 'HF2.Scooby'").get().id;
    // a second base game WITH a stamped official list (names pre-resolved)
    ins.run({ rp: 'AOM', pid: 'aom', title: 'Age of Mythology: Retold', kind: 'game', parent: null, ptitle: null, dlc: JSON.stringify([{ id: 'ip77', name: 'Immortal Pillars' }, { id: 'zz88', name: 'Future Pack' }]) });
    const aom = db.prepare("SELECT id FROM games WHERE rel_path = 'AOM'").get().id;
    ins.run({ rp: 'AOM.IP', pid: 'ip77', title: 'Immortal Pillars', kind: 'dlc', parent: 'aom', ptitle: 'Age of Mythology: Retold', dlc: '[]' });

    const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

    // reverse edge only (the HF2 case)
    const hf2Dlc = (await get(`/api/games/${hf2}/dlc`)).dlc;
    check('HF2 (no stamped list) still lists its owned DLC', hf2Dlc.length === 1, JSON.stringify(hf2Dlc));
    check('…the Scooby DLC, marked in-library', hf2Dlc[0]?.appid === 'scooby' && hf2Dlc[0]?.inLibrary === true && hf2Dlc[0]?.gameId === scoobyId, JSON.stringify(hf2Dlc[0]));

    // official list ∪ ownership, owned first
    const aomDlc = (await get(`/api/games/${aom}/dlc`)).dlc;
    check('AoM lists both official DLC', aomDlc.length === 2, JSON.stringify(aomDlc));
    check('owned DLC first + flagged', aomDlc[0]?.appid === 'ip77' && aomDlc[0]?.inLibrary === true, JSON.stringify(aomDlc[0]));
    check('absent DLC listed, not in library', aomDlc[1]?.appid === 'zz88' && aomDlc[1]?.inLibrary === false, JSON.stringify(aomDlc[1]));

    // game with neither edge → empty
    ins.run({ rp: 'SOLO', pid: 'solo', title: 'No DLC Game', kind: 'game', parent: null, ptitle: null, dlc: '[]' });
    const solo = db.prepare("SELECT id FROM games WHERE rel_path = 'SOLO'").get().id;
    const soloDlc = (await get(`/api/games/${solo}/dlc`)).dlc;
    check('game without DLC returns empty list', Array.isArray(soloDlc) && soloDlc.length === 0, JSON.stringify(soloDlc));

    // an included-DLC child (split from a bundle) is flagged `included`
    db.prepare("UPDATE games SET payload_type = 'dlc-included' WHERE rel_path = 'AOM.IP'").run();
    const aomDlc2 = (await get(`/api/games/${aom}/dlc`)).dlc;
    check('included-DLC child flagged in the catalog', aomDlc2.find((r) => r.appid === 'ip77')?.included === true, JSON.stringify(aomDlc2));

    // querying from the DLC side returns the BASE game's full catalog
    const ipId = db.prepare("SELECT id FROM games WHERE rel_path = 'AOM.IP'").get().id;
    const sib = await get(`/api/games/${ipId}/dlc`);
    check('DLC-side query resolves the parent appid', sib.parentAppId === 'aom', JSON.stringify(sib.parentAppId));
    check('…and returns the full catalog (self + absent sibling)', sib.dlc.length === 2, JSON.stringify(sib.dlc));
    check('…self present + in library', sib.dlc.some((r) => r.appid === 'ip77' && r.inLibrary), JSON.stringify(sib.dlc));
    check('…other DLC listed as not in library', sib.dlc.some((r) => r.appid === 'zz88' && !r.inLibrary), JSON.stringify(sib.dlc));

    // DLC side with NO parent row on the server — reverse edges only
    const scoobySib = await get(`/api/games/${scoobyId}/dlc`);
    check('parent-less DLC still sees itself via reverse edge', scoobySib.dlc.length === 1 && scoobySib.dlc[0].appid === 'scooby', JSON.stringify(scoobySib.dlc));
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
