const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const RETRY_STATUS = new Set([403, 408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with browser-like headers + exponential backoff retries.
 * Retries on network errors and on status codes commonly used by
 * Cloudflare/rate-limiters (403/408/429/5xx) since those are often transient.
 */
async function fetchResilient(url, options = {}, { retries = 3, baseDelayMs = 1000 } = {}) {
  const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers });
      if (response.ok) return response;
      if (!RETRY_STATUS.has(response.status) || attempt === retries) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }
    await sleep(baseDelayMs * Math.pow(2, attempt));
  }

  throw lastError;
}

module.exports = { fetchResilient, BROWSER_HEADERS };
