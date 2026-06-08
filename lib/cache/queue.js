const fs = require('fs');
const path = require('path');
const config = require('../../config');

const QUEUE_FILE = 'queue.json';

let queue = [];

function init() {
  loadQueue();
}

function getQueuePath() {
  return path.join(config.cacheDir, QUEUE_FILE);
}

function loadQueue() {
  try {
    const raw = fs.readFileSync(getQueuePath(), 'utf8');
    queue = JSON.parse(raw);
    if (!Array.isArray(queue)) queue = [];
  } catch {
    queue = [];
  }
}

function saveQueue() {
  fs.writeFileSync(getQueuePath(), JSON.stringify(queue, null, 2));
}

function getItems() {
  return queue;
}

function addItem(infoHash, magnet, title, fileIndex, fileName) {
  const existing = queue.find((q) => q.infoHash === infoHash);
  if (existing) {
    existing.magnet = existing.magnet || magnet;
    existing.title = existing.title || title;
    existing.fileIndex = existing.fileIndex ?? fileIndex;
    existing.fileName = existing.fileName || fileName;
    saveQueue();
    return existing;
  }

  const item = {
    infoHash,
    magnet,
    title,
    fileIndex: fileIndex ?? null,
    fileName: fileName || null,
    status: 'downloading',
    progress: 0,
    addedAt: Date.now(),
  };
  queue.unshift(item);
  saveQueue();
  return item;
}

function updateProgress(infoHash, progress) {
  const item = queue.find((q) => q.infoHash === infoHash);
  if (item) {
    item.progress = Math.min(100, Math.max(0, progress));
    if (item.progress >= 100) item.status = 'cached';
    saveQueue();
  }
}

function markCached(infoHash) {
  const item = queue.find((q) => q.infoHash === infoHash);
  if (item) {
    item.status = 'cached';
    item.progress = 100;
    saveQueue();
    return true;
  }
  return false;
}

function markError(infoHash, error) {
  const item = queue.find((q) => q.infoHash === infoHash);
  if (item) {
    item.status = 'error';
    item.error = error;
    saveQueue();
  }
}

function removeItem(infoHash) {
  const idx = queue.findIndex((q) => q.infoHash === infoHash);
  if (idx >= 0) {
    queue.splice(idx, 1);
    saveQueue();
    return true;
  }
  return false;
}

module.exports = { init, getItems, addItem, updateProgress, markCached, markError, removeItem };
