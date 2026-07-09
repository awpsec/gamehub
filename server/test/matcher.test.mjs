// End-to-end verification of the matcher against a REAL sqlite DB with fake
// network providers: Steam-primary metadata + RAWG gap-fill, DLC identity, the
// two Steam-upgrade migrations, adopt, and bundle-splitting.
import test from 'node:test';
import assert from 'node:assert';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { matchPendingGames, scoreCandidate, adoptDlcIdentities, resolveBundles } from '../src/matcher.js';

test('matcher pipeline: Steam-primary, DLC identity, migrations, adopt, bundles', async () => {
  const { check, done } = checker();
  const dataDir = tmp('e2e-db');
  const db = initDb({ dataDir });
  try {
    // ---------- case 1: Steam + RAWG both match; Steam thin on trailer ----------
    db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('Sons.of.the.Forest', 'Sons.of.the.Forest-RUNE', 'sons of the forest', 'folder', 100, 'new')`
    ).run();

    const rawg = {
      name: 'rawg',
      search: async () => [
        { provider: 'rawg', providerId: 'r1', title: 'Sons Of The Forest', year: 2024, cover: 'rawg-cover', summary: 'rawg sum', genres: 'Survival' },
      ],
      enrich: async () => ({
        about: 'RAWG ABOUT', hero: 'rawg-hero', released: '2024-02-22',
        media: { trailer: 'rawg-trailer', trailerThumb: 'rawg-thumb', screenshots: ['r-s1', 'r-s2'] },
        tags: ['Survival'],
      }),
    };
    const steam = {
      name: 'steam',
      search: async () => [
        { provider: 'steam', providerId: 's1', title: 'Sons Of The Forest', year: 2024, cover: 'steam-cover', summary: 'steam sum', genres: 'Survival' },
      ],
      enrich: async () => ({
        about: 'STEAM ABOUT', hero: 'steam-hero', released: 'Feb 22, 2024',
        media: { trailer: null, screenshots: [] }, // thin: no trailer/screens
        compat: { windows: true }, tags: ['Survival', 'Open World'],
        kind: 'game', parent: null, dlc: ['111', '222'], // base game with 2 official DLC
      }),
    };

    const settings = { autoMatchThreshold: 0.85, minCandidateScore: 0.4 };
    await matchPendingGames(db, settings, [rawg, steam]); // rawg FIRST = would win stable-sort ties

    const g = db.prepare("SELECT * FROM games WHERE rel_path = 'Sons.of.the.Forest'").get();
    const media = JSON.parse(g.meta_media || '{}');
    check('status matched', g.status === 'matched', g.status);
    check('Steam wins the tie over RAWG', g.provider === 'steam', g.provider);
    check('Steam About kept (not overwritten)', g.meta_about === 'STEAM ABOUT', g.meta_about);
    check('Steam hero kept', g.meta_hero === 'steam-hero', g.meta_hero);
    check('Steam release date kept', g.meta_released === 'Feb 22, 2024', g.meta_released);
    check('RAWG trailer gap-filled', media.trailer === 'rawg-trailer', JSON.stringify(media));
    check('RAWG screenshots gap-filled', (media.screenshots || []).length === 2, JSON.stringify(media));
    check('auto-match sets matched_manually=0', g.matched_manually === 0, String(g.matched_manually));
    const t = Date.parse(g.meta_released);
    check('Steam date format parses for NEW badge', !Number.isNaN(t) && t > 0, g.meta_released);
    check('base game gets meta_kind=game', g.meta_kind === 'game', String(g.meta_kind));
    const dlcList = JSON.parse(g.meta_dlc || '[]');
    check('official DLC list stored', dlcList.length === 2 && dlcList[0].id === '111', g.meta_dlc);

    // ---------- case 1b: a DLC folder matches its Steam DLC app and links to its parent ----------
    db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('AoM.Immortal.Pillars', 'AoM.Immortal.Pillars-RUNE', 'immortal pillars', 'folder', 100, 'new')`
    ).run();
    const steamDlc = {
      name: 'steam',
      search: async () => [
        { provider: 'steam', providerId: 'd77', title: 'Immortal Pillars', year: 2025, cover: 'c', summary: 's', genres: 'Strategy' },
      ],
      enrich: async () => ({
        about: 'A', hero: 'h', released: 'Mar 4, 2025', media: { trailer: 't', screenshots: ['x'] },
        kind: 'dlc', parent: { id: '999', title: 'Age of Mythology: Retold' }, dlc: [],
      }),
    };
    await matchPendingGames(db, settings, [steamDlc]);
    const gd = db.prepare("SELECT * FROM games WHERE rel_path = 'AoM.Immortal.Pillars'").get();
    check('DLC folder matches and is flagged kind=dlc', gd.status === 'matched' && gd.meta_kind === 'dlc', `${gd.status}/${gd.meta_kind}`);
    check('DLC links to its base game', gd.meta_parent_id === '999' && gd.meta_parent_title === 'Age of Mythology: Retold', `${gd.meta_parent_id}/${gd.meta_parent_title}`);

    // ---------- case 2: only RAWG has the game (delisted) — RAWG still matches ----------
    db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('Delisted.Game', 'Delisted.Game-KAOS', 'delisted game', 'folder', 100, 'new')`
    ).run();
    const rawgOnly = {
      name: 'rawg',
      search: async (q) => q.toLowerCase().includes('delisted')
        ? [{ provider: 'rawg', providerId: 'r9', title: 'Delisted Game', year: 2015, cover: 'c', summary: 's', genres: 'Action' }]
        : [],
      enrich: async () => ({ about: 'A', hero: 'h', media: { trailer: 't', screenshots: ['x'] }, released: '2015-01-01' }),
    };
    const steamEmpty = { name: 'steam', search: async () => [], enrich: async () => ({}) };
    await matchPendingGames(db, settings, [rawgOnly, steamEmpty]);
    const g2 = db.prepare("SELECT * FROM games WHERE rel_path = 'Delisted.Game'").get();
    check('RAWG-only game still matches via RAWG', g2.status === 'matched' && g2.provider === 'rawg', `${g2.status}/${g2.provider}`);

    // ---------- case 3: the one-time upgrade migration (exact SQL from embed.js) ----------
    const ins = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, confidence, matched_manually)
       VALUES (@rp, @rp, @rp, 'folder', 1, 'matched', @prov, @conf, @manual)`
    );
    ins.run({ rp: 'm1-rawg-auto', prov: 'rawg', conf: 0.92, manual: 0 });   // -> requeue
    ins.run({ rp: 'm2-rawg-manual-old', prov: 'rawg', conf: 1.0, manual: 0 }); // old manual -> keep
    ins.run({ rp: 'm3-rawg-manual-new', prov: 'rawg', conf: 1.0, manual: 1 }); // new manual -> keep
    ins.run({ rp: 'm4-steam-auto', prov: 'steam', conf: 0.9, manual: 0 });  // steam -> keep
    ins.run({ rp: 'm5-igdb-auto', prov: 'igdb', conf: 0.88, manual: 0 });   // -> requeue

    const changes = db
      .prepare(
        "UPDATE games SET status = 'new', updated_at = datetime('now') " +
          "WHERE status = 'matched' AND provider IN ('rawg', 'igdb') " +
          "AND matched_manually != 1 AND confidence < 1.0"
      )
      .run().changes;
    check('migration requeues exactly the 2 keyed auto-matches', changes === 2, String(changes));
    const st = (rp) => db.prepare('SELECT status FROM games WHERE rel_path = ?').get(rp).status;
    check('rawg auto requeued', st('m1-rawg-auto') === 'new', st('m1-rawg-auto'));
    check('old manual (conf=1.0) preserved', st('m2-rawg-manual-old') === 'matched', st('m2-rawg-manual-old'));
    check('flagged manual preserved', st('m3-rawg-manual-new') === 'matched', st('m3-rawg-manual-new'));
    check('steam match preserved', st('m4-steam-auto') === 'matched', st('m4-steam-auto'));
    check('igdb auto requeued', st('m5-igdb-auto') === 'new', st('m5-igdb-auto'));

    // ---------- case 4: v2 migration — perfect-title (conf=1.0) auto-matches upgrade ----------
    const ins2 = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, hint_year, payload_type, size_bytes, status, provider, confidence, matched_manually, meta_title, meta_year)
       VALUES (@rp, @rp, @clean, @hintYear, 'folder', 1, 'matched', 'rawg', @conf, @manual, @title, @year)`
    );
    ins2.run({ rp: 'v2-sotf', clean: 'sons of the forest', hintYear: null, conf: 1.0, manual: 0, title: 'Sons Of The Forest', year: 2024 });
    ins2.run({ rp: 'v2-shogun', clean: 'total war shogun 2', hintYear: null, conf: 1.0, manual: 0, title: 'Total War: SHOGUN 2', year: 2011 });
    ins2.run({ rp: 'v2-manual-old', clean: 'weird release name 3000', hintYear: null, conf: 1.0, manual: 0, title: 'Pragmata', year: 2026 });
    ins2.run({ rp: 'v2-manual-new', clean: 'sekiro', hintYear: null, conf: 1.0, manual: 1, title: 'Sekiro: Shadows Die Twice', year: 2019 });

    const threshold = 0.85;
    const rows = db
      .prepare(
        "SELECT id, clean_name, hint_year, meta_title, meta_year FROM games " +
          "WHERE status = 'matched' AND provider IN ('rawg', 'igdb') AND matched_manually != 1"
      )
      .all();
    const requeue = db.prepare("UPDATE games SET status = 'new', updated_at = datetime('now') WHERE id = ?");
    for (const r of rows) {
      const score = scoreCandidate(r.clean_name, r.hint_year, { title: r.meta_title || '', year: r.meta_year });
      if (score >= threshold) requeue.run(r.id);
    }
    check('v2: Sons of the Forest (conf=1.0) requeued', st('v2-sotf') === 'new', st('v2-sotf'));
    check('v2: SHOGUN 2 (colon title, conf=1.0) requeued', st('v2-shogun') === 'new', st('v2-shogun'));
    check('v2: old hard manual fix preserved', st('v2-manual-old') === 'matched', st('v2-manual-old'));
    check('v2: flagged manual preserved', st('v2-manual-new') === 'matched', st('v2-manual-new'));
    check('v2: steam match still untouched', st('m4-steam-auto') === 'matched', st('m4-steam-auto'));

    // ---------- case 5: adoptDlcIdentities — RAWG-matched DLC re-identified ----------
    const insA = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_kind, meta_dlc, matched_manually)
       VALUES (@rp, @rp, @clean, 'folder', 1, 'matched', @prov, @pid, @title, @kind, @dlc, @manual)`
    );
    insA.run({ rp: 'HF2', clean: 'house flipper 2', prov: 'steam', pid: 'hf2', title: 'House Flipper 2', kind: 'game', dlc: JSON.stringify([{ id: 'sc9', name: 'House Flipper 2 - Scooby-Doo Pack' }]), manual: 0 });
    insA.run({ rp: 'HF2.Scooby', clean: 'house flipper 2 scooby doo pack', prov: 'rawg', pid: 'r-sc', title: 'Scooby Doo Mystery', kind: 'game', dlc: '[]', manual: 0 });
    insA.run({ rp: 'HF2.Scooby.Manual', clean: 'house flipper 2 scooby doo pack', prov: 'rawg', pid: 'r-sc2', title: 'Hand Picked', kind: 'game', dlc: '[]', manual: 1 });
    insA.run({ rp: 'Unrelated', clean: 'stardew valley', prov: 'rawg', pid: 'r-sv', title: 'Stardew Valley', kind: 'game', dlc: '[]', manual: 0 });

    const steamAdopt = {
      name: 'steam',
      search: async () => [],
      enrich: async (id) => ({
        about: `ABOUT-${id}`, hero: `hero-${id}`, cover: `cover-${id}`, released: 'Jun 1, 2024',
        media: { trailer: null, screenshots: [] }, kind: 'dlc', parent: { id: 'hf2', title: 'House Flipper 2' }, dlc: [],
      }),
    };
    await adoptDlcIdentities(db, [steamAdopt]);
    const sc = db.prepare("SELECT * FROM games WHERE rel_path = 'HF2.Scooby'").get();
    check('adopt: RAWG-matched DLC re-identified to Steam DLC app', sc.provider === 'steam' && sc.provider_id === 'sc9', `${sc.provider}/${sc.provider_id}`);
    check('adopt: flagged dlc + linked to base', sc.meta_kind === 'dlc' && sc.meta_parent_id === 'hf2', `${sc.meta_kind}/${sc.meta_parent_id}`);
    check('adopt: takes the official DLC title', sc.meta_title === 'House Flipper 2 - Scooby-Doo Pack', sc.meta_title);
    const scm = db.prepare("SELECT provider, meta_kind FROM games WHERE rel_path = 'HF2.Scooby.Manual'").get();
    check('adopt: manual match untouched', scm.provider === 'rawg' && scm.meta_kind === 'game', JSON.stringify(scm));
    const sv = db.prepare("SELECT provider FROM games WHERE rel_path = 'Unrelated'").get();
    check('adopt: unrelated game untouched', sv.provider === 'rawg', sv.provider);
    await adoptDlcIdentities(db, [steamAdopt]);
    const scAgain = db.prepare("SELECT provider_id FROM games WHERE rel_path = 'HF2.Scooby'").get();
    check('adopt: second pass is a no-op', scAgain.provider_id === 'sc9', scAgain.provider_id);

    // ---------- case 6: resolveBundles — DLC-typed package splits into base + child ----------
    const insB = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_cover, meta_about, meta_kind, meta_parent_id, meta_parent_title, matched_manually)
       VALUES (@rp, @rp, @clean, 'folder', @size, 'matched', 'steam', @pid, @title, @cover, @about, 'dlc', @parent, @ptitle, @manual)`
    );
    insB.run({ rp: 'AOM.IP.Bundle', clean: 'age of mythology retold immortal pillars', size: 13.3 * 1024 ** 3, pid: 'ip77', title: 'Age of Mythology: Retold - Immortal Pillars', cover: 'ip-cover', about: 'IP ABOUT', parent: 'aom9', ptitle: 'Age of Mythology: Retold', manual: 0 });
    insB.run({ rp: 'Small.DLC', clean: 'small dlc', size: 800 * 1024 ** 2, pid: 'sd1', title: 'Small DLC', cover: null, about: null, parent: 'aom9', ptitle: 'Age of Mythology: Retold', manual: 0 });
    insB.run({ rp: 'Manual.Big', clean: 'manual big', size: 20 * 1024 ** 3, pid: 'mb1', title: 'Manual Big', cover: null, about: null, parent: 'aom9', ptitle: 'Age of Mythology: Retold', manual: 1 });

    const steamBundle = {
      name: 'steam',
      search: async () => [],
      enrich: async (id) => id === 'aom9'
        ? { year: 2024, about: 'AOM ABOUT', hero: 'aom-hero', cover: 'aom-cover', summary: 'aom sum', released: 'Sep 4, 2024', genres: 'Strategy', media: { trailer: 'aom-tr', screenshots: ['a'] }, compat: {}, price: null, tags: ['RTS'], kind: 'game', parent: null, dlc: ['ip77', 'future1'] }
        : {},
    };
    await resolveBundles(db, [steamBundle]);

    const base = db.prepare("SELECT * FROM games WHERE rel_path = 'AOM.IP.Bundle'").get();
    check('bundle: physical row flipped to the base game', base.provider_id === 'aom9' && base.meta_kind === 'game', `${base.provider_id}/${base.meta_kind}`);
    check('bundle: base game title + metadata', base.meta_title === 'Age of Mythology: Retold' && base.meta_about === 'AOM ABOUT' && base.meta_hero === 'aom-hero', `${base.meta_title}`);
    const baseDlc = JSON.parse(base.meta_dlc || '[]');
    check('bundle: official list stamped with child name pre-filled', baseDlc.length === 2 && baseDlc.find((d) => d.id === 'ip77')?.name === 'Age of Mythology: Retold - Immortal Pillars', base.meta_dlc);
    const child = db.prepare("SELECT * FROM games WHERE rel_path = 'AOM.IP.Bundle::dlc/ip77'").get();
    check('bundle: child DLC row created', !!child, 'missing');
    check('bundle: child keeps the DLC identity', child?.provider_id === 'ip77' && child?.meta_kind === 'dlc' && child?.meta_title === 'Age of Mythology: Retold - Immortal Pillars', child && `${child.provider_id}/${child.meta_kind}`);
    check('bundle: child is payload dlc-included, 0 bytes', child?.payload_type === 'dlc-included' && child?.size_bytes === 0, child && `${child.payload_type}/${child.size_bytes}`);
    check('bundle: small DLC package not split', db.prepare("SELECT meta_kind FROM games WHERE rel_path = 'Small.DLC'").get().meta_kind === 'dlc', 'was split');
    check('bundle: manual match not split', db.prepare("SELECT meta_kind FROM games WHERE rel_path = 'Manual.Big'").get().meta_kind === 'dlc', 'was split');
    await resolveBundles(db, [steamBundle]);
    const childCount = db.prepare("SELECT COUNT(*) n FROM games WHERE rel_path LIKE '%::dlc/%'").get().n;
    check('bundle: second pass is a no-op', childCount === 1, String(childCount));
  } finally {
    db.close();
    rm(dataDir);
  }
  done(assert);
});
