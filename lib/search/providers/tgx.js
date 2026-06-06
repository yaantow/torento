const config = require('../../../config');
const TRACKERS = require('../trackers');

async function search(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://${config.sources.tgx.domain}/torrents.php?search=${encoded}&sort=seeders&order=desc`;

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0' },
    signal: AbortSignal.timeout(config.sources.tgx.timeout),
  });
  if (!response.ok) throw new Error(`TorrentGalaxy returned ${response.status}`);

  const html = await response.text();
  const results = [];
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  $('.tgxtable .tgxtablerow').each((i, el) => {
    if (i >= 30) return false;
    const nameEl = $(el).find('.tgxtablecell.clickable-row a[href^="torrent/"]').first();
    if (!nameEl.length) return;

    const title = nameEl.text().trim();
    const href = nameEl.attr('href');
    const seeds = parseInt($(el).find('font[color="green"]').first().text().trim(), 10) || 0;
    const leeches = parseInt($(el).find('font[color="#ff0000"]').first().text().trim(), 10) || 0;
    const sizeEl = $(el).find('.badge-secondary').first();
    const sizeText = sizeEl.length ? sizeEl.text().trim() : 'Unknown';

    if (!title || !href) return;

    const torrentUrl = href.startsWith('http') ? href : `https://${config.sources.tgx.domain}/${href}`;
    results.push({
      title,
      size: sizeText,
      seeds,
      leeches,
      torrentUrl,
      provider: 'TorrentGalaxy',
    });
  });

  return results;
}

async function getMagnet(torrentUrl) {
  const response = await fetch(torrentUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0' },
    signal: AbortSignal.timeout(config.sources.tgx.timeout),
  });
  if (!response.ok) throw new Error(`TorrentGalaxy returned ${response.status}`);

  const html = await response.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  const magnetLink = $('a[href^="magnet:"]').first().attr('href');
  if (!magnetLink) throw new Error('Magnet link not found');

  if (!magnetLink.includes('tr=')) {
    const trackers = TRACKERS.map(t => 'tr=' + encodeURIComponent(t)).join('&');
    return magnetLink + (magnetLink.includes('?') ? '&' : '?') + trackers;
  }
  return magnetLink;
}

module.exports = { search, getMagnet };
