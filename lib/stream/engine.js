const path = require('path');
const config = require('../../config');

let WebTorrent;
let client;
const activeStreams = new Map();
const magnetMap = new Map();
const fileListCache = new Map();

async function init() {
  const mod = await import('webtorrent');
  WebTorrent = mod.default;
  createClient();
  console.log('[webtorrent] Initialized');
}

function createClient() {
  if (client) {
    try { client.destroy(); } catch {}
  }
  client = new WebTorrent({
    maxConns: config.webtorrent.maxConns,
    uploadLimit: config.webtorrent.uploadLimit,
  });
  client.on('error', (err) => console.error('[webtorrent]', err.message));
  console.log('[webtorrent] Client created');
}

function extractInfoHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
  if (match) return match[1].toLowerCase();
  return null;
}

async function getTorrent(magnet) {
  const infoHash = extractInfoHash(magnet);
  if (!infoHash) throw new Error('Invalid magnet URI');

  magnetMap.set(infoHash, magnet);

  const existing = client.torrents.find(t => t._infoHash === infoHash);
  if (existing) {
    return existing;
  }

  if (client.torrents.length >= config.maxConcurrentTorrents) {
    let toRemove = client.torrents[0];
    for (const t of client.torrents) {
      const count = activeStreams.get(t._infoHash) || 0;
      if (count === 0) { toRemove = t; break; }
    }
    if (toRemove) toRemove.destroy();
  }

  return new Promise((resolve, reject) => {
    const torrent = client.add(magnet);
    if (!torrent) {
      reject(new Error('Failed to add torrent'));
      return;
    }

    torrent._infoHash = infoHash;

    const timeout = setTimeout(() => {
      torrent.destroy();
      console.log('[webtorrent] No peers, recreating client...');
      createClient();
      reject(new Error('No peers found after 15s — try a different torrent'));
    }, 15000);

    torrent.on('ready', () => {
      clearTimeout(timeout);
      const files = torrent.files.map((f, i) => ({
        index: i, name: f.name, size: f.length,
        ext: require('path').extname(f.name).toLowerCase(),
      }));
      fileListCache.set(infoHash, files);
      resolve(torrent);
    });
    torrent.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    torrent.on('done', () => {
      const cacheManager = require('../cache/manager');
      const fs = require('fs');
      const path = require('path');
      for (const file of torrent.files) {
        const ext = path.extname(file.name).toLowerCase();
        if (!['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext)) continue;
        const cacheDir = path.join(config.cacheDir, infoHash);
        const cachePath = path.join(cacheDir, path.basename(file.name));
        if (fs.existsSync(cachePath)) {
          cacheManager.addToCache(infoHash, file.name, file.length, magnet, cachePath);
          continue;
        }
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          const readStream = file.createReadStream();
          const writeStream = fs.createWriteStream(cachePath);
          readStream.pipe(writeStream);
          writeStream.on('finish', () => {
            cacheManager.addToCache(infoHash, file.name, file.length, magnet, cachePath);
            console.log('[cache] Saved:', file.name);
          });
        } catch (e) {
          console.error('[cache] Failed to save:', file.name, e.message);
        }
      }
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

module.exports = {
  init,
  getTorrent,
  getFileStream,
  getMagnet,
  getCachedFileList,
  getClient,
  incrementStreams,
  decrementStreams,
  extractInfoHash,
};
