// Steam storefront provider — public endpoints, NO API key required.
// Enabled out of the box so Gamehub works with zero configuration.
//
// search:  https://store.steampowered.com/api/storesearch/  (name + appid)
// enrich:  https://store.steampowered.com/api/appdetails    (year, summary, genres, metacritic, wide art)
//          https://store.steampowered.com/appreviews        (Steam user review score)
// covers:  official portrait art from the Steam CDN by appid
import { searchTerm } from '../namecleaner.js';

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

// Steam's search returns soundtracks, demos, benchmark tools and cosmetic DLC
// tagged as type "app" — indistinguishable by type — which floods the manual
// match picker. Drop the ones that carry a tell-tale word (a real base game
// never does). Cosmetic DLC without such a word still scores below the actual
// game and sinks to the bottom of the ranked list.
const NON_GAME_NAME = /\b(soundtrack|ost|demo|benchmark|playtest|artbook|art book|season pass|pro pack|dedicated server|sdk)\b/i;

// Steam requirement blobs are HTML ("<strong>Minimum:</strong><ul><li>OS: …") —
// flatten to plain text lines for safe, structured rendering
function reqLines(html) {
  if (!html || typeof html !== 'string') return [];
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(minimum|recommended):?$/i.test(l));
}

// Steam "popular tags" (Zombies, Survival, City Builder, Roguelike, Base Building…)
// aren't in the official appdetails API — pull them from SteamSpy (free, keyless).
// Drop generic feature/perspective/mode tags that make poor browse filters (they're
// on nearly everything); keep the thematic/sub-genre ones. Throttled to SteamSpy's
// ~1 request/second so a backfill never gets rate-limited.
const TAG_STOPWORDS = new Set([
  'singleplayer', 'multiplayer', 'co-op', 'online co-op', 'local co-op', 'local multiplayer', 'lan co-op',
  'pvp', 'pve', 'online pvp', 'local pvp', 'split screen', 'cross-platform multiplayer', '4 player local',
  'great soundtrack', 'controller', 'full controller support', 'steam achievements', 'steam cloud',
  'steam trading cards', 'steam workshop', 'includes level editor', 'stats', 'captions available', 'remote play together',
  '2d', '3d', '2.5d', 'first-person', 'third person', 'third-person', 'top-down', 'isometric', 'side scroller', 'vr',
  'early access', 'free to play',
]);
let lastTagFetch = 0;
async function fetchSteamTags(appid) {
  const wait = 1100 - (Date.now() - lastTagFetch);
  if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  lastTagFetch = Date.now();
  try {
    const r = await fetch(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`);
    if (!r.ok) return [];
    const t = (await r.json())?.tags;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return []; // SteamSpy returns {} when it has none
    // keys come back roughly in popularity order — keep the top thematic ones
    return Object.keys(t).filter((name) => name && !TAG_STOPWORDS.has(name.toLowerCase())).slice(0, 12);
  } catch {
    return []; // best-effort; '[]' marks "checked" so it isn't retried forever
  }
}

export function createSteamProvider() {
  return {
    name: 'steam',

    async search(query) {
      const fetchItems = async (term) => {
        if (!term) return [];
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Steam search failed: ${res.status}`);
        const data = await res.json();
        return (data.items || [])
          .filter((i) => !i.type || i.type === 'app')
          .filter((i) => i.name && !NON_GAME_NAME.test(i.name));
      };

      // storesearch is punctuation-sensitive — query the sanitized term.
      const term = searchTerm(query);
      let items = await fetchItems(term);

      // Nothing back? A leftover releaser handle or version tail is the usual
      // culprit ("pragmata voices38" → 0 hits, "pragmata" → PRAGMATA). Peel the
      // trailing token off and retry, up to twice, until something turns up.
      const toks = term.split(' ');
      for (let drops = 0; items.length === 0 && toks.length > 1 && drops < 2; drops++) {
        toks.pop();
        items = await fetchItems(toks.join(' '));
      }

      return items.map((i) => ({
        provider: 'steam',
        providerId: String(i.id),
        title: i.name,
        year: null, // filled by enrich() on match to keep request volume low
        cover: `${CDN}/${i.id}/library_600x900.jpg`,
        summary: null,
        genres: null,
      }));
    },

    // cheap single-field lookup (name only) — used to lazily resolve the
    // titles of a base game's official DLC list without full enrichment
    async appName(appid) {
      const res = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english&filters=basic`
      );
      if (!res.ok) throw new Error(`Steam appdetails failed: ${res.status}`);
      const d = (await res.json())?.[appid];
      // success:false = delisted/region-locked — report null so the caller
      // caches the miss and never asks again
      return d?.success ? d.data?.name || null : null;
    },

    // a couple of extra requests per *matched* game (not per candidate)
    async enrich(appid) {
      const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`);
      if (!res.ok) throw new Error(`Steam appdetails failed: ${res.status}`);
      const body = await res.json();
      const d = body?.[appid]?.data;
      if (!d) return {};

      // portrait art doesn't exist for some older titles — fall back to the banner
      let cover = `${CDN}/${appid}/library_600x900.jpg`;
      try {
        const head = await fetch(cover, { method: 'HEAD' });
        if (!head.ok) cover = d.header_image || null;
      } catch {
        cover = d.header_image || null;
      }

      // Hero banner: prefer the big library hero (~1920x620) — the small
      // header_image capsule (460x215) looks blurry stretched across a wide
      // banner. Fall back to it only when the hi-res asset is absent.
      let hero = `${CDN}/${appid}/library_hero.jpg`;
      try {
        const hh = await fetch(hero, { method: 'HEAD' });
        if (!hh.ok) hero = d.header_image || null;
      } catch {
        hero = d.header_image || null;
      }

      const ratings = {};
      if (d.metacritic?.score) ratings.metacritic = { score: d.metacritic.score };
      try {
        const r = await fetch(
          `https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=0&language=all&purchase_type=all`
        );
        if (r.ok) {
          const q = (await r.json())?.query_summary;
          if (q?.total_reviews > 0) {
            ratings.steam = {
              percent: Math.round((100 * q.total_positive) / q.total_reviews),
              count: q.total_reviews,
              desc: q.review_score_desc || '',
            };
          }
        }
      } catch {
        /* reviews are best-effort */
      }

      const yearMatch = (d.release_date?.date || '').match(/\d{4}/);
      const movie = d.movies?.[0];
      const media = {
        screenshots: (d.screenshots || []).slice(0, 8).map((s) => s.path_full).filter(Boolean),
        // Steam serves trailers as HLS/DASH manifests now (legacy progressive
        // mp4/webm URLs are gone) — clients play the HLS master via hls.js
        trailer: movie
          ? movie.hls_h264 || movie.webm?.max || movie.mp4?.max || movie.dash_h264 || null
          : null,
        trailerThumb: movie?.thumbnail || null,
      };

      // OS compatibility + hardware requirements
      const compat = {
        platforms: {
          windows: !!d.platforms?.windows,
          mac: !!d.platforms?.mac,
          linux: !!d.platforms?.linux,
        },
        requirements: {
          minimum: reqLines(d.pc_requirements?.minimum),
          recommended: reqLines(d.pc_requirements?.recommended),
        },
        proton: null,
      };
      // ProtonDB tier for Windows builds (Gamehub installs Windows packages even
      // when a native Linux build exists elsewhere). Cited for Linux clients.
      if (compat.platforms.windows) {
        try {
          const p = await fetch(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`);
          if (p.ok) {
            const pd = await p.json();
            if (pd?.tier) compat.proton = { tier: pd.tier, total: pd.total || 0 };
          }
        } catch { /* best-effort */ }
      }
      // Current Steam store price (USD). Free titles report is_free; unreleased
      // or region-locked ones simply have no price_overview → leave null.
      let price = null;
      if (d.is_free) {
        price = { isFree: true };
      } else if (d.price_overview) {
        const p = d.price_overview;
        price = {
          currency: p.currency,
          initial: p.initial, // cents, pre-discount
          final: p.final, // cents, current
          discountPercent: p.discount_percent || 0,
          initialFormatted: p.initial_formatted || '',
          finalFormatted: p.final_formatted || '',
        };
      }

      // granular Steam popular tags (SteamSpy) for tag-based browsing
      const tags = await fetchSteamTags(appid);

      // DLC identity — search results can't tell DLC from games (both type
      // "app"), but appdetails is authoritative: type === 'dlc' plus a
      // `fullgame` pointer at the base game. Base games carry the reverse
      // edge: `dlc` = official appid list, which powers the DLC section.
      const kind = d.type === 'dlc' ? 'dlc' : 'game';
      const parent = d.type === 'dlc' && d.fullgame?.appid
        ? { id: String(d.fullgame.appid), title: d.fullgame.name || null }
        : null;
      const dlcIds = Array.isArray(d.dlc) ? d.dlc.slice(0, 100).map((x) => String(x)) : [];

      return {
        kind,
        parent,
        dlc: dlcIds,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        // full release date display string ("Mar 26, 2026", "Q1 2027", "Coming soon")
        // — shown in details; parsed client-side for the "New Release" window
        released: d.release_date?.date || null,
        summary: d.short_description || null,
        tags,
        // full "About This Game" (rich HTML w/ headings, images, lists) — much
        // deeper than short_description; rendered sanitized in an About section
        about: d.about_the_game || null,
        genres: (d.genres || []).map((g) => g.description).join(', ') || null,
        cover,
        hero,
        ratings,
        media,
        compat,
        price,
      };
    },
  };
}
