const path = require('path');
const config = require('../../config');
const { createStore, ensureDir } = require('../store/jsonStore');

/**
 * Per-user download/library store. Each user's items live in
 * data/queue/<userId>.json. An item tracks a download through its whole
 * lifecycle: torrent -> local staging -> Google Drive.
 *
 * status: 'downloading' | 'uploading' | 'stored' | 'error'
 *   downloading — pulling from the swarm to local disk
 *   uploading   — local file complete, being pushed to the user's Drive
 *   stored      — verified in Drive; local copy may have been freed
 *   error       — something failed (see item.error)
 */

const QUEUE_DIR = path.join(config.dataDir, 'queue');
const stores = new Map(); // userId -> store

function init() {
  ensureDir(QUEUE_DIR);
}

function storeFor(userId) {
  if (!stores.has(userId)) {
    stores.set(userId, createStore(path.join(QUEUE_DIR, `${userId}.json`), { items: [] }));
  }
  return stores.get(userId);
}

function knownUserIds() {
  // union of already-loaded stores and any persisted files on disk
  const ids = new Set(stores.keys());
  try {
    const fs = require('fs');
    for (const f of fs.readdirSync(QUEUE_DIR)) {
      if (f.endsWith('.json')) ids.add(f.slice(0, -5));
    }
  } catch {}
  return [...ids];
}

function getItems(userId) {
  return storeFor(userId).data.items;
}

/**
 * A torrent can back several queue items sharing one infoHash (one per file,
 * e.g. a season pack). When fileName is given, prefer the item that actually
 * owns that file; otherwise fall back to the first match (legacy/whole-torrent
 * callers).
 */
function getItem(userId, infoHash, fileName) {
  const items = getItems(userId).filter(q => q.infoHash === infoHash);
  if (fileName === undefined) return items[0] || null;
  return (
    items.find(q => q.fileName === fileName) ||
    items.find(q => q.fileIndex === null || q.fileIndex === undefined) ||
    items[0] ||
    null
  );
}

function addItem(userId, { infoHash, magnet, title, fileIndex, fileName, size, driveFolderId }) {
  const s = storeFor(userId);
  const existing = s.data.items.find(q => q.infoHash === infoHash && (q.fileName || null) === (fileName || null));
  if (existing) {
    existing.magnet = existing.magnet || magnet;
    existing.title = existing.title || title;
    existing.fileIndex = existing.fileIndex ?? fileIndex;
    existing.size = existing.size || size || 0;
    s.saveNow();
    return existing;
  }
  const item = {
    infoHash,
    magnet,
    title: title || infoHash,
    fileIndex: fileIndex ?? null,
    fileName: fileName || null,
    size: size || 0,
    status: 'downloading',
    progress: 0,
    driveFileId: null,            // convenience: last/primary stored file
    driveFiles: {},               // { [fileName]: driveFileId } — for multi-file torrents
    driveFolderId: driveFolderId || null,
    error: null,
    addedAt: Date.now(),
  };
  s.data.items.unshift(item);
  s.saveNow();
  return item;
}

function removeItem(userId, infoHash, fileName) {
  const s = storeFor(userId);
  const before = s.data.items.length;
  s.data.items = s.data.items.filter(q =>
    !(q.infoHash === infoHash && (!fileName || (q.fileName || null) === fileName)));
  if (s.data.items.length !== before) s.saveNow();
  return before !== s.data.items.length;
}

// ---- per-user mutations ----
function setStatus(userId, infoHash, status, extra = {}, fileName) {
  const item = getItem(userId, infoHash, fileName);
  if (!item) return null;
  item.status = status;
  Object.assign(item, extra);
  storeFor(userId).saveNow();
  return item;
}

function markUploading(userId, infoHash, fileName) {
  return setStatus(userId, infoHash, 'uploading', {}, fileName);
}

/** Record that one file of a torrent is now verified in Drive. */
function recordStoredFile(userId, infoHash, fileName, driveFileId) {
  const item = getItem(userId, infoHash, fileName);
  if (!item) return null;
  if (!item.driveFiles) item.driveFiles = {};
  if (fileName) item.driveFiles[fileName] = driveFileId;
  item.driveFileId = driveFileId;
  item.error = null;
  // Single-file entries are fully "stored" once their file lands; whole-torrent
  // entries are marked stored too (files continue to arrive in the same folder).
  item.status = 'stored';
  storeFor(userId).saveNow();
  return item;
}

/** Resolve the Drive file id for a specific file name within a torrent. */
function getDriveFileId(userId, infoHash, fileName) {
  for (const item of getItems(userId)) {
    if (item.infoHash !== infoHash) continue;
    if (item.driveFiles && fileName && item.driveFiles[fileName]) return item.driveFiles[fileName];
    if (item.driveFileId && (!fileName || item.fileName === fileName)) return item.driveFileId;
  }
  return null;
}

function markError(userId, infoHash, error, fileName) {
  return setStatus(userId, infoHash, 'error', { error: String(error || 'Unknown error') }, fileName);
}

// ---- cross-user helpers (engine works per-infoHash; uploads per-user) ----
function entriesForHash(infoHash) {
  const out = [];
  for (const uid of knownUserIds()) {
    for (const item of getItems(uid)) {
      if (item.infoHash === infoHash) out.push({ userId: uid, item });
    }
  }
  return out;
}

function updateProgressByHash(infoHash, pct) {
  const p = Math.min(100, Math.max(0, pct));
  for (const { userId, item } of entriesForHash(infoHash)) {
    if (item.status === 'downloading') {
      item.progress = p;
      storeFor(userId).save();
    }
  }
}

function markErrorByHash(infoHash, error) {
  for (const { userId, item } of entriesForHash(infoHash)) {
    if (item.status === 'downloading' || item.status === 'uploading') {
      item.status = 'error';
      item.error = String(error || 'Unknown error');
      storeFor(userId).saveNow();
    }
  }
}

/** Downloads that should resume on boot (one torrent may back several users). */
function allDownloading() {
  const out = [];
  for (const uid of knownUserIds()) {
    for (const item of getItems(uid)) {
      if (item.status === 'downloading' && item.magnet) out.push({ userId: uid, item });
    }
  }
  return out;
}

module.exports = {
  init, getItems, getItem, addItem, removeItem,
  setStatus, markUploading, recordStoredFile, getDriveFileId, markError,
  entriesForHash, updateProgressByHash, markErrorByHash, allDownloading,
};
