// IGDB metadata provider — uses Twitch app credentials
// (https://api-docs.igdb.com/#getting-started)
export function createIgdbProvider(clientId, clientSecret) {
  let token = null;
  let tokenExpiry = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiry - 60_000) return token;
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`IGDB token request failed: ${res.status}`);
    const data = await res.json();
    token = data.access_token;
    tokenExpiry = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function igdbQuery(body) {
    const tok = await getToken();
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${tok}`,
        Accept: 'application/json',
      },
      body,
    });
    if (!res.ok) throw new Error(`IGDB query failed: ${res.status}`);
    return res.json();
  }

  return {
    name: 'igdb',

    async enrich(id) {
      const data = await igdbQuery(
        `fields rating, rating_count, aggregated_rating, aggregated_rating_count, summary, artworks.url, screenshots.url; where id = ${Number(id)};`
      );
      const g = data?.[0];
      if (!g) return {};
      const ratings = {};
      if (g.rating) ratings.igdb = { user: Math.round(g.rating), userCount: g.rating_count || 0 };
      if (g.aggregated_rating) {
        ratings.igdb = {
          ...(ratings.igdb || {}),
          critic: Math.round(g.aggregated_rating),
          criticCount: g.aggregated_rating_count || 0,
        };
      }
      const art = g.artworks?.[0]?.url || g.screenshots?.[0]?.url || null;
      return {
        summary: g.summary || null,
        hero: art ? 'https:' + art.replace('t_thumb', 't_screenshot_big') : null,
        ratings,
      };
    },

    async search(query) {
      const tok = await getToken();
      const body = `search "${query.replace(/"/g, '')}"; fields name, first_release_date, summary, cover.url, genres.name; where category = (0, 4, 8, 9, 10, 11); limit 10;`;
      const res = await fetch('https://api.igdb.com/v4/games', {
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${tok}`,
          Accept: 'application/json',
        },
        body,
      });
      if (!res.ok) throw new Error(`IGDB search failed: ${res.status}`);
      const data = await res.json();
      return data.map((g) => ({
        provider: 'igdb',
        providerId: String(g.id),
        title: g.name,
        year: g.first_release_date
          ? new Date(g.first_release_date * 1000).getUTCFullYear()
          : null,
        cover: g.cover?.url
          ? 'https:' + g.cover.url.replace('t_thumb', 't_cover_big')
          : null,
        summary: g.summary || null,
        genres: (g.genres || []).map((x) => x.name).join(', '),
      }));
    },
  };
}
