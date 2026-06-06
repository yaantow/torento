const config = require('../../config');
const x1337 = require('./providers/x1337');
const yts = require('./providers/yts');
const tpb = require('./providers/tpb');
const tgx = require('./providers/tgx');
const tmdb = require('../metadata/tmdb');
const matcher = require('../metadata/matcher');

const PROVIDERS = { x1337, yts, tpb, tgx };

function getEnabledProviders(sources) {
  if (!sources || sources === 'all') {
    return Object.entries(PROVIDERS).filter(([key]) => config.sources[key]?.enabled);
  }
  const requested = sources.split(',');
  return Object.entries(PROVIDERS).filter(([key]) => requested.includes(key) && config.sources[key]?.enabled);
}

async function search(query, sources) {
  const providers = getEnabledProviders(sources);
  if (providers.length === 0) throw new Error('No search providers enabled');

  const [settled, metadataItems] = await Promise.all([
    Promise.allSettled(
      providers.map(async ([name, provider]) => {
        const results = await provider.search(query);
        return results.map((r) => ({ ...r, provider: name }));
      })
    ),
    tmdb.searchMulti(query).then((items) => items.map(tmdb.normalize)).catch(() => []),
  ]);

  const allTorrents = [];
  const errors = [];

  for (const [i, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      allTorrents.push(...result.value);
    } else {
      const [name] = providers[i];
      errors.push(`${name}: ${result.reason?.message || result.reason}`);
      console.error(`[search] ${name} failed:`, result.reason?.message);
    }
  }

  const movies = matcher.matchTorrentsToMetadata(allTorrents, metadataItems);

  for (const m of movies) {
    if (m.metadata && !m.metadata.poster) {
      m.metadata.poster = null;
    }
  }

  return { movies, errors };
}

async function getMagnet(provider, torrentUrl) {
  const prov = PROVIDERS[provider];
  if (!prov) throw new Error(`Unknown provider: ${provider}`);
  if (typeof prov.getMagnet !== 'function') throw new Error(`${provider} doesn't support magnet fetching`);
  return prov.getMagnet(torrentUrl);
}

module.exports = { search, getMagnet, PROVIDERS };
