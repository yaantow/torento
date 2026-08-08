const config = require('../../../config');
const TRACKERS = require('../trackers');
const { fetchResilient } = require('../http');

function parsePage(html, domain) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const results = [];

  $('.tgxtable .tgxtablerow').each((i, el) => {
    const nameEl = $(el).find('.tgxtablecell.clickable-row a[href^="torrent/"]').first();
    if (!nameEl.length) return;

    const title = nameEl.text().trim();
    const href = nameEl.attr('href');
    const seeds = parseInt($(el).find('font[color="green"]').first().text().trim(), 10) || 0;
    const leeches = parseInt($(el).find('font[color="#ff0000"]').first().text().trim(), 10) || 0;
    const sizeEl = $(el).find('.badge-secondary').first();
    const sizeText = sizeEl.length ? sizeEl.text().trim() : 'Unknown';

    if (!title || !href) return;

    const torrentUrl = href.startsWith('http') ? href : `https://${domain}/${href}`;
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

async function searchDomain(query, domain) {
  const encoded = encodeURIComponent(query);
  const maxPages = config.sources.tgx.maxPages || 1;
  const results = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://${domain}/torrents.php?search=${encoded}&sort=seeders&order=desc&page=${page}`;
    const response = await fetchResilient(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.sources.tgx.timeout),
    });
    if (!response.ok) {
      if (page === 1) throw new Error(`TorrentGalaxy returned ${response.status}`);
      break;
    }

    const html = await response.text();
    const pageResults = parsePage(html, domain);
    if (pageResults.length === 0) break;

    results.push(...pageResults);
  }

  return results;
}

async function search(query) {
  const domains = config.sources.tgx.domains;
  let lastError;

  for (const domain of domains) {
    try {
      return await searchDomain(query, domain);
    } catch (err) {
      lastError = err;
      console.error(`[tgx] domain ${domain} failed:`, err.message);
    }
  }

  throw lastError || new Error('TorrentGalaxy: all mirror domains failed');
}

async function getMagnet(torrentUrl) {
  const response = await fetchResilient(torrentUrl, {
    redirect: 'follow',
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
