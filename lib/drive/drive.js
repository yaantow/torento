const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const oauth = require('../auth/oauth');
const config = require('../../config');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MIME = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};
function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/** Drive v3 client authorized as the given user, or null if not connected. */
function driveFor(userId) {
  const auth = oauth.authorizedClient(userId);
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

function escapeName(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Find (by name, app-created) or create the destination folder. */
async function ensureFolder(userId, name) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeName(name)}' and trashed=false`;
  const res = await drive.files.list({
    q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive',
  });
  if (res.data.files && res.data.files.length) {
    return { id: res.data.files[0].id, name: res.data.files[0].name };
  }
  return createFolder(userId, name);
}

async function createFolder(userId, name, parentId) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id,name',
  });
  return { id: res.data.id, name: res.data.name };
}

/** Folders the app can see (drive.file scope → app-created only). */
async function listFolders(userId) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name)', pageSize: 100, orderBy: 'name', spaces: 'drive',
  });
  return res.data.files || [];
}

/** Confirm the app can access a folder id (e.g. one chosen via the Picker). */
async function getFolderMeta(userId, folderId) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType' });
  if (res.data.mimeType !== FOLDER_MIME) throw new Error('Selected item is not a folder');
  return { id: res.data.id, name: res.data.name };
}

/**
 * Upload a local file into the user's folder. Streams from disk; googleapis
 * performs a resumable upload for large media. Returns { id, name, size }.
 */
async function uploadFile(userId, { localPath, name, folderId }) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.create({
    requestBody: { name, ...(folderId ? { parents: [folderId] } : {}) },
    media: { mimeType: mimeFor(name), body: fs.createReadStream(localPath) },
    fields: 'id,name,size',
  }, {
    // resumable upload with modest retry on transient failures
    retry: true,
  });
  return { id: res.data.id, name: res.data.name, size: Number(res.data.size) || 0 };
}

/** Fetch a file's byte size via a lightweight metadata call. */
async function getFileSize(userId, fileId) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.get({ fileId, fields: 'size' });
  return Number(res.data.size) || 0;
}

/** Verify an uploaded file exists and matches the expected byte size. */
async function verifyRemote(userId, fileId, expectedSize) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.get({ fileId, fields: 'id,size,trashed' });
  if (res.data.trashed) return false;
  const size = Number(res.data.size) || 0;
  if (expectedSize && size !== Number(expectedSize)) return false;
  return true;
}

/**
 * Ranged read of a Drive file for playback. Returns the upstream stream plus
 * its status and headers (Content-Range / Content-Length / Content-Type),
 * so the caller can relay a proper 206 to the browser.
 */
async function getRangeStream(userId, fileId, range) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream', headers: range ? { Range: range } : {} }
  );
  return { stream: res.data, status: res.status, headers: res.headers };
}

async function deleteRemote(userId, fileId) {
  const drive = driveFor(userId);
  if (!drive) return;
  try { await drive.files.delete({ fileId }); } catch {}
}

/** Best-effort account/storage summary for the UI. */
async function getStorageInfo(userId) {
  const drive = driveFor(userId);
  if (!drive) return null;
  try {
    const res = await drive.about.get({ fields: 'storageQuota,user' });
    return { quota: res.data.storageQuota, user: res.data.user };
  } catch {
    return null;
  }
}

/**
 * Actually exercises the stored refresh token against Google, rather than
 * just checking one is saved. A saved token can still be dead (revoked,
 * expired, evicted by Google's per-client token cap) — this is how the UI
 * tells "Connected" from "looks connected but every upload is failing".
 */
async function checkConnection(userId) {
  const drive = driveFor(userId);
  if (!drive) return { ok: false, error: 'Google Drive is not connected' };
  try {
    await drive.about.get({ fields: 'user' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error_description || err.message };
  }
}

/** All non-folder files sitting directly in a Drive folder (for reconciling with our own records). */
async function listAllFiles(userId, folderId) {
  const drive = driveFor(userId);
  if (!drive) throw new Error('Google Drive is not connected');
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`,
      fields: 'nextPageToken, files(id,name,size)',
      pageSize: 200,
      spaces: 'drive',
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

module.exports = {
  driveFor, ensureFolder, createFolder, listFolders, getFolderMeta,
  uploadFile, verifyRemote, getFileSize, getRangeStream, deleteRemote, getStorageInfo,
  checkConnection, listAllFiles,
  defaultFolderName: () => config.drive.defaultFolder,
};
