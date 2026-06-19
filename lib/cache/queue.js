const fs = require('fs');
const path = require('path');
const config = require('../../config');

const QUEUE_FILE = 'queue.json';

let queue = [];
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 1000;

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

function writeQueue() {
  fs.writeFileSync(getQueuePath(), JSON.stringify(queue, null, 2));
}

function saveQueue() {
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      writeQueue();
    }, SAVE_DEBOUNCE_MS);
  }
}

function saveQueueNow() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  writeQueue();
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
    saveQueueNow();
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
    retries: 0,
    addedAt: Date.now(),
  };
  queue.unshift(item);
  saveQueueNow();
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
    saveQueueNow();
    return true;
  }
  return false;
}

function markError(infoHash, error) {
  const item = queue.find((q) => q.infoHash === infoHash);
  if (item) {
    item.status = 'error';
    item.error = error;
    saveQueueNow();
  }
}

function retryItem(infoHash) {
  const item = queue.find((q) => q.infoHash === infoHash);
  if (item) {
    item.retries = (item.retries || 0) + 1;
    item.status = 'downloading';
    item.error = null;
    saveQueueNow();
    return item;
  }
  return null;
}

function removeItem(infoHash) {
  const idx = queue.findIndex((q) => q.infoHash === infoHash);
  if (idx >= 0) {
    queue.splice(idx, 1);
    saveQueueNow();
    return true;
  }
  return false;
}

module.exports = { init, getItems, addItem, updateProgress, markCached, markError, retryItem, removeItem };
