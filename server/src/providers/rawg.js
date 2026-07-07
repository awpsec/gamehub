// RAWG.io metadata provider — free API key at https://rawg.io/apidocs
export function createRawgProvider(apiKey) {
  return {
    name: 'rawg',

    async search(query) {
      const url = `https://api.rawg.io/api/games?key=${encodeURIComponent(apiKey)}&search=${encodeURIComponent(query)}&page_size=10`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`RAWG search failed: ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((g) => ({
        provider: 'rawg',
        providerId: String(g.id),
        title: g.name,
        year: g.released ? parseInt(g.released.slice(0, 4), 10) : null,
        cover: g.background_image || null,
        summary: null, // RAWG search results don't include descriptions
        genres: (g.genres || []).map((x) => x.name).join(', '),
      }));
    },

    async enrich(id) {
      const key = encodeURIComponent(apiKey);
      const base = `https://api.rawg.io/api/games/${id}`;
      const res = await fetch(`${base}?key=${key}`);
      if (!res.ok) throw new Error(`RAWG details failed: ${res.status}`);
      const d = await res.json();

      const ratings = {};
      if (d.rating) ratings.rawg = { rating: d.rating, count: d.ratings_count || 0 };
      if (d.metacritic) ratings.metacritic = { score: d.metacritic };

      // Screenshots and trailers live on separate RAWG endpoints — fetch both,
      // best-effort so a game with neither still matches. This is what fills in
      // media for RAWG-only titles (e.g. ones Steam has delisted).
      let screenshots = [];
      try {
        const s = await fetch(`${base}/screenshots?key=${key}`);
        if (s.ok) {
          screenshots = ((await s.json()).results || [])
            .map((x) => x.image)
            .filter(Boolean)
            .slice(0, 8);
        }
      } catch {
        /* best-effort */
      }

      let trailer = null;
      let trailerThumb = null;
      try {
        const m = await fetch(`${base}/movies?key=${key}`);
        if (m.ok) {
          const mv = ((await m.json()).results || [])[0];
          if (mv?.data) {
            // data is resolution-keyed mp4 URLs ({ "480": …, "max": … });
            // prefer max, fall back to any URL present. Plays via the native
            // <video> path (RAWG trailers are mp4, not Steam's HLS).
            trailer = mv.data.max || mv.data['480'] || Object.values(mv.data).find((v) => typeof v === 'string') || null;
            trailerThumb = mv.preview || null;
          }
        }
      } catch {
        /* best-effort */
      }

      // RAWG has no portrait box art — background_image is a landscape shot. Use
      // it for the cover (the card contains wide art over a blurred fill) and,
      // when present, a second image for the hero banner.
      const art = d.background_image || null;

      // OS availability from RAWG's platform list (RAWG carries no PC spec sheet).
      const plat = (d.platforms || []).map((p) => (p.platform?.name || '').toLowerCase());
      const compat = {
        platforms: {
          windows: plat.some((n) => n.includes('pc') || n.includes('windows')),
          mac: plat.some((n) => n.includes('mac')),
          linux: plat.some((n) => n.includes('linux')),
        },
        requirements: { minimum: [], recommended: [] },
        proton: null,
      };

      return {
        year: d.released ? parseInt(d.released.slice(0, 4), 10) : null,
        released: d.released || null,
        summary: d.description_raw ? d.description_raw.slice(0, 800) : null,
        about: d.description || null, // RAWG's rich HTML description
        genres: (d.genres || []).map((x) => x.name).join(', ') || null,
        cover: art,
        hero: d.background_image_additional || art,
        ratings,
        media: { screenshots, trailer, trailerThumb },
        compat,
      };
    },
  };
}
