const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cacheManager = require('./lib/cache/manager');
const queueManager = require('./lib/cache/queue');
const streamEngine = require('./lib/stream/engine');
const searchEngine = require('./lib/search');
const trackers = require('./lib/search/trackers');
const VIDEO_EXTS = require('./lib/videoExts');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  cacheManager.init();
  queueManager.init();
  await streamEngine.init();

  app.listen(config.port, () => {
    console.log(`[torento] Running at http://localhost:${config.port}`);
    console.log(`[torento] Cache dir: ${config.cacheDir}`);
    console.log(`[torento] Max cache: ${config.cacheMaxGB}GB`);
  });
})();

app.get('/api/search', async (req, res) => {
  try {
    const { q, source } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });

    const data = await searchEngine.search(q, source);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/magnet', async (req, res) => {
  try {
    const { provider, torrentUrl } = req.body;
    if (!provider || !torrentUrl) {
      return res.status(400).json({ error: 'Missing provider or torrentUrl' });
    }
    const magnet = await searchEngine.getMagnet(provider, torrentUrl);
    res.json({ magnet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/play', async (req, res) => {
  try {
    const { magnet, provider, torrentUrl, preview } = req.body;

    let finalMagnet = magnet;
    if (!finalMagnet && provider && torrentUrl) {
      finalMagnet = await searchEngine.getMagnet(provider, torrentUrl);
    }
    if (!finalMagnet) {
      return res.status(400).json({ error: 'Missing magnet URI' });
    }

    const infoHash = streamEngine.extractInfoHash(finalMagnet);
    if (!infoHash) return res.status(400).json({ error: 'Could not extract info hash from magnet' });

    if (!finalMagnet.includes('&tr=')) {
      finalMagnet += trackers.map(t => '&tr=' + encodeURIComponent(t)).join('');
    }

    const torrent = await streamEngine.getTorrent(finalMagnet);
    if (!torrent) throw new Error('Failed to add torrent');

    if (preview) {
      for (const file of torrent.files) {
        try { file.deselect(); } catch {}
      }
    }

    const files = torrent.files
      .map((f, i) => ({
        originalIndex: i,
        name: f.name,
        size: f.length,
        ext: path.extname(f.name).toLowerCase(),
      }))
      .filter(f => VIDEO_EXTS.includes(f.ext))
      .map(f => ({
        index: f.originalIndex,
        name: f.name,
        size: f.size,
      }));

    const firstFile = files[0];
    const cached = cacheManager.getCached(infoHash);
    const streamUrl = `/stream/${infoHash}/file/${firstFile?.index ?? 0}/${encodeURIComponent(firstFile?.name || 'video')}`;

    res.json({
      infoHash,
      streamUrl,
      files,
      cached: !!cached,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:infoHash/file/:fileIndex/:filename', async (req, res) => {
  try {
    const { infoHash, fileIndex, filename } = req.params;
    const range = req.headers.range;
    const idx = parseInt(fileIndex, 10);

    const cached = cacheManager.getCached(infoHash, filename);
    if (cached) {
      console.log(`[stream] DISK: ${filename} (${infoHash.slice(0, 8)})`);
      cacheManager.touchCache(infoHash);
      serveFromDisk(cached.filePath, range, res);
      return;
    }

    console.log(`[stream] TORRENT: ${filename} (${infoHash.slice(0, 8)}) — not found in cache`);
    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.status(404).json({ error: 'Torrent not found. File may not be cached yet.' });

    const torrent = await streamEngine.getTorrent(magnet, { fileIndex: idx });
    const { stream, fileSize, fileName, start, end, mimeType } = streamEngine.getFileStream(torrent, idx, range);

    streamEngine.incrementStreams(infoHash);

    res.on('close', () => {
      streamEngine.decrementStreams(infoHash);
      stream.destroy();
    });

    const headers = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    };

    if (range) res.status(206);
    else headers['Content-Length'] = fileSize;

    res.writeHead(range ? 206 : 200, headers);
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

function findActiveMagnet(infoHash) {
  const cacheEntry = cacheManager.getCached(infoHash);
  if (cacheEntry?.magnet) return cacheEntry.magnet;
  return streamEngine.getMagnet(infoHash);
}

function serveFromDisk(filePath, range, res) {
  try {
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Cached file not found on disk' });
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    let start = 0;
    let end = fileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
    }

    const chunkSize = end - start + 1;
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
    };

    const headers = {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Cache-Control': 'no-cache',
    };

    if (range) {
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      stream.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

app.get('/api/torrent/:infoHash/files', async (req, res) => {
  try {
    const { infoHash } = req.params;

    // First: check if we have in-memory file list from active torrent
    const inMemory = streamEngine.getCachedFileList(infoHash);
    if (inMemory) {
      return res.json({ files: inMemory, cached: false });
    }

    // Second: check if all files for this infoHash are already on disk (no torrent needed)
    const diskFiles = cacheManager.getCacheFiles().filter(f => f.infoHash === infoHash);
    if (diskFiles.length > 0) {
      const files = diskFiles.map(f => ({
        index: f.fileIndex ?? 0,
        name: f.fileName,
        size: f.size,
        progress: f.verified ? 1 : 0,
      }));
      return res.json({ files, cached: true });
    }

    // Last resort: find the active magnet and load via torrent
    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.json({ files: [], cached: false });

    const torrent = await streamEngine.getTorrent(magnet);
    const files = torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      size: f.length,
      progress: f.progress,
    }));

    res.json({ files, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue', async (req, res) => {
  try {
    let { magnet, title, fileIndex, fileName, provider, torrentUrl } = req.body;

    if (!magnet && provider && torrentUrl) {
      magnet = await searchEngine.getMagnet(provider, torrentUrl);
    }
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const infoHash = streamEngine.extractInfoHash(magnet);
    if (!infoHash) return res.status(400).json({ error: 'Invalid magnet URI' });

    queueManager.addItem(infoHash, magnet, title || infoHash, fileIndex, fileName);

    const enhancedMagnet = magnet.includes('&tr=') ? magnet : magnet + trackers.map(t => '&tr=' + encodeURIComponent(t)).join('');
    const opts = fileIndex !== undefined && fileIndex !== null
      ? { fileIndex }
      : { selectAll: true };
    streamEngine.getTorrent(enhancedMagnet, opts).catch((e) => {
      queueManager.markError(infoHash, e.message);
    });

    res.json({ infoHash, queued: true });
  } catch (err) {
    console.log('[queue] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue', (req, res) => {
  res.json({ items: queueManager.getItems() });
});

app.delete('/api/queue/:infoHash', (req, res) => {
  try {
    const { infoHash } = req.params;
    queueManager.removeItem(infoHash);
    cacheManager.removeFromCache(infoHash);
    streamEngine.destroyTorrent(infoHash);
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/:infoHash', (req, res) => {
  try {
    const { infoHash } = req.params;
    // Support optional fileName query param to download a specific file from a multi-file torrent
    const fileName = req.query.fileName || null;
    const cached = cacheManager.getCached(infoHash, fileName);
    if (!cached) return res.status(404).json({ error: 'File not cached. Wait for download to complete.' });

    const filePath = cached.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Cached file not found on disk.' });

    cacheManager.touchCache(infoHash);
    const dlFileName = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dlFileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const dlStream = fs.createReadStream(filePath);
    dlStream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      dlStream.destroy();
    });
    dlStream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cache', (req, res) => {
  const size = cacheManager.getCacheSize();
  const files = cacheManager.getCacheFiles();
  const maxBytes = config.cacheMaxGB * 1024 * 1024 * 1024;

  res.json({
    size,
    sizeFormatted: formatBytes(size),
    maxSize: maxBytes,
    maxSizeFormatted: formatBytes(maxBytes),
    usagePercent: maxBytes > 0 ? ((size / maxBytes) * 100).toFixed(1) : 0,
    fileCount: files.length,
    files,
  });
});

app.delete('/api/cache', (req, res) => {
  const files = cacheManager.getCacheFiles();
  for (const f of files) {
    cacheManager.removeFromCache(f.infoHash);
  }
  res.json({ cleared: true, removed: files.length });
});

app.get('/api/cache/partials', (req, res) => {
  try {
    const info = streamEngine.getPartialsInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cache/partials', (req, res) => {
  try {
    const result = streamEngine.cleanupPartials();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cache/:infoHash', (req, res) => {
  try {
    const fileName = req.query.fileName || null;
    cacheManager.removeFromCache(req.params.infoHash, fileName);
    streamEngine.destroyTorrent(req.params.infoHash);
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

module.exports = app;
