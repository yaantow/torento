const config = require('../../../config');
const TRACKERS = require('../trackers');
const { fetchResilient } = require('../http');

function parsePage(html, domain) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const results = [];

  $('table.table-list tbody tr').each((i, el) => {
    const nameEl = $(el).find('td.name a').last();
    if (!nameEl.length) return;

    const title = nameEl.text().trim();
    const href = nameEl.attr('href');
    const seeds = parseInt($(el).find('td.seeds').text().trim(), 10) || 0;
    const leeches = parseInt($(el).find('td.leeches').text().trim(), 10) || 0;
    const sizeText = $(el).find('td.size').text().replace(/<[^>]*>/g, '').trim();

    if (!title || !href) return;

    results.push({
      title,
      size: sizeText,
      seeds,
      leeches,
      torrentUrl: `https://${domain}${href}`,
      provider: '1337x',
    });
  });

  return results;
}

async function searchDomain(query, domain) {
  const encoded = encodeURIComponent(query);
  const maxPages = config.sources.x1337.maxPages || 1;
  const results = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://${domain}/search/${encoded}/${page}/`;
    const response = await fetchResilient(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.sources.x1337.timeout),
    });
    if (!response.ok) {
      if (page === 1) throw new Error(`1337x returned ${response.status}`);
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
  const domains = config.sources.x1337.domains;
  let lastError;

  for (const domain of domains) {
    try {
      return await searchDomain(query, domain);
    } catch (err) {
      lastError = err;
      console.error(`[1337x] domain ${domain} failed:`, err.message);
    }
  }

  throw lastError || new Error('1337x: all mirror domains failed');
}

async function getMagnet(torrentUrl) {
  const response = await fetchResilient(torrentUrl, {
    redirect: 'follow',
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
