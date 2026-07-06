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
      const res = await fetch(
        `https://api.rawg.io/api/games/${id}?key=${encodeURIComponent(apiKey)}`
      );
      if (!res.ok) throw new Error(`RAWG details failed: ${res.status}`);
      const d = await res.json();
      const ratings = {};
      if (d.rating) ratings.rawg = { rating: d.rating, count: d.ratings_count || 0 };
      if (d.metacritic) ratings.metacritic = { score: d.metacritic };
      return {
        year: d.released ? parseInt(d.released.slice(0, 4), 10) : null,
        summary: d.description_raw ? d.description_raw.slice(0, 800) : null,
        genres: (d.genres || []).map((x) => x.name).join(', ') || null,
        cover: null, // keep whatever the search result provided
        hero: d.background_image || null,
        ratings,
      };
    },
  };
}
