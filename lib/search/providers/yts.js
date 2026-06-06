const config = require('../../../config');
const TRACKERS = require('../trackers');

async function search(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://yts.lt/api/v2/list_movies.json?query_term=${encoded}&limit=50&sort_by=seeds&order_by=desc`;

  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.sources.yts.timeout),
  });
  if (!response.ok) throw new Error(`YTS returned ${response.status}`);

  const data = await response.json();
  if (data.status !== 'ok' || !data.data.movies) return [];

  const results = [];
  for (const movie of data.data.movies) {
    for (const tor of movie.torrents || []) {
      const title = `${movie.title} (${movie.year}) ${tor.quality} YTS`;
      const magnet = buildMagnet(tor.hash, title);
      results.push({
        title,
        size: tor.size,
        sizeBytes: tor.size_bytes,
        seeds: tor.seeds,
        leeches: tor.peers,
        magnet,
        torrentUrl: tor.url,
        provider: 'YTS',
        poster: movie.medium_cover_image,
      });
    }
  }

  return results;
}

function buildMagnet(hash, title) {
  const trackers = TRACKERS.map(t => 'tr=' + encodeURIComponent(t)).join('&');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&${trackers}`;
}

module.exports = { search };
