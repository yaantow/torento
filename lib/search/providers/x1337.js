const config = require('../../../config');
const TRACKERS = require('../trackers');

async function search(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://${config.sources.x1337.domain}/search/${encoded}/1/`;

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0' },
    signal: AbortSignal.timeout(config.sources.x1337.timeout),
  });
  if (!response.ok) throw new Error(`1337x returned ${response.status}`);

  const html = await response.text();
  const results = [];
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  $('table.table-list tbody tr').each((i, el) => {
    if (i >= 30) return false;
    const nameEl = $(el).find('td.name a').last();
    if (!nameEl.length) return;

    const title = nameEl.text().trim();
    const href = nameEl.attr('href');
    const seeds = parseInt($(el).find('td.seeds').text().trim(), 10) || 0;
    const leeches = parseInt($(el).find('td.leeches').text().trim(), 10) || 0;
    const sizeText = $(el).find('td.size').text().replace(/<[^>]*>/g, '').trim();

    if (!title || !href) return;

    const torrentUrl = `https://${config.sources.x1337.domain}${href}`;
    results.push({
      title,
      size: sizeText,
      seeds,
      leeches,
      torrentUrl,
      provider: '1337x',
    });
  });

  return results;
}

async function getMagnet(torrentUrl) {
  const response = await fetch(torrentUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0' },
    signal: AbortSignal.timeout(config.sources.x1337.timeout),
  });
  if (!response.ok) throw new Error(`1337x returned ${response.status}`);

  const html = await response.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  const magnetLink = $('a[href^="magnet:"]').first().attr('href');
  if (!magnetLink) throw new Error('Magnet link not found on 1337x page');

  if (!magnetLink.includes('tr=')) {
    const trackers = TRACKERS.map(t => 'tr=' + encodeURIComponent(t)).join('&');
    return magnetLink + (magnetLink.includes('?') ? '&' : '?') + trackers;
  }
  return magnetLink;
}

module.exports = { search, getMagnet };
