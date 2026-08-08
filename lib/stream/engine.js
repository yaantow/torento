const path = require('path');
const fs = require('fs');
const config = require('../../config');
const queue = require('../cache/queue');
const VIDEO_EXTS = require('../videoExts');

let WebTorrent;
let client;
const activeStreams = new Map();
const magnetMap = new Map();
const fileListCache = new Map();
const torrentIntervals = new Map();
const torrentPaths = new Map();

// Set by the app to notify the Drive uploader when a file is staged locally.
let onFileReady = null;
function setFileReadyHandler(fn) { onFileReady = fn; }
function notifyFileReady(infoHash, fileName, fileIndex, size, localPath) {
  if (!onFileReady) return;
  try { onFileReady(infoHash, { fileName, fileIndex, size, localPath }); } catch {}
}

async function init() {
  const mod = await import('webtorrent');
  WebTorrent = mod.default;
  createClient();
  console.log('[webtorrent] Initialized');
  resumeDownloads();
}

function createClient() {
  if (client) {
    try { client.destroy(); } catch {}
  }
  cleanupStaleData();
  client = new WebTorrent({
    maxConns: config.webtorrent.maxConns,
    uploadLimit: config.webtorrent.uploadLimit,
    path: path.join(config.cacheDir, '.torrents'),
  });
  client.on('error', (err) => console.error('[webtorrent]', err.message));
  console.log('[webtorrent] Client created');
}

function cleanupStaleData() {
  const partialsDir = path.join(config.cacheDir, '.torrents');
  try { fs.rmSync(partialsDir, { recursive: true, force: true }); } catch {}

  const oldTmpDir = path.join(require('os').tmpdir(), 'webtorrent');
  try { fs.rmSync(oldTmpDir, { recursive: true, force: true }); } catch {}
}

async function resumeDownloads() {
  const entries = queue.allDownloading();
  const cacheManager = require('../cache/manager');
  let resumed = 0;

  // One torrent may back several users' entries — resume each unique hash once.
  const seen = new Set();
  for (const { userId, item } of entries) {
    if (seen.has(item.infoHash)) continue;
    seen.add(item.infoHash);

    console.log('[webtorrent] Resuming:', item.infoHash, item.title || item.fileName);

    try {
      const torrent = await getTorrent(item.magnet, { fileIndex: item.fileIndex });

      if (item.fileIndex === null || item.fileIndex === undefined) {
        const cachedNames = new Set();
        for (const cf of cacheManager.getCacheFiles()) {
          if (cf.infoHash === item.infoHash && cf.verified) cachedNames.add(cf.fileName);
        }
        for (const file of torrent.files) {
          if (cachedNames.has(file.name)) {
            try { file.deselect(); } catch {}
          }
        }
      }

      resumed++;
    } catch (e) {
      queue.markError(userId, item.infoHash, e.message);
    }
  }

  if (resumed > 0) console.log(`[webtorrent] Resumed ${resumed} downloads`);
}

function extractInfoHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
  if (match) return match[1].toLowerCase();
  return null;
}

async function getTorrent(magnet, opts) {
  const infoHash = extractInfoHash(magnet);
  if (!infoHash) throw new Error('Invalid magnet URI');

  const fileToKeep = opts?.fileIndex ?? null;

  magnetMap.set(infoHash, magnet);

  const existing = client.torrents.find(t => t._infoHash === infoHash);
  if (existing) {
    if (existing.files) {
      try {
        if (fileToKeep !== null && fileToKeep !== undefined) {
          existing.files[fileToKeep]?.select();
          for (let i = 0; i < existing.files.length; i++) {
            if (i !== fileToKeep) existing.files[i].deselect();
          }
        } else if (opts?.selectAll) {
          for (let i = 0; i < existing.files.length; i++) {
            existing.files[i].select();
          }
        }
      } catch (e) {}
    }
    return existing;
  }

  if (client.torrents.length >= config.maxConcurrentTorrents) {
    let toRemove = client.torrents[0];
    for (const t of client.torrents) {
      const count = activeStreams.get(t._infoHash) || 0;
      if (count === 0) { toRemove = t; break; }
    }
    if (toRemove) destroyTorrent(toRemove._infoHash);
  }

  return new Promise((resolve, reject) => {
    const torrent = client.add(magnet);
    if (!torrent) {
      reject(new Error('Failed to add torrent'));
      return;
    }

    torrent._infoHash = infoHash;

    let progressInterval = null;
    let fullyDone = false;
    const writingFiles = new Set();

    function tryDestroyAfterDone() {
      if (!fullyDone) return;
      if (writingFiles.size > 0) return;
      if (activeStreams.get(infoHash)) return;
      destroyTorrent(infoHash);
    }

    const timeout = setTimeout(() => {
      if (progressInterval) {
        clearInterval(progressInterval);
        torrentIntervals.delete(infoHash);
      }
      torrent.destroy();
      magnetMap.delete(infoHash);
      fileListCache.delete(infoHash);
      activeStreams.delete(infoHash);
      queue.markErrorByHash(infoHash, 'No metadata peers after 60s');
      console.log('[webtorrent]', infoHash, 'No metadata peers after 60s');
      reject(new Error('No metadata peers after 60s — try a different torrent'));
    }, 60000);

    torrent.on('ready', () => {
      clearTimeout(timeout);
      torrentPaths.set(infoHash, torrent.path);
      const files = torrent.files.map((f, i) => ({
        index: i, name: f.name, size: f.length,
        ext: require('path').extname(f.name).toLowerCase(),
      }));
      fileListCache.set(infoHash, files);

      const cachedFiles = new Set();

      progressInterval = setInterval(() => {
        const rawPct = torrent.progress * 100;
        const pct = Math.round(rawPct * 10) / 10;
        queue.updateProgressByHash(infoHash, pct);

        const cacheManager = require('../cache/manager');
        const cacheDir = path.join(config.cacheDir, infoHash);
        for (let fi = 0; fi < torrent.files.length; fi++) {
          const file = torrent.files[fi];
          if (!file.downloaded) continue;
          if (cachedFiles.has(file.name) || writingFiles.has(file.name)) continue;
          const ext = path.extname(file.name).toLowerCase();
          if (!VIDEO_EXTS.includes(ext)) continue;
          const cachePath = path.join(cacheDir, path.basename(file.name));
          if (fs.existsSync(cachePath)) {
            // Only treat a pre-existing path as "already cached" if it's actually
            // complete — otherwise this is our own write from an earlier tick still
            // in flight (writingFiles guards that above), or a stale partial left
            // over from a crashed run. Either way, firing notifyFileReady here would
            // hand the uploader a truncated file and it'd fail Drive's size check.
            let onDiskSize = -1;
            try { onDiskSize = fs.statSync(cachePath).size; } catch {}
            if (onDiskSize === file.length) {
              cacheManager.addToCache(infoHash, file.name, file.length, magnet, cachePath, fi);
              cachedFiles.add(file.name);
              notifyFileReady(infoHash, file.name, fi, file.length, cachePath);
              continue;
            }
            // Stale/incomplete leftover — fall through and re-write it properly
            // (createWriteStream below truncates) instead of skipping it forever.
          }
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            const readStream = file.createReadStream();
            const writeStream = fs.createWriteStream(cachePath);
            writingFiles.add(file.name);
            readStream.pipe(writeStream);
            const fileIdx = fi;
            const fileName = file.name;
            writeStream.on('finish', () => {
              readStream.destroy();
              cacheManager.addToCache(infoHash, fileName, file.length, magnet, cachePath, fileIdx);
              cachedFiles.add(fileName);
              writingFiles.delete(fileName);
              notifyFileReady(infoHash, fileName, fileIdx, file.length, cachePath);
              tryDestroyAfterDone();
            });
            writeStream.on('error', () => {
              readStream.destroy();
              writeStream.destroy();
              writingFiles.delete(fileName);
              tryDestroyAfterDone();
            });
            readStream.on('error', () => {
              readStream.destroy();
              writeStream.destroy();
              writingFiles.delete(fileName);
              tryDestroyAfterDone();
            });
          } catch (e) {
            console.log('[cache] failed to save:', file.name, e.message);
          }
        }

        if (torrent.progress >= 1) {
          clearInterval(progressInterval);
          torrentIntervals.delete(infoHash);
          progressInterval = null;
        }
      }, 5000);

      torrentIntervals.set(infoHash, progressInterval);

      resolve(torrent);

      if (fileToKeep !== null && fileToKeep !== undefined) {
        try {
          for (let i = 0; i < torrent.files.length; i++) {
            if (i !== fileToKeep) torrent.files[i].deselect();
          }
        } catch (e) {}
      }
    });
    torrent.on('error', (err) => {
      if (progressInterval) {
        clearInterval(progressInterval);
        torrentIntervals.delete(infoHash);
      }
      clearTimeout(timeout);
      magnetMap.delete(infoHash);
      fileListCache.delete(infoHash);
      activeStreams.delete(infoHash);
      queue.markErrorByHash(infoHash, err.message);
      reject(err);
    });
    torrent.on('done', () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        torrentIntervals.delete(infoHash);
        progressInterval = null;
      }
      // Files are pushed to Drive by the uploader (triggered per-file above);
      // the queue item reaches 'stored' when its Drive upload verifies.
      fullyDone = true;
      tryDestroyAfterDone();
      setTimeout(() => {
        if (client.torrents.find(t => t._infoHash === infoHash)) {
          destroyTorrent(infoHash);
        }
      }, 120000);
    });
  });
}

function getFileStream(torrent, fileIndex, range) {
  const file = torrent.files[fileIndex];
  if (!file) throw new Error(`File index ${fileIndex} out of range`);

  let start = 0;
  let end = file.length - 1;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10) || 0;
    if (parts[1]) end = Math.min(parseInt(parts[1], 10), file.length - 1);
  }

  return {
    stream: file.createReadStream({ start, end }),
    fileSize: file.length,
    fileName: file.name,
    start,
    end,
    mimeType: getMimeType(file.name),
  };
}

function getActiveStreamCount(infoHash) {
  return activeStreams.get(infoHash) || 0;
}

function incrementStreams(infoHash) {
  activeStreams.set(infoHash, (activeStreams.get(infoHash) || 0) + 1);
}

function decrementStreams(infoHash) {
  const count = (activeStreams.get(infoHash) || 1) - 1;
  if (count <= 0) activeStreams.delete(infoHash);
  else activeStreams.set(infoHash, count);
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
  };
  return types[ext] || 'application/octet-stream';
}

function getMagnet(infoHash) {
  return magnetMap.get(infoHash) || null;
}

function getCachedFileList(infoHash) {
  return fileListCache.get(infoHash) || null;
}

function getClient() {
  return client;
}

function destroyTorrent(infoHash) {
  const interval = torrentIntervals.get(infoHash);
  if (interval) {
    clearInterval(interval);
    torrentIntervals.delete(infoHash);
  }
  magnetMap.delete(infoHash);
  fileListCache.delete(infoHash);
  activeStreams.delete(infoHash);

  const torrentPath = torrentPaths.get(infoHash);
  const torrent = client.torrents.find(t => t._infoHash === infoHash);
  if (torrent) {
    const tp = torrent.path || torrentPath;
    try { torrent.destroy(); } catch {}
    if (tp) {
      try { fs.rmSync(tp, { recursive: true, force: true }); } catch {}
    }
    torrentPaths.delete(infoHash);
    return true;
  }
  if (torrentPath) {
    try { fs.rmSync(torrentPath, { recursive: true, force: true }); } catch {}
    torrentPaths.delete(infoHash);
  }
  return false;
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const full = path.join(dirPath, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) size += st.size;
        else if (st.isDirectory()) size += getDirSize(full);
      } catch {}
    }
  } catch {}
  return size;
}

function getPartialsInfo() {
  const partialsDir = path.join(config.cacheDir, '.torrents');
  if (!fs.existsSync(partialsDir)) return { dirs: [], totalSize: 0 };

  const activePaths = new Set();
  for (const [, tp] of torrentPaths) { if (tp) activePaths.add(tp); }
  for (const t of client.torrents) { if (t.path) activePaths.add(t.path); }

  const dirs = [];
  let totalSize = 0;
  try {
    for (const entry of fs.readdirSync(partialsDir)) {
      const dirPath = path.join(partialsDir, entry);
      try {
        const st = fs.statSync(dirPath);
        if (!st.isDirectory()) continue;
        const size = getDirSize(dirPath);
        totalSize += size;
        dirs.push({ name: entry, path: dirPath, size, active: activePaths.has(dirPath) });
      } catch {}
    }
  } catch {}

  return { dirs, totalSize };
}

function cleanupPartials() {
  const partialsDir = path.join(config.cacheDir, '.torrents');
  if (!fs.existsSync(partialsDir)) return { removed: 0, sizeFreed: 0 };

  const activePaths = new Set();
  for (const [, tp] of torrentPaths) { if (tp) activePaths.add(tp); }
  for (const t of client.torrents) { if (t.path) activePaths.add(t.path); }

  let removed = 0;
  let sizeFreed = 0;
  try {
    for (const entry of fs.readdirSync(partialsDir)) {
      const dirPath = path.join(partialsDir, entry);
      if (activePaths.has(dirPath)) continue;
      try {
        const size = getDirSize(dirPath);
        sizeFreed += size;
        fs.rmSync(dirPath, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  } catch {}

  if (removed > 0) {
    console.log(`[partials] Cleaned ${removed} orphaned partial dirs (${(sizeFreed / 1024 / 1024 / 1024).toFixed(2)}GB)`);
  }
  return { removed, sizeFreed };
}

module.exports = {
  init,
  getTorrent,
  getFileStream,
  getMagnet,
  getCachedFileList,
  getClient,
  destroyTorrent,
  incrementStreams,
  decrementStreams,
  getActiveStreamCount,
  setFileReadyHandler,
  extractInfoHash,
  getPartialsInfo,
  cleanupPartials,
};
