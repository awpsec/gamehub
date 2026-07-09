// Live-server migration: rows matched under an OLD cleaner carry a stale
// clean_name and a wrong app (the base game). adoptDlcIdentities must rescue
// them hands-free — re-derive the name, resolve official DLC names itself, and
// re-identify the row — without touching the true base game.
import test from 'node:test';
import assert from 'node:assert';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { adoptDlcIdentities } from '../src/matcher.js';

test('adopt: rescues stale wrong-app DLC rows, resolves names, idempotent', async () => {
  const { check, done } = checker();
  const dataDir = tmp('mig-db');
  const db = initDb({ dataDir });
  try {
    const ins = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_kind, meta_dlc, matched_manually)
       VALUES (@rp, @raw, @clean, 'folder', @size, 'matched', 'steam', @pid, @title, @kind, @dlc, 0)`
    );
    // base game with an UNNAMED official list (backfill stamped ids only)
    ins.run({ rp: 'RimWorld-GOG', raw: 'RimWorld-GOG', clean: 'rimworld', size: 500e6, pid: '294100', title: 'RimWorld', kind: 'game', dlc: JSON.stringify([{ id: '2380740', name: null }, { id: '1149640', name: null }]) });
    // a DLC package wrongly matched to the base game, with a STALE clean_name
    ins.run({ rp: 'RimWorld.Anomaly.DLC-RUNE', raw: 'RimWorld.Anomaly.DLC-RUNE', clean: 'rimworld', size: 300e6, pid: '294100', title: 'RimWorld', kind: 'game', dlc: '[]' });

    let nameLookups = 0;
    const steam = {
      name: 'steam',
      async appName(id) {
        nameLookups++;
        return { 2380740: 'RimWorld - Anomaly', 1149640: 'RimWorld - Royalty' }[id] || null;
      },
      async enrich(id) {
        return String(id) === '2380740'
          ? { about: 'ANOMALY ABOUT', hero: 'h', cover: 'c', released: 'Apr 11, 2024', media: { trailer: null, screenshots: [] }, kind: 'dlc', parent: { id: '294100', title: 'RimWorld' }, dlc: [] }
          : {};
      },
    };

    await adoptDlcIdentities(db, [steam]);

    const r = db.prepare("SELECT * FROM games WHERE rel_path = 'RimWorld.Anomaly.DLC-RUNE'").get();
    check('stale wrong-app row rescued to the Steam DLC', r.provider_id === '2380740' && r.meta_kind === 'dlc', `${r.provider_id}/${r.meta_kind}`);
    check('linked to its base game', r.meta_parent_id === '294100', r.meta_parent_id);
    check('takes the official DLC title', r.meta_title === 'RimWorld - Anomaly', r.meta_title);
    const base = db.prepare("SELECT * FROM games WHERE rel_path = 'RimWorld-GOG'").get();
    check('true base game untouched', base.provider_id === '294100' && base.meta_kind === 'game', `${base.provider_id}/${base.meta_kind}`);
    check('official names resolved + cached hands-free', JSON.parse(base.meta_dlc).every((d) => d.name), base.meta_dlc);
    check('name lookups bounded', nameLookups <= 20, String(nameLookups));

    const before = nameLookups;
    await adoptDlcIdentities(db, [steam]);
    check('idempotent (no re-adoption, no re-lookup)', nameLookups === before, String(nameLookups - before));
  } finally {
    db.close();
    rm(dataDir);
  }
  done(assert);
});
