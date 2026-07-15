const fs = require('fs');
const drive = require('./drive');
const users = require('../auth/users');
const spaces = require('../auth/spaces');
const queue = require('../cache/queue');
const cacheManager = require('../cache/manager');

const MAX_CONCURRENT = 2;
let active = 0;
const pending = [];           // tasks: { spaceId, infoHash, file }
const inFlight = new Set();    // `${spaceId}:${infoHash}:${fileName}`

function key(spaceId, infoHash, fileName) { return `${spaceId}:${infoHash}:${fileName}`; }

/**
 * Called by the torrent engine when a video file finishes writing locally.
 * The queue is keyed by space; each interested space uploads to its owner's
 * Drive folder using the owner's connection.
 */
function handleFileReady(infoHash, file) {
  for (const { userId: spaceId, item } of queue.entriesForHash(infoHash)) {
    if (!wantsFile(item, file)) continue;
    if (item.status === 'stored' && item.driveFiles && item.driveFiles[file.fileName]) continue;
    const k = key(spaceId, infoHash, file.fileName);
    if (inFlight.has(k)) continue;
    inFlight.add(k);
    pending.push({ spaceId, infoHash, file });
  }
  drain();
}

function wantsFile(item, file) {
  if (item.fileIndex === null || item.fileIndex === undefined) return true; // whole-torrent
  if (item.fileName && item.fileName === file.fileName) return true;
  return item.fileIndex === file.fileIndex;
}

function drain() {
  while (active < MAX_CONCURRENT && pending.length) {
    const task = pending.shift();
    active++;
    runTask(task).catch(() => {}).finally(() => {
      active--;
      inFlight.delete(key(task.spaceId, task.infoHash, task.file.fileName));
      drain();
    });
  }
}

async function runTask({ spaceId, infoHash, file }) {
  const space = spaces.get(spaceId);
  if (!space) return;
  const ownerId = space.ownerUserId;
  const owner = users.get(ownerId);

  if (!owner || !users.hasDriveConnection(ownerId)) {
    queue.markError(spaceId, infoHash, 'The library owner has not connected Google Drive yet.', file.fileName);
    return;
  }

  const cached = cacheManager.getCached(infoHash, file.fileName);
  const localPath = cached?.filePath || file.localPath;
  if (!localPath || !fs.existsSync(localPath)) {
    queue.markError(spaceId, infoHash, 'Local file disappeared before upload.', file.fileName);
    return;
  }

  try {
    queue.markUploading(spaceId, infoHash, file.fileName);

    let folderId = owner.driveFolderId;
    if (!folderId) {
      const folder = await drive.ensureFolder(ownerId, drive.defaultFolderName());
      users.setDriveFolder(ownerId, folder.id, folder.name);
      folderId = folder.id;
    }

    const uploaded = await drive.uploadFile(ownerId, { localPath, name: file.fileName, folderId });
    const ok = await drive.verifyRemote(ownerId, uploaded.id, cached?.size || file.size);
    if (!ok) throw new Error('Uploaded file failed size verification');

    queue.recordStoredFile(spaceId, infoHash, file.fileName, uploaded.id);
    console.log(`[drive] Stored "${file.fileName}" for space ${spaceId.slice(0, 10)} (${infoHash.slice(0, 8)})`);

    maybeFreeLocal(infoHash, file);
  } catch (err) {
    queue.markError(spaceId, infoHash, err.message, file.fileName);
    console.log(`[drive] Upload failed (${spaceId.slice(0, 10)}): ${err.message}`);
  }
}

/**
 * Offload: once every interested space's copy is in Drive (or errored), and
 * nothing is actively streaming it, delete the local file to free disk.
 */
function maybeFreeLocal(infoHash, file) {
  const engine = require('../stream/engine');
  const interested = queue.entriesForHash(infoHash).filter(e => wantsFile(e.item, file));
  const allSettled = interested.every(e => e.item.status === 'stored' || e.item.status === 'error');
  const stored = interested.some(e => e.item.status === 'stored');

  if (!allSettled || !stored) return;
  if (engine.getActiveStreamCount && engine.getActiveStreamCount(infoHash) > 0) return;

  cacheManager.removeFromCache(infoHash, file.fileName);
  console.log(`[drive] Freed local copy of "${file.fileName}" (${infoHash.slice(0, 8)})`);
}

/** On boot, retry anything left in local staging that never reached Drive. */
function resumePending() {
  try {
    for (const cf of cacheManager.getCacheFiles()) {
      if (!cf.verified) continue;
      handleFileReady(cf.infoHash, {
        fileName: cf.fileName,
        fileIndex: cf.fileIndex ?? null,
        size: cf.size,
        localPath: null,
      });
    }
  } catch {}
}

module.exports = { handleFileReady, resumePending };
