const config = require('../../../config');
const TRACKERS = require('../trackers');
const { fetchResilient } = require('../http');

function formatSize(bytes) {
  if (!bytes || bytes === '0') return 'Unknown';
  const num = parseInt(bytes, 10);
  if (num >= 1073741824) return (num / 1073741824).toFixed(1) + ' GB';
  if (num >= 1048576) return (num / 1048576).toFixed(0) + ' MB';
  if (num >= 1024) return (num / 1024).toFixed(0) + ' KB';
  return num + ' B';
}

async function search(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://apibay.org/q.php?q=${encoded}&cat=`;

  const response = await fetchResilient(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.sources.tpb.timeout),
  });
  if (!response.ok) throw new Error(`TPB returned ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data) || data[0]?.name === 'No results returned') return [];

  const results = [];
  for (const item of data) {
    if (!item || item.name === 'No results returned') continue;
    const category = parseInt(item.category, 10);
    if (category >= 500) continue;

    const title = item.name;
    const hash = item.info_hash;
    if (!hash) continue;

    const trackers = TRACKERS.map(t => 'tr=' + encodeURIComponent(t)).join('&');
    const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&${trackers}`;
    const seeds = parseInt(item.seeders, 10) || 0;
    const leeches = parseInt(item.leechers, 10) || 0;
    const sizeText = formatSize(item.size);

    results.push({
      title,
      size: sizeText,
      sizeBytes: parseInt(item.size, 10) || 0,
      seeds,
      leeches,
      magnet,
      provider: 'TPB',
    });
  }

  return results;
}

module.exports = { search };
