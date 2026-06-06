const fs = require('fs');
const path = require('path');
const config = require('../../config');

const META_FILE = 'meta.json';
const EVICT_CHECK_INTERVAL = 5 * 60 * 1000;

let meta = { files: {} };

function init() {
  ensureDir(config.cacheDir);
  loadMeta();
  evictIfNeeded();
  setInterval(() => {
    evictIfNeeded();
    evictByTTL();
  }, EVICT_CHECK_INTERVAL);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getMetaPath() {
  return path.join(config.cacheDir, META_FILE);
}

function loadMeta() {
  try {
    const raw = fs.readFileSync(getMetaPath(), 'utf8');
    meta = JSON.parse(raw);
    if (!meta.files) meta.files = {};
  } catch {
    meta = { files: {} };
  }
}

function saveMeta() {
  fs.writeFileSync(getMetaPath(), JSON.stringify(meta, null, 2));
}

function getCacheSize() {
  let total = 0;
  for (const entry of Object.values(meta.files)) {
    if (entry.size) total += entry.size;
  }
  return total;
}

function getCacheFiles() {
  return Object.values(meta.files).map((f) => ({
    infoHash: f.infoHash,
    fileName: f.fileName,
    size: f.size,
    addedAt: f.addedAt,
    lastAccessed: f.lastAccessed,
  }));
}

function getCached(infoHash) {
  const entry = meta.files[infoHash];
  if (!entry) return null;
  if (!fs.existsSync(entry.filePath)) {
    delete meta.files[infoHash];
    saveMeta();
    return null;
  }
  return entry;
}

function addToCache(infoHash, fileName, size, magnet, filePath) {
  meta.files[infoHash] = {
    infoHash,
    fileName,
    size,
    magnet,
    addedAt: Date.now(),
    lastAccessed: Date.now(),
    filePath,
  };
  saveMeta();
  evictIfNeeded();
}

function touchCache(infoHash) {
  if (meta.files[infoHash]) {
    meta.files[infoHash].lastAccessed = Date.now();
    saveMeta();
  }
}

function removeFromCache(infoHash) {
  const entry = meta.files[infoHash];
  if (entry) {
    try { fs.unlinkSync(entry.filePath); } catch {}
    try { fs.rmdirSync(path.dirname(entry.filePath)); } catch {}
    delete meta.files[infoHash];
    saveMeta();
  }
}

function evictIfNeeded() {
  const maxBytes = config.cacheMaxGB * 1024 * 1024 * 1024;
  const currentSize = getCacheSize();

  if (currentSize <= maxBytes) return;

  const sorted = Object.entries(meta.files)
    .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

  let freed = 0;
  const target = maxBytes * 0.85;

  for (const [hash, entry] of sorted) {
    if (currentSize - freed <= target) break;

    try { fs.unlinkSync(entry.filePath); } catch {}
    try { fs.rmdirSync(path.dirname(entry.filePath)); } catch {}
    delete meta.files[hash];
    freed += entry.size || 0;
  }

  saveMeta();
  if (freed > 0) {
    console.log(`[cache] Evicted ${(freed / 1024 / 1024 / 1024).toFixed(2)}GB from cache`);
  }
}

function evictByTTL() {
  const ttlMs = config.cacheTTLHours * 60 * 60 * 1000;
  if (ttlMs <= 0) return;

  const now = Date.now();
  let removed = 0;

  for (const [hash, entry] of Object.entries(meta.files)) {
    if (now - entry.lastAccessed > ttlMs) {
      try { fs.unlinkSync(entry.filePath); } catch {}
      try { fs.rmdirSync(path.dirname(entry.filePath)); } catch {}
      delete meta.files[hash];
      removed++;
    }
  }

  if (removed > 0) {
    saveMeta();
    console.log(`[cache] TTL evicted ${removed} files`);
  }
}

module.exports = {
  init,
  getCacheSize,
  getCacheFiles,
  getCached,
  addToCache,
  touchCache,
  removeFromCache,
  evictIfNeeded,
  evictByTTL,
};
