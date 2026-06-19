const fs = require('fs');
const path = require('path');
const config = require('../../config');

const META_FILE = 'meta.json';
const EVICT_CHECK_INTERVAL = 5 * 60 * 1000;

let meta = { files: {} };
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 1000;

function init() {
  ensureDir(config.cacheDir);
  loadMeta();
  recoverOrphans();
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

function recoverOrphans() {
  const tracked = new Set();
  for (const entry of Object.values(meta.files)) {
    tracked.add(entry.filePath);
  }
  try {
    const dirs = fs.readdirSync(config.cacheDir);
    let recovered = 0;
    for (const dir of dirs) {
      if (dir === '.torrents' || dir === META_FILE || dir === 'queue.json') continue;
      const dirPath = path.join(config.cacheDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          if (tracked.has(filePath)) continue;
          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            meta.files[filePath] = {
              infoHash: dir,
              fileName: file,
              size: stat.size,
              magnet: '',
              addedAt: stat.birthtimeMs || stat.mtimeMs,
              lastAccessed: stat.mtimeMs,
              filePath,
            };
            recovered++;
          } catch {}
        }
      } catch {}
    }
    if (recovered > 0) {
      saveMeta();
      console.log(`[cache] Recovered ${recovered} orphaned files`);
    }
  } catch {}
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

function writeMeta() {
  fs.writeFileSync(getMetaPath(), JSON.stringify(meta, null, 2));
}

function saveMeta() {
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      writeMeta();
    }, SAVE_DEBOUNCE_MS);
  }
}

function saveMetaNow() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  writeMeta();
}

function getCacheSize() {
  let total = 0;
  for (const entry of Object.values(meta.files)) {
    if (entry.size) total += entry.size;
  }
  return total;
}

function getCacheFiles() {
  return Object.values(meta.files).map((f) => {
    let verified = false;
    try {
      const stat = fs.statSync(f.filePath);
      verified = stat.isFile() && stat.size === f.size;
    } catch {}
    return {
      infoHash: f.infoHash,
      fileName: f.fileName,
      size: f.size,
      magnet: f.magnet || '',
      fileIndex: f.fileIndex ?? null,
      sizeOnDisk: verified ? f.size : (() => { try { return fs.statSync(f.filePath).size; } catch { return 0; } })(),
      verified,
      addedAt: f.addedAt,
      lastAccessed: f.lastAccessed,
    };
  });
}

function getCached(infoHash, fileName) {
  const entries = Object.entries(meta.files);
  for (const [key, entry] of entries) {
    if (entry.infoHash !== infoHash) continue;
    if (fileName && entry.fileName !== fileName) continue;
    if (fs.existsSync(entry.filePath)) return entry;
    delete meta.files[key];
    saveMeta();
  }
  return null;
}

function addToCache(infoHash, fileName, size, magnet, filePath, fileIndex) {
  meta.files[filePath] = {
    infoHash,
    fileName,
    size,
    magnet,
    fileIndex: fileIndex ?? null,
    addedAt: Date.now(),
    lastAccessed: Date.now(),
    filePath,
  };
  saveMetaNow();
  evictIfNeeded();
}

function touchCache(infoHash) {
  for (const entry of Object.values(meta.files)) {
    if (entry.infoHash === infoHash) {
      entry.lastAccessed = Date.now();
      saveMeta();
      return;
    }
  }
}

function removeFromCache(infoHash, fileName) {
  const toRemove = [];
  for (const [key, entry] of Object.entries(meta.files)) {
    if (entry.infoHash !== infoHash) continue;
    if (fileName && entry.fileName !== fileName) continue;
    toRemove.push(key);
  }
  for (const key of toRemove) {
    const entry = meta.files[key];
    try { fs.unlinkSync(entry.filePath); } catch {}
    try { fs.rmdirSync(path.dirname(entry.filePath)); } catch {}
    delete meta.files[key];
  }
  if (toRemove.length > 0) saveMetaNow();
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
