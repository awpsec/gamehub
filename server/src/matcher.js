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

// Older matches predate trailers/screenshots/compat — enrich them in small
// batches during each scan cycle until everyone has the full metadata set.
export async function backfillMedia(db, providers) {
  const rows = db
    .prepare(
      `SELECT id, provider, provider_id, raw_name FROM games
       WHERE status = 'matched' AND provider_id != ''
         AND (meta_media IS NULL OR meta_media = '' OR meta_compat IS NULL OR meta_compat = ''
              OR meta_price IS NULL OR meta_price = '' OR meta_about IS NULL OR meta_released IS NULL
              OR meta_tags IS NULL)
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
       updated_at = datetime('now')
     WHERE id = @id`
  );
  for (const row of rows) {
    const prov = providers.find((p) => p.name === row.provider && p.enrich);
    if (!prov) {
      upd.run({ id: row.id, media: '{}', compat: '{}', price: '{}', about: '', released: '', hero: null, ratings: null, tags: '[]' });
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
      });
    } catch {
      /* transient — retried next scan */
    }
    await sleep(300);
  }
  console.log(`[matcher] backfilled media/compat/price for ${rows.length} game(s)`);
}
