const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cacheManager = require('./lib/cache/manager');
const streamEngine = require('./lib/stream/engine');
const searchEngine = require('./lib/search');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  cacheManager.init();
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
    const { magnet, provider, torrentUrl } = req.body;

    let finalMagnet = magnet;
    if (!finalMagnet && provider && torrentUrl) {
      finalMagnet = await searchEngine.getMagnet(provider, torrentUrl);
    }
    if (!finalMagnet) {
      return res.status(400).json({ error: 'Missing magnet URI' });
    }

    const infoHash = streamEngine.extractInfoHash(finalMagnet);
    if (!infoHash) return res.status(400).json({ error: 'Could not extract info hash from magnet' });

    const torrent = await streamEngine.getTorrent(finalMagnet);
    if (!torrent) throw new Error('Failed to add torrent');

    const files = torrent.files
      .map((f, i) => ({
        originalIndex: i,
        name: f.name,
        size: f.length,
        ext: path.extname(f.name).toLowerCase(),
      }))
      .filter(f => ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(f.ext))
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

app.post('/api/playback', async (req, res) => {
  try {
    const { magnet, fileIndex } = req.body;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const infoHash = streamEngine.extractInfoHash(magnet);
    if (!infoHash) return res.status(400).json({ error: 'Could not extract info hash' });

    const idx = parseInt(fileIndex, 10) || 0;
    const torrent = await streamEngine.getTorrent(magnet);
    if (!torrent) throw new Error('Failed to add torrent');
    const file = torrent.files[idx];

    if (!file) return res.status(404).json({ error: 'File not found at index ' + idx });

    const name = encodeURIComponent(file.name);
    res.json({
      streamUrl: `/stream/${torrent.infoHash}/file/${idx}/${name}`,
      infoHash: torrent.infoHash,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:infoHash/file/:fileIndex/:filename', async (req, res) => {
  try {
    const { infoHash, fileIndex } = req.params;
    const range = req.headers.range;
    const idx = parseInt(fileIndex, 10);

    const cached = cacheManager.getCached(infoHash);
    if (cached) {
      cacheManager.touchCache(infoHash);
      serveFromDisk(cached.filePath, range, res);
      return;
    }

    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.status(404).json({ error: 'Torrent not found' });

    const torrent = await streamEngine.getTorrent(magnet);
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
    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.json({ files: [] });

    const torrent = await streamEngine.getTorrent(magnet);
    const files = torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      size: f.length,
      progress: f.progress,
    }));

    res.json({ files });
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

app.delete('/api/cache/:infoHash', (req, res) => {
  try {
    cacheManager.removeFromCache(req.params.infoHash);
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
