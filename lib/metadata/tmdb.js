const config = require('../../config');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

function getApiKey() {
  return process.env.TMDB_API_KEY || '';
}

async function searchMovies(query) {
  const key = getApiKey();
  if (!key) return [];
  const url = `${TMDB_BASE}/search/movie?query=${encodeURIComponent(query)}&language=en-US&page=1`;
  return fetchTMDB(url, key);
}

async function searchTV(query) {
  const key = getApiKey();
  if (!key) return [];
  const url = `${TMDB_BASE}/search/tv?query=${encodeURIComponent(query)}&language=en-US&page=1`;
  return fetchTMDB(url, key);
}

async function searchMulti(query) {
  const key = getApiKey();
  if (!key) return [];
  const url = `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}&language=en-US&page=1`;
  const results = await fetchTMDB(url, key);
  return results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
}

async function fetchTMDB(url, key) {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('TMDB API key invalid');
      throw new Error(`TMDB returned ${resp.status}`);
    }
    const data = await resp.json();
    return data.results || [];
  } catch (err) {
    if (err.message.includes('fetch')) throw err;
    console.error('[tmdb]', err.message);
    return [];
  }
}

function normalize(item) {
  if (item.media_type === 'tv' || item.first_air_date) {
    return {
      id: `tv-${item.id}`,
      tmdbId: item.id,
      type: 'tv',
      title: item.name || item.title,
      year: (item.first_air_date || '').substring(0, 4),
      poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : null,
      backdrop: item.backdrop_path ? `${IMAGE_BASE}${item.backdrop_path}` : null,
      overview: item.overview || '',
      rating: item.vote_average || 0,
      originalTitle: item.original_name || item.original_title || '',
    };
  }

  return {
    id: `movie-${item.id}`,
    tmdbId: item.id,
    type: 'movie',
    title: item.title || item.name,
    year: (item.release_date || item.first_air_date || '').substring(0, 4),
    poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMAGE_BASE}${item.backdrop_path}` : null,
    overview: item.overview || '',
    rating: item.vote_average || 0,
    originalTitle: item.original_title || item.original_name || '',
  };
}

module.exports = { searchMovies, searchTV, searchMulti, normalize, IMAGE_BASE };
