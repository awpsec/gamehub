// Stress test — the RimWorld scenario end to end through the REAL pipeline:
// a game + separate base + a transparent bundle (splits into 4 DLC children) +
// an opaque FitGirl bundle (never split) + separate DLC packages + a DLC
// archive Steam-search misses (rescued from pending). Then a prune cascade.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { scanLibrary } from '../src/scanner.js';
import { matchPendingGames, backfillMedia, adoptDlcIdentities, resolveBundles } from '../src/matcher.js';
import { createApi } from '../src/api.js';

test('bundles: split, dedup, pending-rescue, catalog, prune', async () => {
  const { check, done } = checker();
  const dataDir = tmp('rim-db');
  const libDir = tmp('rim-lib');
  const MB = 1024 * 1024;
  const write = (rel, bytes) => {
    const p = path.join(libDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
  };
  // 1. separate base game
  write('RimWorld.v1.5.4104-GOG/RimWorldWin64.exe', 48 * MB);
  write('RimWorld.v1.5.4104-GOG/RimWorldWin64_Data/resources.assets', 400 * MB);
  // 2. transparent bundle (game exe + all four DLC content folders)
  write('RimWorld.Anomaly-SKIDROW/RimWorldWin64.exe', 48 * MB);
  write('RimWorld.Anomaly-SKIDROW/Data/Core/About.xml', 1 * MB);
  write('RimWorld.Anomaly-SKIDROW/Data/Royalty/About.xml', 60 * MB);
  write('RimWorld.Anomaly-SKIDROW/Data/Ideology/About.xml', 60 * MB);
  write('RimWorld.Anomaly-SKIDROW/Data/Biotech/About.xml', 60 * MB);
  write('RimWorld.Anomaly-SKIDROW/Data/Anomaly/About.xml', 60 * MB);
  // 3. FitGirl-style installer bundle — content compressed, only setup + bins
  write('RimWorld [FitGirl Repack]/setup.exe', 6 * MB);
  write('RimWorld [FitGirl Repack]/fg-01.bin', 300 * MB);
  write('RimWorld [FitGirl Repack]/MD5/fitgirl-bins.md5', 1024);
  // 4-6. separate DLC-only packages: data files, NO exe
  write('RimWorld.Royalty.DLC-RUNE/Data/Royalty/About.xml', 220 * MB);
  write('RimWorld.Ideology.DLC-RUNE/Data/Ideology/About.xml', 220 * MB);
  write('RimWorld.Anomaly.DLC-RUNE/Data/Anomaly/About.xml', 220 * MB);
  // 7. DLC archive that storesearch will MISS
  write('RimWorld.Odyssey.v1.5.zip', 78 * MB);

  const BASE = { provider: 'steam', providerId: '294100', title: 'RimWorld', year: 2018 };
  const DLC = {
    royalty: { provider: 'steam', providerId: '1149640', title: 'RimWorld - Royalty', year: 2020 },
    ideology: { provider: 'steam', providerId: '1392840', title: 'RimWorld - Ideology', year: 2021 },
    biotech: { provider: 'steam', providerId: '1826140', title: 'RimWorld - Biotech', year: 2022 },
    anomaly: { provider: 'steam', providerId: '2380740', title: 'RimWorld - Anomaly', year: 2024 },
    odyssey: { provider: 'steam', providerId: '3022790', title: 'RimWorld - Odyssey', year: 2025 },
  };
  const SOUNDTRACKS = { 901: 'RimWorld - Anomaly Soundtrack', 902: 'RimWorld Soundtrack', 903: 'RimWorld Name in Game Access' };
  const byApp = Object.fromEntries([BASE, ...Object.values(DLC)].map((c) => [c.providerId, c]));
  const OFFICIAL = [...Object.values(DLC).map((d) => d.providerId), '901', '902', '903'];
  const steam = {
    name: 'steam',
    async search(q) {
      const s = q.toLowerCase();
      const out = [];
      for (const d of Object.values(DLC)) {
        if (d === DLC.odyssey) continue; // storesearch misses this one
        const key = d.title.split(' - ')[1].toLowerCase();
        if (s.includes(key)) out.push({ ...d });
      }
      if (s.includes('rimworld')) out.push({ ...BASE });
      return out.map((c) => ({ ...c, cover: `cdn/${c.providerId}.jpg`, summary: null, genres: null }));
    },
    async enrich(appid) {
      const c = byApp[String(appid)];
      if (!c) return {};
      const isBase = c === BASE;
      return {
        year: c.year, released: `Jan 1, ${c.year}`, summary: `${c.title} summary`,
        about: `${c.title} ABOUT`, genres: 'Strategy, Simulation',
        cover: `cdn/${c.providerId}-cover.jpg`, hero: `cdn/${c.providerId}-hero.jpg`,
        ratings: {}, media: { screenshots: ['s1'], trailer: 't1', trailerThumb: 'tt1' },
        compat: { platforms: { windows: true } }, price: null, tags: ['Colony Sim'],
        kind: isBase ? 'game' : 'dlc',
        parent: isBase ? null : { id: BASE.providerId, title: BASE.title },
        dlc: isBase ? OFFICIAL : [],
      };
    },
    async appName(appid) { return byApp[String(appid)]?.title || SOUNDTRACKS[String(appid)] || null; },
  };

  const db = initDb({ dataDir });
  let server = null;
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('libraryDir', ?)").run(libDir);
    const settings = { autoMatchThreshold: 0.85, minCandidateScore: 0.4, libraryDir: libDir };
    const providers = [steam];
    const fullScan = async () => {
      scanLibrary(db, { libraryDir: libDir });
      await matchPendingGames(db, settings, providers);
      await backfillMedia(db, providers);
      await adoptDlcIdentities(db, providers);
      await resolveBundles(db, providers, libDir);
    };
    await fullScan();
    await fullScan(); // idempotency

    const app = createApi({
      config: { dataDir, port: 0 }, db,
      getSettings: () => settings, getProviders: () => providers,
      triggerScan: () => {}, localUser: { id: 1, username: 'test', role: 'admin' },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };

    const rows = db.prepare('SELECT * FROM games ORDER BY id').all();
    const dump = () => rows.map((r) => `${r.rel_path} → ${r.provider_id} ${r.meta_kind} ${r.status}`).join(' | ');

    check('11 rows total (7 packages + 4 bundle children)', rows.length === 11, dump());
    const bases = rows.filter((r) => r.provider_id === BASE.providerId && r.meta_kind === 'game');
    check('base game = 3 packages of ONE logical game (GOG + bundle + FitGirl)', bases.length === 3, dump());
    const fitgirl = rows.find((r) => r.rel_path === 'RimWorld [FitGirl Repack]');
    check('FitGirl installer bundle stays a plain base version (opaque payload)', fitgirl?.meta_kind === 'game' && fitgirl?.provider_id === BASE.providerId, fitgirl && `${fitgirl.meta_kind}/${fitgirl.provider_id}`);
    check('FitGirl bundle never split (setup.exe is not a game exe)', !rows.some((r) => r.rel_path.startsWith('RimWorld [FitGirl Repack]::')), dump());
    const children = rows.filter((r) => r.rel_path.includes('::dlc/'));
    check('transparent bundle produced exactly 4 children', children.length === 4 && new Set(children.map((c) => c.provider_id)).size === 4, dump());
    const ody = rows.find((r) => r.rel_path === 'RimWorld.Odyssey.v1.5.zip');
    check('storesearch-missed DLC archive rescued from pending → matched', ody?.status === 'matched' && ody?.provider_id === DLC.odyssey.providerId, ody && `${ody.status}/${ody.provider_id}`);
    check('…as a DLC linked to the base game', ody?.meta_kind === 'dlc' && ody?.meta_parent_id === BASE.providerId, ody && `${ody.meta_kind}/${ody.meta_parent_id}`);
    check('…with the official title', ody?.meta_title === 'RimWorld - Odyssey', ody?.meta_title);

    const gogId = rows.find((r) => r.rel_path.startsWith('RimWorld.v1.5')).id;
    const cat = (await get(`/api/games/${gogId}/dlc`)).body.dlc;
    check('catalog lists the 5 real DLC', cat.length === 5, JSON.stringify(cat.map((c) => c.name)));
    check('soundtracks/supporter items hidden (not owned)', !cat.some((c) => /soundtrack|name in game/i.test(c.name)), JSON.stringify(cat.map((c) => c.name)));
    check('ALL 5 in library (4 real packages + Biotech via bundle)', cat.every((c) => c.inLibrary), JSON.stringify(cat));
    check('Biotech marked Included (bundle-only)', cat.find((c) => c.appid === DLC.biotech.providerId)?.included === true, JSON.stringify(cat));
    check('Anomaly resolves to the real package (dup control)', cat.find((c) => c.appid === DLC.anomaly.providerId)?.included === false, JSON.stringify(cat));
    check('Odyssey in library via the rescued archive', cat.find((c) => c.appid === DLC.odyssey.providerId)?.inLibrary === true, JSON.stringify(cat));

    // prune: transparent bundle folder removed → its children die with it
    fs.rmSync(path.join(libDir, 'RimWorld.Anomaly-SKIDROW'), { recursive: true, force: true });
    await fullScan();
    const after = db.prepare('SELECT rel_path FROM games ORDER BY id').all().map((r) => r.rel_path);
    check('bundle + its 4 children pruned (6 rows left)', after.length === 6 && !after.some((p) => p.includes('::')), JSON.stringify(after));
    const cat2 = (await get(`/api/games/${gogId}/dlc`)).body.dlc;
    check('post-prune: Biotech gone, others still owned', cat2.find((c) => c.appid === DLC.biotech.providerId)?.inLibrary === false && cat2.filter((c) => c.inLibrary).length === 4, JSON.stringify(cat2));
  } finally {
    if (server) await new Promise((res) => server.close(res));
    db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
