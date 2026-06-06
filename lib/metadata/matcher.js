function extractYear(str) {
  const match = str.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

function cleanTitle(str) {
  return str
    .replace(/[.\-_]/g, ' ')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(19|20)\d{2}\b/, '')
    .replace(/\b(1080p|720p|2160p|480p|4K|HD|WEB-DL|WEBRip|BluRay|BRRip|HDRip|DVDRip|HDTV|HEVC|x265|x264|H\.?264|H\.?265|AAC|DDP|DD5\.?\d|Atmos|10bit|8bit|RARBG|YTS|YIFY|BONE|LAMA|MeGusta|FLUX|NTb|playWEB|RAWR|STC|ETHEL|EDITH|JFF|BAE|CRiMSON|NGP|Kitsune|SCOPE|TvTeam|jajaja|HolyRoses|Anonymous|KayWily|Mesoglea)\b/gi, '')
    .replace(/\bS\d{2}E\d{2}\b/gi, '')
    .replace(/\bSeason\s*\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function similarity(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  if (la.includes(lb) || lb.includes(la)) return 0.9;

  const wa = la.split(/\s+/).filter(Boolean);
  const wb = lb.split(/\s+/).filter(Boolean);
  let matches = 0;
  for (const w of wa) {
    if (w.length < 2) continue;
    if (wb.some((x) => x === w)) matches++;
  }
  const total = Math.max(wa.filter((w) => w.length >= 2).length, wb.filter((w) => w.length >= 2).length);
  return total > 0 ? matches / total : 0;
}

function matchTorrentsToMetadata(torrents, metadataItems) {
  if (!metadataItems.length) {
    const groups = {};
    for (const tor of torrents) {
      const cleaned = cleanTitle(tor.title);
      const year = extractYear(tor.title) || '';
      const key = cleaned.toLowerCase() + '|' + year;
      if (!groups[key]) groups[key] = { metadata: null, torrents: [] };
      groups[key].torrents.push(tor);
    }
    return Object.values(groups).sort((a, b) => {
      const sa = Math.max(...a.torrents.map((t) => t.seeds || 0));
      const sb = Math.max(...b.torrents.map((t) => t.seeds || 0));
      return sb - sa;
    });
  }

  const matches = [];

  for (const meta of metadataItems) {
    const matchedTorrents = [];
    for (const tor of torrents) {
      const cleaned = cleanTitle(tor.title);
      const torYear = extractYear(tor.title);
      const metaYear = meta.year ? String(meta.year) : null;

      const titleSim = similarity(meta.title, cleaned);
      const origSim = meta.originalTitle ? similarity(meta.originalTitle, cleaned) : 0;
      const bestSim = Math.max(titleSim, origSim);

      let yearMatch = true;
      if (torYear && metaYear && torYear !== metaYear) {
        yearMatch = false;
      }

      if (bestSim >= 0.5 && yearMatch) {
        matchedTorrents.push({ ...tor, matchScore: bestSim });
      }
    }

    matchedTorrents.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));

    matches.push({
      metadata: meta,
      torrents: matchedTorrents,
    });
  }

  matches.sort((a, b) => {
    const sa = a.torrents.length ? Math.max(...a.torrents.map((t) => t.seeds || 0)) : 0;
    const sb = b.torrents.length ? Math.max(...b.torrents.map((t) => t.seeds || 0)) : 0;
    return sb - sa;
  });

  const matchedTorrentSet = new Set();
  for (const m of matches) {
    for (const t of m.torrents) {
      matchedTorrentSet.add(t.title);
    }
  }

  const unmatched = torrents.filter((t) => !matchedTorrentSet.has(t.title));
  if (unmatched.length) {
    const groups = {};
    for (const tor of unmatched) {
      const cleaned = cleanTitle(tor.title);
      const year = extractYear(tor.title) || '';
      const key = cleaned.toLowerCase() + '|' + year;
      if (!groups[key]) groups[key] = { metadata: null, torrents: [] };
      groups[key].torrents.push(tor);
    }
    matches.push(...Object.values(groups));
  }

  return matches;
}

module.exports = { matchTorrentsToMetadata, cleanTitle, extractYear };
