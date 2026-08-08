const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cacheManager = require('./lib/cache/manager');
const queueManager = require('./lib/cache/queue');
const streamEngine = require('./lib/stream/engine');
const transcode = require('./lib/stream/transcode');
const searchEngine = require('./lib/search');
const trackers = require('./lib/search/trackers');
const VIDEO_EXTS = require('./lib/videoExts');
const subtitles = require('./lib/subtitles');
const opensubtitles = require('./lib/opensubtitles');

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

// Client-side <video> playback errors were previously invisible server-side.
app.post('/api/client-error', session.requireAuth, (req, res) => {
  const { message, code, src } = req.body || {};
  console.log(`[client-error] ${req.user?.email || 'unknown'}: ${message} (code=${code}) src=${src}`);
  res.json({ ok: true });
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
  let tokenValid = false;
  let tokenError = null;
  if (connected) {
    const check = await drive.checkConnection(ownerId);
    tokenValid = check.ok;
    tokenError = check.ok ? null : check.error;
    if (tokenValid && isOwner) storage = await drive.getStorageInfo(ownerId);
  }
  res.json({
    connected,
    tokenValid,
    tokenError,
    isOwner,
    sharedBy: isOwner ? null : (owner ? (owner.name || owner.email) : null),
    folder: owner && owner.driveFolderId ? { id: owner.driveFolderId, name: owner.driveFolderName } : null,
    defaultFolderName: drive.defaultFolderName(),
    pickerEnabled: !!config.drive.pickerApiKey,
    storage,
  });
});

/**
 * Files that physically exist in the owner's Drive folder but aren't tracked
 * in this space's queue — e.g. items whose "Remove from library" delete only
 * ever cleared our own record (deleteDrive wasn't passed), leaving the file
 * orphaned in Drive with the app none the wiser.
 */
app.get('/api/drive/reconcile', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    const owner = users.get(req.space.ownerUserId);
    if (!owner || !owner.driveFolderId) return res.json({ orphaned: [] });
    const driveFiles = await drive.listAllFiles(req.space.ownerUserId, owner.driveFolderId);
    const known = new Set();
    for (const it of queueManager.getItems(req.space.id)) {
      if (it.driveFileId) known.add(it.driveFileId);
      for (const id of Object.values(it.driveFiles || {})) known.add(id);
    }
    const orphaned = driveFiles
      .filter(f => !known.has(f.id) && Number(f.size) > 0) // skip 0-byte artifacts from failed uploads
      .map(f => ({ id: f.id, name: f.name, size: Number(f.size) || 0 }));
    res.json({ orphaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Re-adds orphaned Drive files to the library as already-'stored' items. */
app.post('/api/drive/reconcile', session.requireAuth, session.requireOwner, async (req, res) => {
  try {
    const { fileIds } = req.body || {};
    const owner = users.get(req.space.ownerUserId);
    if (!owner || !owner.driveFolderId) return res.status(400).json({ error: 'No Drive folder set' });
    const driveFiles = await drive.listAllFiles(req.space.ownerUserId, owner.driveFolderId);
    const known = new Set();
    for (const it of queueManager.getItems(req.space.id)) {
      if (it.driveFileId) known.add(it.driveFileId);
      for (const id of Object.values(it.driveFiles || {})) known.add(id);
    }
    const wanted = Array.isArray(fileIds) && fileIds.length ? new Set(fileIds) : null;

    let imported = 0;
    for (const f of driveFiles) {
      if (known.has(f.id)) continue;
      if (Number(f.size) <= 0) continue; // skip 0-byte artifacts from failed uploads
      if (wanted && !wanted.has(f.id)) continue;
      const infoHash = `drive:${f.id}`;
      queueManager.addItem(req.space.id, {
        infoHash, magnet: '', title: f.name, fileIndex: null, fileName: f.name,
        size: Number(f.size) || 0, driveFolderId: owner.driveFolderId,
      });
      queueManager.recordStoredFile(req.space.id, infoHash, f.name, f.id);
      imported++;
    }
    res.json({ imported });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// Transcoding needs ffmpeg/ffprobe to read the source reliably. Routing that
// through an HTTP range proxy in front of Drive turned out to be fragile —
// ffmpeg's http protocol didn't reliably keep requesting beyond the first
// buffered window. Downloading straight to local disk first sidesteps all of
// that: it's the exact same plain `drive.getRangeStream(..., null)` full
// download already proven by the working "download" feature, and ffmpeg then
// only ever touches a local file, same as local-cache playback already does.
const TRANSCODE_SRC_DIR = path.join(config.cacheDir, '.transcode-src');
try { fs.rmSync(TRANSCODE_SRC_DIR, { recursive: true, force: true }); } catch {}
fs.mkdirSync(TRANSCODE_SRC_DIR, { recursive: true });

async function downloadToTemp(userId, fileId, destPath) {
  const upstream = await drive.getRangeStream(userId, fileId, null);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    upstream.stream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    upstream.stream.pipe(ws);
  });
}

// Probing only needs to see codec info near the start of the file, so a
// small prefix is enough — full duration accuracy isn't needed since the
// rendered output is a real, fully-seekable file once it exists.
async function probeSource(source, filename) {
  if (source.kind === 'disk') return transcode.probe(source.filePath);
  const prefixPath = path.join(TRANSCODE_SRC_DIR, `probe-${crypto.randomBytes(8).toString('hex')}${path.extname(filename)}`);
  try {
    const upstream = await drive.getRangeStream(source.userId, source.fileId, 'bytes=0-5242879');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(prefixPath);
      upstream.stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      upstream.stream.pipe(ws);
    });
    return await transcode.probe(prefixPath);
  } finally {
    try { fs.unlinkSync(prefixPath); } catch {}
  }
}

// Codec/container plan per (infoHash, filename) — probing is a network
// round trip, so we only do it once per file and reuse the answer.
const transcodePlanCache = new Map();

function planFor(source, infoHash, filename) {
  const key = `${infoHash}:${filename}`;
  let entry = transcodePlanCache.get(key);
  if (!entry) {
    const ext = path.extname(filename).toLowerCase();
    entry = probeSource(source, filename)
      .then((probeResult) => transcode.planFor(probeResult, ext))
      .catch((e) => {
        console.log(`[transcode] probe failed for "${filename}", falling back to passthrough:`, e.message);
        return { mode: 'passthrough' };
      });
    transcodePlanCache.set(key, entry);
    entry.then((resolved) => transcodePlanCache.set(key, Promise.resolve(resolved)));
  }
  return Promise.resolve(entry);
}

// Rendered files are real, complete, faststart MP4s — cached on disk keyed
// by (infoHash, filename) so repeat plays/seeks of the same episode don't
// re-render. Bounded and swept periodically since this box is disk-tight.
const TRANSCODE_DIR = path.join(config.cacheDir, '.transcoded');
try { fs.rmSync(TRANSCODE_DIR, { recursive: true, force: true }); } catch {}
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
const renderedFiles = new Map(); // key -> { promise, path, lastAccessed }
const MAX_RENDERED = 3;

function renderKey(infoHash, filename) {
  return crypto.createHash('sha1').update(`${infoHash}:${filename}`).digest('hex');
}

async function getOrRenderTranscoded(source, plan, infoHash, filename) {
  const key = renderKey(infoHash, filename);
  let entry = renderedFiles.get(key);
  if (entry) {
    entry.lastAccessed = Date.now();
    return entry.promise;
  }

  evictOldRenders();
  const outputPath = path.join(TRANSCODE_DIR, `${key}.mp4`);
  const startedAt = Date.now();
  const promise = (async () => {
    let inputPath = source.filePath;
    let srcTempPath = null;
    if (source.kind === 'drive') {
      srcTempPath = path.join(TRANSCODE_SRC_DIR, `${key}${path.extname(filename)}`);
      console.log(`[transcode] downloading "${filename}" for rendering...`);
      await downloadToTemp(source.userId, source.fileId, srcTempPath);
      inputPath = srcTempPath;
    }
    try {
      console.log(`[transcode] rendering "${filename}" (${plan.mode})...`);
      await transcode.renderToFile({ inputUrl: inputPath, outputPath, plan });
      console.log(`[transcode] rendered "${filename}" in ${Date.now() - startedAt}ms`);
      return outputPath;
    } finally {
      if (srcTempPath) { try { fs.unlinkSync(srcTempPath); } catch {} }
    }
  })().catch((err) => {
    renderedFiles.delete(key);
    console.log(`[transcode] render failed for "${filename}":`, err.message);
    throw err;
  });
  entry = { promise, path: outputPath, lastAccessed: Date.now() };
  renderedFiles.set(key, entry);
  return promise;
}

function evictOldRenders() {
  if (renderedFiles.size < MAX_RENDERED) return;
  const entries = [...renderedFiles.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
  const [oldestKey, oldest] = entries[0];
  renderedFiles.delete(oldestKey);
  oldest.promise.then((p) => { try { fs.unlinkSync(p); } catch {} }).catch(() => {});
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, entry] of renderedFiles) {
    if (entry.lastAccessed < cutoff) {
      renderedFiles.delete(key);
      entry.promise.then((p) => { try { fs.unlinkSync(p); } catch {} }).catch(() => {});
    }
  }
}, 15 * 60 * 1000);

app.get('/stream/:infoHash/file/:fileIndex/:filename', session.requireAuth, async (req, res) => {
  try {
    const { infoHash, fileIndex, filename } = req.params;
    const range = req.headers.range;
    const idx = parseInt(fileIndex, 10);

    // 1) Offloaded to the space's Drive? (served via the owner's connection)
    const driveFileId = queueManager.getDriveFileId(req.space.id, infoHash, filename);
    // 2) Still in local staging?
    const cached = !driveFileId ? cacheManager.getCached(infoHash, filename) : null;

    if (driveFileId || cached) {
      const queueItem = driveFileId ? queueManager.getItem(req.space.id, infoHash, filename) : null;
      const source = driveFileId
        ? { kind: 'drive', userId: req.space.ownerUserId, fileId: driveFileId, totalSize: queueItem?.size || null }
        : { kind: 'disk', filePath: cached.filePath };
      if (cached) cacheManager.touchCache(infoHash);
      console.log(`[stream] ${driveFileId ? 'DRIVE' : 'DISK'}: ${filename} (${infoHash.slice(0, 8)})`);

      const plan = await planFor(source, infoHash, filename);
      if (plan.mode && plan.mode !== 'passthrough') {
        const renderedPath = await getOrRenderTranscoded(source, plan, infoHash, filename);
        return serveFromDisk(renderedPath, range, res);
      }

      if (driveFileId) return streamFromDrive(req.space.ownerUserId, driveFileId, queueItem?.size || null, range, res);
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

async function streamFromDrive(userId, fileId, knownSize, range, res) {
  const startedAt = Date.now();
  try {
    // googleapis doesn't surface response headers for streamed media (they
    // come back {}), so Content-Range/Content-Length can't be read off the
    // upstream response — build them ourselves from the range we asked for
    // and the file's known size (from the queue record, or a metadata call).
    const totalSize = knownSize || await drive.getFileSize(userId, fileId);
    let start = 0, end = totalSize - 1;
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), totalSize - 1);
    }

    const upstream = await drive.getRangeStream(userId, fileId, `bytes=${start}-${end}`);
    console.log(`[drive] first byte in ${Date.now() - startedAt}ms (${fileId.slice(0, 8)})`);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Content-Length': end - start + 1,
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    res.writeHead(range ? 206 : 200, headers);
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

// Bundled subtitle files (.srt/.vtt) that shipped alongside the video in the
// torrent. Only available while the torrent is live in the swarm — sibling
// subtitles aren't persisted to disk/Drive the way video files are, so this
// won't help for a resumed item whose torrent has since been evicted.
app.get('/subtitle/:infoHash/file/:fileIndex', session.requireAuth, async (req, res) => {
  try {
    const { infoHash, fileIndex } = req.params;
    const idx = parseInt(fileIndex, 10);

    const magnet = findActiveMagnet(infoHash);
    if (!magnet) return res.status(404).json({ error: 'Torrent not active' });

    const torrent = await streamEngine.getTorrent(magnet);
    const file = torrent.files[idx];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(file.name).toLowerCase();
    if (!subtitles.SUBTITLE_EXTS.includes(ext)) return res.status(400).json({ error: 'Not a subtitle file' });

    // Streaming a video file explicitly deselects every other file (see
    // getTorrent's fileToKeep logic) to avoid downloading the whole torrent —
    // re-select this one so its pieces actually come in.
    file.select();

    const chunks = [];
    const stream = file.createReadStream();
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.send(subtitles.toVtt(text, ext));
    });
    stream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Online subtitle search/download (OpenSubtitles). Free-tier keys are rate-
// limited, so the fetch route only spends a download credit when the user
// actually picks a result, not while browsing search results.
app.get('/api/subtitles/search', session.requireAuth, async (req, res) => {
  try {
    const { query, language } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    const results = await opensubtitles.search(query, { languages: language || 'en' });
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/subtitles/download/:fileId', session.requireAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { text, fileName } = await opensubtitles.download(fileId);
    const ext = path.extname(fileName).toLowerCase() || '.srt';
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.send(subtitles.toVtt(text, ext));
  } catch (err) {
    res.status(502).json({ error: err.message });
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
  const items = queueManager.getItems(req.space.id).map(it => ({
    ...it,
    hasLocal: !!cacheManager.getCached(it.infoHash, it.fileName),
  }));
  res.json({ items });
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
    hasLocal: !!cacheManager.getCached(it.infoHash, it.fileName),
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
