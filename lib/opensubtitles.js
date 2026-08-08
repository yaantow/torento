const config = require('../config');

const BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Torento v1.0.0';

function headers(extra) {
  return { 'Api-Key': config.opensubtitles.apiKey, 'User-Agent': USER_AGENT, ...extra };
}

async function search(query, opts = {}) {
  if (!config.opensubtitles.apiKey) throw new Error('OpenSubtitles is not configured');

  const params = new URLSearchParams({ query, languages: opts.languages || 'en' });
  const resp = await fetch(`${BASE}/subtitles?${params}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`OpenSubtitles search failed (${resp.status})`);
  const data = await resp.json();

  return (data.data || [])
    .map((item) => {
      const a = item.attributes || {};
      const file = (a.files || [])[0];
      return {
        fileId: file?.file_id ?? null,
        fileName: file?.file_name || `${a.release || 'subtitle'}.srt`,
        language: a.language || '?',
        release: a.release || '',
        downloadCount: a.download_count || 0,
      };
    })
    .filter((s) => s.fileId !== null)
    .sort((a, b) => b.downloadCount - a.downloadCount);
}

// Free-tier keys are capped at a handful of downloads/day — each call here
// spends one, so callers should only hit it once the user picks a result.
async function download(fileId) {
  if (!config.opensubtitles.apiKey) throw new Error('OpenSubtitles is not configured');

  const resp = await fetch(`${BASE}/download`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.message || `OpenSubtitles download failed (${resp.status})`);
  if (!data.link) throw new Error('OpenSubtitles did not return a download link');

  const fileResp = await fetch(data.link, { signal: AbortSignal.timeout(15000) });
  if (!fileResp.ok) throw new Error(`Failed to fetch subtitle file (${fileResp.status})`);

  return { text: await fileResp.text(), fileName: data.file_name || 'subtitle.srt', remaining: data.remaining };
}

module.exports = { search, download };
