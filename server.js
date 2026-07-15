const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cacheManager = require('./lib/cache/manager');
const queueManager = require('./lib/cache/queue');
const streamEngine = require('./lib/stream/engine');
const searchEngine = require('./lib/search');
const trackers = require('./lib/search/trackers');
const VIDEO_EXTS = require('./lib/videoExts');

const oauth = require('./lib/auth/oauth');
const users = require('./lib/auth/users');
const spaces = require('./lib/auth/spaces');
const session = require('./lib/auth/session');
const drive = require('./lib/drive/drive');
const uploader = require('./lib/drive/uploader');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(session.attachUser);
app.use(session.attachSpace);

// Static assets are public; the SPA itself decides what to show pre-login.
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  cacheManager.init();
  queueManager.init();
  streamEngine.setFileReadyHandler(uploader.handleFileReady);
  await streamEngine.init();
  uploader.resumePending();

  app.listen(config.port, () => {
    console.log(`[torento] Running at ${config.appUrl}`);
    console.log(`[torento] Auth configured: ${oauth.isConfigured()}`);
    console.log(`[torento] Staging dir: ${config.cacheDir} (max ${config.cacheMaxGB}GB)`);
  });
})();

/* ============================================================
   AUTH
   ============================================================ */

app.get('/api/auth/config', (req, res) => {
  res.json({
    configured: oauth.isConfigured(),
    pickerApiKey: config.drive.pickerApiKey || null,
    clientId: config.auth.clientId || null,
  });
});

app.get('/api/me', (req, res) => {
  res.json({ user: users.publicView(req.user) });
});

app.get('/api/auth/login', (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).send('Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET in .env.');
  }
  const state = session.issueState(res);
  const forceConsent = req.query.reconnect === '1';
  res.redirect(oauth.getAuthUrl(state, forceConsent));
});

app.get('/api/auth/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?auth_error=' + encodeURIComponent(req.query.error));
    if (!session.verifyState(req, res)) return res.redirect('/?auth_error=state_mismatch');

    const tokens = await oauth.exchangeCode(req.query.code);
    if (!tokens.id_token) throw new Error('No identity token returned');

    const profile = await oauth.getProfile(tokens.id_token);
    // Invited members bypass ALLOWED_EMAILS — being on a members list is consent.
    if (!session.isEmailAllowed(profile.email) && !spaces.isInvitedEmail(profile.email)) {
      return res.redirect('/?auth_error=' + encodeURIComponent('not_allowed'));
    }

    users.upsert(profile, tokens.refresh_token);
    session.issueSession(res, profile.id);
    res.redirect('/');
  } catch (err) {
    console.log('[auth] callback error:', err.message);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

app.post('/api/auth/logout', (req, res) => {
  session.clearSession(res);
  res.json({ ok: true });
});

/* ============================================================
   GOOGLE DRIVE
   ============================================================ */

app.get('/api/drive/status', session.requireAuth, async (req, res) => {
  const ownerId = req.space.ownerUserId;
  const owner = users.get(ownerId);
  const isOwner = ownerId === req.user.id;
  const connected = users.hasDriveConnection(ownerId);
  let storage = null;
  if (connected && isOwner) storage = await drive.getStorageInfo(ownerId);
  res.json({
    connected,
    isOwner,
    sharedBy: isOwner ? null : (owner ? (owner.name || owner.email) : null),
    folder: owner && owner.driveFolderId ? { id: owner.driveFolderId, name: owner.driveFolderName } : null,
    defaultFolderName: drive.defaultFolderName(),
    pickerEnabled: !!config.drive.pickerApiKey,
    storage,
  });
});

app.get('/api/drive/folders', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    res.json({ folders: await drive.listFolders(req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Owner sets the shared destination folder (existing id or a new name).
app.post('/api/drive/folder', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    const { folderId, name } = req.body;
    let folder;
    if (folderId) folder = await drive.getFolderMeta(req.user.id, folderId);
    else if (name) folder = await drive.ensureFolder(req.user.id, name);
    else return res.status(400).json({ error: 'Provide a folderId or a name' });
    users.setDriveFolder(req.user.id, folder.id, folder.name);
    res.json({ folder });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/drive/disconnect', session.requireAuth, session.requireOwner, (req, res) => {
  users.disconnectDrive(req.user.id);
  res.json({ ok: true });
});

/* ============================================================
   SPACE / MEMBERS  (shared library)
   ============================================================ */

app.get('/api/space', session.requireAuth, (req, res) => {
  const owner = users.get(req.space.ownerUserId);
  res.json({ space: spaces.publicView(req.space, req.user.id, owner) });
});

app.post('/api/space/members', session.requireAuth, session.requireOwner, (req, res) => {
  try {
    const { email } = req.body;
    if (String(email || '').toLowerCase() === String(req.user.email).toLowerCase()) {
      return res.status(400).json({ error: "You're already the owner of this library" });
    }
    const space = spaces.addMember(req.space.id, email);
    res.json({ space: spaces.publicView(space, req.user.id, req.user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/space/members', session.requireAuth, session.requireOwner, (req, res) => {
  const email = req.query.email || (req.body && req.body.email);
  const space = spaces.removeMember(req.space.id, email);
  res.json({ space: spaces.publicView(space, req.user.id, req.user) });
});

app.post('/api/space/rename', session.requireAuth, session.requireOwner, (req, res) => {
  const space = spaces.rename(req.space.id, req.body.name);
  res.json({ space: spaces.publicView(space, req.user.id, req.user) });
});

/* ============================================================
   SEARCH / METADATA  (auth-gated, stateless)
   ============================================================ */

app.get('/api/search', session.requireAuth, async (req, res) => {
  try {
    const { q, source } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });
    res.json(await searchEngine.search(q, source));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/magnet', session.requireAuth, async (req, res) => {
  try {
    const { provider, torrentUrl } = req.body;
    if (!provider || !torrentUrl) return res.status(400).json({ error: 'Missing provider or torrentUrl' });
    res.json({ magnet: await searchEngine.getMagnet(provider, torrentUrl) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/play', session.requireAuth, async (req, res) => {
  try {
    const { magnet, provider, torrentUrl, preview } = req.body;

    let finalMagnet = magnet;
    if (!finalMagnet && provider && torrentUrl) {
      finalMagnet = await searchEngine.getMagnet(provider, torrentUrl);
    }
    if (!finalMagnet) return res.status(400).json({ error: 'Missing magnet URI' });

    const infoHash = streamEngine.extractInfoHash(finalMagnet);
    if (!infoHash) return res.status(400).json({ error: 'Could not extract info hash from magnet' });

    if (!finalMagnet.includes('&tr=')) {
      finalMagnet += trackers.map(t => '&tr=' + encodeURIComponent(t)).join('');
    }

    const torrent = await streamEngine.getTorrent(finalMagnet);
    if (!torrent) throw new Error('Failed to add torrent');

    if (preview) {
      for (const file of torrent.files) { try { file.deselect(); } catch {} }
    }

    const files = torrent.files
      .map((f, i) => ({ originalIndex: i, name: f.name, size: f.length, ext: path.extname(f.name).toLowerCase() }))
      .filter(f => VIDEO_EXTS.includes(f.ext))
      .map(f => ({ index: f.originalIndex, name: f.name, size: f.size }));

    const firstFile = files[0];
    const storedId = queueManager.getDriveFileId(req.space.id, infoHash, firstFile?.name);
    const cached = storedId || cacheManager.getCached(infoHash);
    const streamUrl = `/stream/${infoHash}/file/${firstFile?.index ?? 0}/${encodeURIComponent(firstFile?.name || 'video')}`;

    res.json({
      infoHash, streamUrl, files,
      cached: !!cached,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   STREAMING  (Drive -> local -> torrent, in that order)
   ============================================================ */

app.get('/stream/:infoHash/file/:fileIndex/:filename', session.requireAuth, async (req, res) => {
  try {
    const { infoHash, fileIndex, filename } = req.params;
    const range = req.headers.range;
    const idx = parseInt(fileIndex, 10);

    // 1) Offloaded to the space's Drive? (served via the owner's connection)
    const driveFileId = queueManager.getDriveFileId(req.space.id, infoHash, filename);
    if (driveFileId) {
      console.log(`[stream] DRIVE: ${filename} (${infoHash.slice(0, 8)})`);
      return streamFromDrive(req.space.ownerUserId, driveFileId, range, res);
    }

    // 2) Still in local staging?
    const cached = cacheManager.getCached(infoHash, filename);
    if (cached) {
      console.log(`[stream] DISK: ${filename} (${infoHash.slice(0, 8)})`);
      cacheManager.touchCache(infoHash);
      return serveFromDisk(cached.filePath, range, res);
    }

    // 3) Live from the torrent swarm.
    console.log(`[stream] TORRENT: ${filename} (${infoHash.slice(0, 8)})`);
    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.status(404).json({ error: 'Torrent not found. File may not be cached yet.' });

    const torrent = await streamEngine.getTorrent(magnet, { fileIndex: idx });
    const { stream, fileSize, start, end, mimeType } = streamEngine.getFileStream(torrent, idx, range);

    streamEngine.incrementStreams(infoHash);
    res.on('close', () => { streamEngine.decrementStreams(infoHash); stream.destroy(); });

    const headers = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    };
    if (!range) headers['Content-Length'] = fileSize;
    res.writeHead(range ? 206 : 200, headers);
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

async function streamFromDrive(userId, fileId, range, res) {
  try {
    const upstream = await drive.getRangeStream(userId, fileId, range);
    const h = upstream.headers || {};
    const headers = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (h['content-type']) headers['Content-Type'] = h['content-type'];
    if (h['content-length']) headers['Content-Length'] = h['content-length'];
    if (h['content-range']) headers['Content-Range'] = h['content-range'];
    res.writeHead(upstream.status === 206 ? 206 : (range ? 206 : 200), headers);
    upstream.stream.on('error', () => { if (!res.headersSent) res.status(502).end(); res.destroy(); });
    res.on('close', () => upstream.stream.destroy());
    upstream.stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Drive stream failed: ' + err.message });
  }
}

function findActiveMagnet(infoHash) {
  const cacheEntry = cacheManager.getCached(infoHash);
  if (cacheEntry?.magnet) return cacheEntry.magnet;
  return streamEngine.getMagnet(infoHash);
}

function serveFromDisk(filePath, range, res) {
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Cached file not found on disk' });
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    let start = 0, end = fileSize - 1;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
    }
    const chunkSize = end - start + 1;
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' };
    const headers = {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Cache-Control': 'no-cache',
    };
    if (range) { headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`; res.writeHead(206, headers); }
    else res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); stream.destroy(); });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

/* ============================================================
   TORRENT FILE LISTING
   ============================================================ */

app.get('/api/torrent/:infoHash/files', session.requireAuth, async (req, res) => {
  try {
    const { infoHash } = req.params;

    const inMemory = streamEngine.getCachedFileList(infoHash);
    if (inMemory) return res.json({ files: inMemory, cached: false });

    const diskFiles = cacheManager.getCacheFiles().filter(f => f.infoHash === infoHash);
    if (diskFiles.length > 0) {
      const files = diskFiles.map(f => ({ index: f.fileIndex ?? 0, name: f.fileName, size: f.size, progress: f.verified ? 1 : 0 }));
      return res.json({ files, cached: true });
    }

    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.json({ files: [], cached: false });

    const torrent = await streamEngine.getTorrent(magnet);
    const files = torrent.files.map((f, i) => ({ index: i, name: f.name, size: f.length, progress: f.progress }));
    res.json({ files, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   QUEUE / LIBRARY  (per user)
   ============================================================ */

app.post('/api/queue', session.requireAuth, async (req, res) => {
  try {
    let { magnet, title, fileIndex, fileName, size, provider, torrentUrl } = req.body;
    if (!magnet && provider && torrentUrl) magnet = await searchEngine.getMagnet(provider, torrentUrl);
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const infoHash = streamEngine.extractInfoHash(magnet);
    if (!infoHash) return res.status(400).json({ error: 'Invalid magnet URI' });

    const owner = users.get(req.space.ownerUserId);
    queueManager.addItem(req.space.id, {
      infoHash, magnet, title: title || infoHash, fileIndex, fileName, size,
      driveFolderId: owner ? owner.driveFolderId : null,
    });

    const enhancedMagnet = magnet.includes('&tr=') ? magnet : magnet + trackers.map(t => '&tr=' + encodeURIComponent(t)).join('');
    const opts = (fileIndex !== undefined && fileIndex !== null) ? { fileIndex } : { selectAll: true };
    streamEngine.getTorrent(enhancedMagnet, opts).catch((e) => {
      queueManager.markError(req.space.id, infoHash, e.message);
    });

    res.json({ infoHash, queued: true, driveConnected: users.hasDriveConnection(req.space.ownerUserId) });
  } catch (err) {
    console.log('[queue] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue', session.requireAuth, (req, res) => {
  res.json({ items: queueManager.getItems(req.space.id) });
});

app.delete('/api/queue/:infoHash', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    const { infoHash } = req.params;
    if (req.query.deleteDrive === '1') {
      const items = queueManager.getItems(req.space.id).filter(i => i.infoHash === infoHash);
      const ids = new Set();
      for (const it of items) {
        if (it.driveFileId) ids.add(it.driveFileId);
        for (const id of Object.values(it.driveFiles || {})) ids.add(id);
      }
      for (const id of ids) await drive.deleteRemote(req.space.ownerUserId, id);
    }
    queueManager.removeItem(req.space.id, infoHash);
    // Only tear down the shared torrent if no other space still wants it.
    if (queueManager.entriesForHash(infoHash).length === 0) {
      cacheManager.removeFromCache(infoHash);
      streamEngine.destroyTorrent(infoHash);
    }
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   DOWNLOAD (to browser) — from Drive or local staging
   ============================================================ */

app.get('/api/download/:infoHash', session.requireAuth, async (req, res) => {
  try {
    const { infoHash } = req.params;
    const fileName = req.query.fileName || null;

    const driveFileId = queueManager.getDriveFileId(req.space.id, infoHash, fileName);
    if (driveFileId) {
      const upstream = await drive.getRangeStream(req.space.ownerUserId, driveFileId, null);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName || 'video')}"`);
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      return upstream.stream.pipe(res);
    }

    const cached = cacheManager.getCached(infoHash, fileName);
    if (!cached || !fs.existsSync(cached.filePath)) {
      return res.status(404).json({ error: 'File not available yet. Wait for download/upload to finish.' });
    }
    cacheManager.touchCache(infoHash);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(cached.filePath))}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const dlStream = fs.createReadStream(cached.filePath);
    dlStream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); dlStream.destroy(); });
    dlStream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   LIBRARY VIEW  (per user — replaces the old global cache list)
   ============================================================ */

app.get('/api/cache', session.requireAuth, (req, res) => {
  const items = queueManager.getItems(req.space.id);
  const files = items.map(it => ({
    infoHash: it.infoHash,
    fileName: it.fileName || it.title,
    fileIndex: it.fileIndex ?? null,
    size: it.size || 0,
    magnet: it.magnet || '',
    status: it.status,
    progress: it.progress || 0,
    inDrive: it.status === 'stored',
    verified: it.status === 'stored',
  }));
  const stored = files.filter(f => f.inDrive);
  const totalSize = stored.reduce((s, f) => s + (f.size || 0), 0);
  res.json({
    size: totalSize,
    sizeFormatted: formatBytes(totalSize),
    fileCount: stored.length,
    files,
  });
});

app.delete('/api/cache', session.requireAuth, session.requireOwner, async (req, res) => {
  const items = [...queueManager.getItems(req.space.id)];
  for (const it of items) {
    if (req.query.deleteDrive === '1' && it.driveFiles) {
      for (const id of Object.values(it.driveFiles)) await drive.deleteRemote(req.space.ownerUserId, id);
    }
    queueManager.removeItem(req.space.id, it.infoHash);
  }
  res.json({ cleared: true, removed: items.length });
});

app.get('/api/cache/partials', session.requireAuth, (req, res) => {
  try { res.json(streamEngine.getPartialsInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cache/partials', session.requireAuth, (req, res) => {
  try { res.json(streamEngine.cleanupPartials()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cache/:infoHash', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    const { infoHash } = req.params;
    const fileName = req.query.fileName || null;
    const item = queueManager.getItem(req.space.id, infoHash);
    if (item && req.query.deleteDrive === '1' && item.driveFiles) {
      for (const [name, id] of Object.entries(item.driveFiles)) {
        if (!fileName || name === fileName) await drive.deleteRemote(req.space.ownerUserId, id);
      }
    }
    queueManager.removeItem(req.space.id, infoHash, fileName);
    if (queueManager.entriesForHash(infoHash).length === 0) {
      cacheManager.removeFromCache(infoHash, fileName);
      streamEngine.destroyTorrent(infoHash);
    }
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

module.exports = app;
