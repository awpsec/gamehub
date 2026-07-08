import { cleanName, similarity, isEditionVariant, numberSignature } from './namecleaner.js';
import { createRawgProvider } from './providers/rawg.js';
import { createIgdbProvider } from './providers/igdb.js';
import { createSteamProvider } from './providers/steam.js';
import { logEvent, clearGameEvents } from './events.js';

// Provider instances are cached by credentials so the IGDB token survives
// between scans, but a settings change rebuilds them immediately.
let providerCache = { sig: null, providers: [] };

export function buildProviders(settings) {
  const sig = JSON.stringify([
    settings.steamEnabled,
    settings.igdbClientId,
    settings.igdbClientSecret,
    settings.rawgApiKey,
  ]);
  if (providerCache.sig === sig) return providerCache.providers;
  const providers = [];
  // order only affects search-result collection; preferSteam() decides winners
  if (settings.igdbClientId && settings.igdbClientSecret) {
    providers.push(createIgdbProvider(settings.igdbClientId, settings.igdbClientSecret));
  }
  if (settings.rawgApiKey) {
    providers.push(createRawgProvider(settings.rawgApiKey));
  }
  // Steam is keyless and enabled by default — zero-config matching
  if (settings.steamEnabled) {
    providers.push(createSteamProvider());
  }
  providerCache = { sig, providers };
  return providers;
}

// fill in year/summary/genres (and a validated cover) for providers that
// support a per-title details call, e.g. Steam
export async function enrichCandidate(providers, candidate) {
  const prov = providers.find((p) => p.name === candidate.provider);
  if (!prov?.enrich) return candidate;
  try {
    const extra = await prov.enrich(candidate.providerId);
    return {
      ...candidate,
      year: candidate.year ?? extra.year ?? null,
      released: extra.released ?? candidate.released ?? null,
      summary: extra.summary || candidate.summary || null,
      about: extra.about ?? candidate.about ?? null,
      genres: candidate.genres || extra.genres || null,
      cover: extra.cover || candidate.cover || null,
      hero: extra.hero || candidate.hero || null,
      ratings: { ...(candidate.ratings || {}), ...(extra.ratings || {}) },
      media: extra.media || candidate.media || null,
      compat: extra.compat || candidate.compat || null,
      price: extra.price ?? candidate.price ?? null,
      tags: extra.tags ?? candidate.tags ?? null,
      // DLC identity (Steam-only): is this a DLC, whose, and what official
      // DLC exist for it when it's a base game
      kind: extra.kind ?? candidate.kind ?? null,
      parent: extra.parent ?? candidate.parent ?? null,
      dlc: extra.dlc ?? candidate.dlc ?? null,
    };
  } catch {
    return candidate; // enrichment is best-effort
  }
}

// Steam carries the richest metadata (About This Game, trailers, screenshots,
// hi-res hero art), so prefer a Steam candidate whenever it matches essentially
// as well as the top-scoring one. RAWG/IGDB stay as fallbacks for titles Steam
// doesn't have at all (e.g. delisted games).
const STEAM_PREFER_MARGIN = 0.06;

function preferSteam(scored, threshold) {
  const top = scored[0];
  if (!top || top.provider === 'steam') return top;
  const steam = scored.find((c) => c.provider === 'steam');
  // only swap to Steam if it too is a confident match — never demote a solid
  // RAWG/IGDB match to pending just because Steam scored below threshold
  if (steam && steam.score >= threshold && steam.score >= top.score - STEAM_PREFER_MARGIN) return steam;
  return top;
}

// Enrich the chosen match, then FILL GAPS from a same-game match on another
// provider (never overwrite): a Steam match stays Steam but can borrow, say, a
// trailer or About text from RAWG when Steam happens to be missing it.
async function enrichWithFallback(providers, best, scored) {
  best = await enrichCandidate(providers, best);
  const thin = !best.about || !best.hero || !best.media?.trailer || !best.media?.screenshots?.length;
  if (!thin) return best;
  const secondary = scored.find(
    (c) => c.provider !== best.provider && c.score >= best.score - STEAM_PREFER_MARGIN && c.score >= 0.85
  );
  if (!secondary) return best;
  const extra = await enrichCandidate(providers, secondary);
  return {
    ...best,
    year: best.year ?? extra.year ?? null,
    released: best.released || extra.released || null,
    summary: best.summary || extra.summary || null,
    about: best.about || extra.about || null,
    genres: best.genres || extra.genres || null,
    cover: best.cover || extra.cover || null,
    hero: best.hero || extra.hero || null,
    compat: best.compat || extra.compat || null,
    ratings: { ...(extra.ratings || {}), ...(best.ratings || {}) },
    media: {
      screenshots: best.media?.screenshots?.length ? best.media.screenshots : extra.media?.screenshots || [],
      trailer: best.media?.trailer || extra.media?.trailer || null,
      trailerThumb: best.media?.trailerThumb || extra.media?.trailerThumb || null,
    },
    tags: best.tags?.length ? best.tags : extra.tags || [],
    kind: best.kind ?? extra.kind ?? null,
    parent: best.parent ?? extra.parent ?? null,
    dlc: best.dlc ?? extra.dlc ?? null,
  };
}

export function scoreCandidate(cleanName, hintYear, candidate) {
  let score = similarity(cleanName, candidate.title);
  // "Hades II" must never auto-match "Hades" — differing number tokens
  // mean a different entry in the series
  if (numberSignature(cleanName) !== numberSignature(candidate.title)) {
    score = Math.max(0, score - 0.15);
  }
  // "Ghost of Tsushima" ~ "Ghost of Tsushima DIRECTOR'S CUT" — same game,
  // different edition. Never fires for sequels (numerals aren't edition words).
  if (score < 0.88 && isEditionVariant(cleanName, candidate.title)) {
    score = Math.max(score, 0.88);
  }
  if (hintYear && candidate.year) {
    if (candidate.year === hintYear) score = Math.min(1, score + 0.08);
    else if (Math.abs(candidate.year - hintYear) > 2) score = Math.max(0, score - 0.05);
  }
  return score;
}

export async function searchAllProviders(providers, query, db = null) {
  const results = [];
  for (const p of providers) {
    try {
      results.push(...(await p.search(query)));
    } catch (err) {
      if (db) {
        logEvent(db, 'error', 'provider', `${p.name} search failed for “${query}”`, err.message, {
          action: { route: '#/settings/sources', label: 'Check source' },
        });
      } else {
        console.error(`[matcher] provider ${p.name} error: ${err.message}`);
      }
    }
  }
  const seen = new Set();
  return results.filter((c) => {
    const key = `${c.provider}:${c.providerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function matchPendingGames(db, settings, providers) {
  const games = db.prepare("SELECT * FROM games WHERE status = 'new'").all();
  if (games.length === 0) return;

  if (providers.length === 0) {
    const upd = db.prepare(
      "UPDATE games SET status = 'unmatched', updated_at = datetime('now') WHERE id = ?"
    );
    for (const g of games) upd.run(g.id);
    logEvent(
      db,
      'warn',
      'matcher',
      `No metadata source configured — ${games.length} game(s) marked unmatched`,
      'Add a RAWG key or IGDB credentials in Settings → Metadata Sources, then use “Re-run matching”.',
      { action: { route: '#/settings/sources', label: 'Add source' } }
    );
    return;
  }

  const insertCandidate = db.prepare(`
    INSERT INTO candidates (game_id, provider, provider_id, title, year, cover, summary, genres, score)
    VALUES (@game_id, @provider, @provider_id, @title, @year, @cover, @summary, @genres, @score)
  `);
  const clearCandidates = db.prepare('DELETE FROM candidates WHERE game_id = ?');
  const applyMatch = db.prepare(`
    UPDATE games SET status = 'matched', confidence = @confidence,
      provider = @provider, provider_id = @provider_id,
      meta_title = @title, meta_year = @year, meta_cover = @cover,
      meta_summary = @summary, meta_genres = @genres, meta_about = @about,
      meta_released = @released,
      meta_hero = @hero, meta_ratings = @ratings, meta_media = @media, meta_compat = @compat,
      meta_price = @price, meta_tags = @tags, matched_manually = 0,
      meta_kind = @kind, meta_parent_id = @parent_id, meta_parent_title = @parent_title, meta_dlc = @dlc,
      updated_at = datetime('now')
    WHERE id = @game_id
  `);
  const setStatus = db.prepare(
    "UPDATE games SET status = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?"
  );
  // Keep the stored search name in step with the current cleaner, so re-running
  // matching heals rows parsed by an older version (new releaser handles,
  // version-tail stripping, …) instead of reusing their stale clean_name.
  const refreshClean = db.prepare(
    "UPDATE games SET clean_name = @clean, hint_year = @hintYear WHERE id = @id"
  );

  for (const game of games) {
    // Re-derive from raw_name every pass (self-heals older parses); clear any
    // stale match events first so a re-run replaces them instead of stacking up.
    const parsed = cleanName(game.raw_name);
    if (parsed.clean !== game.clean_name || (parsed.hintYear ?? null) !== (game.hint_year ?? null)) {
      refreshClean.run({ id: game.id, clean: parsed.clean, hintYear: parsed.hintYear ?? null });
      game.clean_name = parsed.clean;
      game.hint_year = parsed.hintYear ?? null;
    }
    clearGameEvents(db, game.id);

    const candidates = await searchAllProviders(providers, game.clean_name, db);

    const scored = candidates
      .map((c) => ({ ...c, score: scoreCandidate(game.clean_name, game.hint_year, c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    clearCandidates.run(game.id);
    for (const c of scored) {
      insertCandidate.run({
        game_id: game.id,
        provider: c.provider,
        provider_id: c.providerId,
        title: c.title,
        year: c.year,
        cover: c.cover,
        summary: c.summary,
        genres: c.genres,
        score: c.score,
      });
    }

    let best = preferSteam(scored, settings.autoMatchThreshold);
    if (best && best.score >= settings.autoMatchThreshold) {
      best = await enrichWithFallback(providers, best, scored);
      applyMatch.run({
        game_id: game.id,
        confidence: best.score,
        provider: best.provider,
        provider_id: best.providerId,
        title: best.title,
        year: best.year,
        released: best.released || null,
        cover: best.cover,
        summary: best.summary,
        about: best.about || null,
        genres: best.genres,
        hero: best.hero || null,
        ratings: best.ratings && Object.keys(best.ratings).length ? JSON.stringify(best.ratings) : null,
        media: best.media ? JSON.stringify(best.media) : null,
        compat: best.compat ? JSON.stringify(best.compat) : null,
        price: best.price ? JSON.stringify(best.price) : null,
        tags: JSON.stringify(best.tags || []),
        kind: best.kind || 'game',
        parent_id: best.parent?.id || null,
        parent_title: best.parent?.title || null,
        dlc: JSON.stringify((best.dlc || []).map((id) => ({ id: String(id), name: null }))),
      });
      clearGameEvents(db, game.id); // any earlier match warnings are now resolved
      logEvent(
        db,
        'info',
        'matcher',
        `Auto-matched “${game.raw_name}” → “${best.title}” (${Math.round(best.score * 100)}%)`
      );
    } else if (best && best.score >= settings.minCandidateScore) {
      setStatus.run('pending', best.score, game.id);
      logEvent(
        db,
        'warn',
        'matcher',
        `“${game.raw_name}” needs review — best guess “${best.title}” (${Math.round(best.score * 100)}%)`,
        '',
        { gameId: game.id, action: { route: '#/activity', gameId: game.id, label: 'Review match' } }
      );
    } else {
      setStatus.run('unmatched', best ? best.score : 0, game.id);
      logEvent(db, 'warn', 'matcher', `No confident match for “${game.raw_name}”`, '', {
        gameId: game.id,
        action: { route: '#/activity', gameId: game.id, label: 'Identify' },
      });
    }

    await sleep(300);
  }
}

// Refresh a base game's official DLC list while keeping any lazily-resolved
// names already cached in the stored copy (names come from the /dlc endpoint).
function mergeDlcNames(storedJson, freshIds) {
  let cached = [];
  try { cached = JSON.parse(storedJson || '[]'); } catch { /* rebuild below */ }
  const byId = new Map(cached.map((d) => [String(d.id), d]));
  return (freshIds || []).map((id) => {
    const c = byId.get(String(id));
    return { id: String(id), name: c?.name || null, ...(c?.gone ? { gone: true } : {}) };
  });
}

// Adopt library entries into known DLC identities. Keyed providers (RAWG/IGDB)
// can't classify DLC, so a DLC package matched through them gets stamped
// kind='game' and never groups under its base game. But once a base game's
// official DLC list has resolved names, we KNOW the exact Steam appid for each
// DLC by name — so any non-Steam matched row whose title clearly IS one of
// those official DLC re-identifies as that Steam DLC app (high-precision:
// matcher scoring against the official name, with and without the base title).
export async function adoptDlcIdentities(db, providers) {
  const steam = providers.find((p) => p.name === 'steam' && p.enrich);
  if (!steam) return;
  const bases = db
    .prepare(
      "SELECT id, provider_id, meta_title, meta_dlc FROM games WHERE status = 'matched' AND provider = 'steam' AND meta_kind = 'game' AND meta_dlc IS NOT NULL AND meta_dlc != '[]'"
    )
    .all();
  if (!bases.length) return;
  const rows = db
    .prepare(
      "SELECT id, clean_name, hint_year, raw_name FROM games WHERE status = 'matched' AND provider != 'steam' AND (meta_kind IS NULL OR meta_kind = 'game') AND matched_manually != 1"
    )
    .all();
  if (!rows.length) return;
  const apply = db.prepare(`
    UPDATE games SET provider = 'steam', provider_id = @pid,
      meta_kind = 'dlc', meta_parent_id = @parent_id, meta_parent_title = @parent_title,
      meta_title = @title, meta_year = COALESCE(@year, meta_year),
      meta_cover = COALESCE(@cover, meta_cover), meta_hero = COALESCE(@hero, meta_hero),
      meta_summary = COALESCE(@summary, meta_summary), meta_about = COALESCE(@about, meta_about),
      meta_released = COALESCE(@released, meta_released),
      meta_media = COALESCE(@media, meta_media), meta_compat = COALESCE(@compat, meta_compat),
      meta_price = @price, meta_dlc = '[]',
      updated_at = datetime('now')
    WHERE id = @id
  `);
  const taken = new Set();
  for (const b of bases) {
    let list = [];
    try { list = JSON.parse(b.meta_dlc); } catch { continue; }
    for (const d of list) {
      if (!d.name || d.gone) continue;
      for (const r of rows) {
        if (taken.has(r.id)) continue;
        const score = Math.max(
          scoreCandidate(r.clean_name, r.hint_year, { title: d.name, year: null }),
          scoreCandidate(r.clean_name, r.hint_year, { title: `${b.meta_title} ${d.name}`, year: null })
        );
        if (score < 0.88) continue;
        taken.add(r.id);
        let extra = {};
        try { extra = await steam.enrich(d.id); } catch { /* metadata fills in later via backfill */ }
        apply.run({
          id: r.id,
          pid: String(d.id),
          parent_id: String(b.provider_id),
          parent_title: b.meta_title,
          title: d.name,
          year: extra.year ?? null,
          cover: extra.cover || null,
          hero: extra.hero || null,
          summary: extra.summary || null,
          about: extra.about || null,
          released: extra.released || null,
          media: extra.media ? JSON.stringify(extra.media) : null,
          compat: extra.compat ? JSON.stringify(extra.compat) : null,
          price: extra.price ? JSON.stringify(extra.price) : '{}',
        });
        logEvent(db, 'info', 'matcher', `Recognized “${r.raw_name}” as DLC of “${b.meta_title}” → “${d.name}”`);
        await sleep(300);
      }
    }
  }
}

// A DLC-typed package big enough to hold the whole game almost always IS the
// whole game: scene "<Game> - <Expansion>" releases bundle the base game with
// the expansion (a real DLC-only package is a fraction of the size). Split the
// identity in two: the physical row BECOMES the base game (that's what you
// download, install and play), and a synthetic child row keeps the DLC's own
// identity — its own page, checked under the game, grouped with future DLC.
// Child rows carry '::dlc/' in rel_path, have no files of their own, and are
// pruned by the scanner together with their physical parent row.
const BUNDLE_MIN_BYTES = 3 * 1024 ** 3;

export async function resolveBundles(db, providers) {
  const steam = providers.find((p) => p.name === 'steam' && p.enrich);
  if (!steam) return;
  const rows = db
    .prepare(
      "SELECT * FROM games WHERE status = 'matched' AND provider = 'steam' AND meta_kind = 'dlc' AND matched_manually != 1 AND meta_parent_id IS NOT NULL AND size_bytes >= ? AND rel_path NOT LIKE '%::%'"
    )
    .all(BUNDLE_MIN_BYTES);
  if (!rows.length) return;
  const insChild = db.prepare(`
    INSERT OR IGNORE INTO games (rel_path, raw_name, clean_name, hint_year, payload_type, size_bytes,
      status, confidence, provider, provider_id, meta_title, meta_year, meta_cover, meta_summary,
      meta_genres, meta_hero, meta_ratings, meta_media, meta_compat, meta_price, meta_about,
      meta_released, meta_tags, meta_kind, meta_parent_id, meta_parent_title, meta_dlc, matched_manually)
    VALUES (@rel_path, @raw_name, @clean_name, @hint_year, 'dlc-included', 0,
      'matched', @confidence, 'steam', @provider_id, @meta_title, @meta_year, @meta_cover, @meta_summary,
      @meta_genres, @meta_hero, @meta_ratings, @meta_media, @meta_compat, @meta_price, @meta_about,
      @meta_released, @meta_tags, 'dlc', @meta_parent_id, @meta_parent_title, '[]', 0)
  `);
  const flip = db.prepare(`
    UPDATE games SET provider_id = @pid, meta_title = @title, meta_kind = 'game',
      meta_parent_id = NULL, meta_parent_title = NULL,
      meta_year = @year, meta_cover = @cover, meta_hero = @hero, meta_summary = @summary,
      meta_about = @about, meta_released = @released, meta_genres = @genres, meta_ratings = @ratings,
      meta_media = @media, meta_compat = @compat, meta_price = @price, meta_tags = @tags, meta_dlc = @dlc,
      updated_at = datetime('now')
    WHERE id = @id
  `);
  for (const r of rows) {
    let extra;
    try { extra = await steam.enrich(r.meta_parent_id); } catch { continue; } // transient — retried next cycle
    // parent app unusable (delisted / empty response) — leave the row as-is
    if (!extra || (!extra.about && !extra.hero && !extra.released)) continue;
    insChild.run({
      rel_path: `${r.rel_path}::dlc/${r.provider_id}`,
      raw_name: r.raw_name,
      clean_name: r.clean_name,
      hint_year: r.hint_year,
      confidence: r.confidence,
      provider_id: r.provider_id,
      meta_title: r.meta_title,
      meta_year: r.meta_year,
      meta_cover: r.meta_cover,
      meta_summary: r.meta_summary,
      meta_genres: r.meta_genres,
      meta_hero: r.meta_hero,
      meta_ratings: r.meta_ratings,
      meta_media: r.meta_media,
      meta_compat: r.meta_compat,
      meta_price: r.meta_price,
      meta_about: r.meta_about,
      meta_released: r.meta_released,
      meta_tags: r.meta_tags,
      meta_parent_id: r.meta_parent_id,
      meta_parent_title: r.meta_parent_title,
    });
    flip.run({
      id: r.id,
      pid: String(r.meta_parent_id),
      title: r.meta_parent_title || r.meta_title,
      year: extra.year ?? r.meta_year,
      cover: extra.cover || null,
      hero: extra.hero || null,
      summary: extra.summary || null,
      about: extra.about || null,
      released: extra.released || null,
      genres: extra.genres || r.meta_genres,
      ratings: extra.ratings && Object.keys(extra.ratings).length ? JSON.stringify(extra.ratings) : null,
      media: JSON.stringify(extra.media || {}),
      compat: JSON.stringify(extra.compat || {}),
      price: JSON.stringify(extra.price || {}),
      tags: JSON.stringify(extra.tags || []),
      // official list with the bundled DLC's name pre-filled from the old row
      dlc: JSON.stringify(mergeDlcNames(JSON.stringify([{ id: r.provider_id, name: r.meta_title }]), extra.dlc)),
    });
    logEvent(
      db, 'info', 'matcher',
      `Recognized “${r.raw_name}” as a bundle — split into “${r.meta_parent_title || 'base game'}” + DLC “${r.meta_title}”`
    );
    await sleep(300);
  }
}

// Older matches predate trailers/screenshots/compat — enrich them in small
// batches during each scan cycle until everyone has the full metadata set.
export async function backfillMedia(db, providers) {
  const rows = db
    .prepare(
      `SELECT id, provider, provider_id, raw_name, meta_dlc FROM games
       WHERE status = 'matched' AND provider_id != ''
         AND (meta_media IS NULL OR meta_media = '' OR meta_compat IS NULL OR meta_compat = ''
              OR meta_price IS NULL OR meta_price = '' OR meta_about IS NULL OR meta_released IS NULL
              OR meta_tags IS NULL OR meta_kind IS NULL)
       LIMIT 15`
    )
    .all();
  if (rows.length === 0) return;
  // COALESCE(@hero, meta_hero) UPGRADES the hero: pre-0.9 matches stored the
  // small header_image capsule; re-enrich now yields the hi-res library_hero.
  const upd = db.prepare(
    `UPDATE games SET meta_media = @media, meta_compat = @compat, meta_price = @price,
       meta_about = @about, meta_released = @released,
       meta_hero = COALESCE(@hero, meta_hero),
       meta_ratings = COALESCE(meta_ratings, @ratings),
       meta_tags = COALESCE(meta_tags, @tags),
       meta_kind = @kind, meta_parent_id = @parent_id, meta_parent_title = @parent_title,
       meta_dlc = COALESCE(@dlc, meta_dlc),
       updated_at = datetime('now')
     WHERE id = @id`
  );
  for (const row of rows) {
    const prov = providers.find((p) => p.name === row.provider && p.enrich);
    if (!prov) {
      // 'game' is the checked-sentinel for kind — providers without enrich
      // can't classify, and we must not re-select this row forever
      upd.run({ id: row.id, media: '{}', compat: '{}', price: '{}', about: '', released: '', hero: null, ratings: null, tags: '[]', kind: 'game', parent_id: null, parent_title: null, dlc: '[]' });
      continue;
    }
    try {
      const extra = await prov.enrich(row.provider_id);
      upd.run({
        id: row.id,
        media: JSON.stringify(extra.media || {}), // '{}' marks "checked, none" — no retry loop
        compat: JSON.stringify(extra.compat || {}),
        price: JSON.stringify(extra.price || {}), // '{}' = checked, no store price
        about: extra.about || '', // '' = checked, no About text (non-null → not re-selected)
        released: extra.released || '', // '' = checked, no release date
        hero: extra.hero || null,
        ratings: extra.ratings && Object.keys(extra.ratings).length ? JSON.stringify(extra.ratings) : null,
        tags: JSON.stringify(extra.tags || []),
        kind: extra.kind || 'game', // 'game' = checked (never re-selected)
        parent_id: extra.parent?.id || null,
        parent_title: extra.parent?.title || null,
        dlc: JSON.stringify(mergeDlcNames(row.meta_dlc, extra.dlc)),
      });
    } catch {
      /* transient — retried next scan */
    }
    await sleep(300);
  }
  console.log(`[matcher] backfilled media/compat/price for ${rows.length} game(s)`);
}
