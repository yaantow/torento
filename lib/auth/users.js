const path = require('path');
const config = require('../../config');
const { createStore } = require('../store/jsonStore');
const { encrypt, decrypt } = require('./crypto');

// { users: { [userId]: { id, email, name, picture, refreshTokenEnc,
//   driveFolderId, driveFolderName, createdAt, updatedAt } } }
const store = createStore(path.join(config.dataDir, 'users.json'), { users: {} });

function get(userId) {
  return store.data.users[userId] || null;
}

function getByEmail(email) {
  const e = String(email || '').toLowerCase();
  return Object.values(store.data.users).find(u => u.email === e) || null;
}

/**
 * Create or update a user from a verified Google profile.
 * Only overwrites the stored refresh token when Google hands us a new one
 * (Google omits it on re-consent unless prompt=consent + access_type=offline).
 */
function upsert(profile, refreshToken) {
  const now = Date.now();
  const existing = store.data.users[profile.id] || {};
  const user = {
    id: profile.id,
    email: String(profile.email || '').toLowerCase(),
    name: profile.name || existing.name || '',
    picture: profile.picture || existing.picture || '',
    refreshTokenEnc: refreshToken ? encrypt(refreshToken) : (existing.refreshTokenEnc || null),
    driveFolderId: existing.driveFolderId || null,
    driveFolderName: existing.driveFolderName || null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  store.data.users[profile.id] = user;
  store.saveNow();
  return user;
}

function getRefreshToken(userId) {
  const u = get(userId);
  if (!u || !u.refreshTokenEnc) return null;
  try { return decrypt(u.refreshTokenEnc); } catch { return null; }
}

function hasDriveConnection(userId) {
  return !!getRefreshToken(userId);
}

function setDriveFolder(userId, folderId, folderName) {
  const u = get(userId);
  if (!u) return null;
  u.driveFolderId = folderId;
  u.driveFolderName = folderName;
  u.updatedAt = Date.now();
  store.saveNow();
  return u;
}

function disconnectDrive(userId) {
  const u = get(userId);
  if (!u) return;
  u.refreshTokenEnc = null;
  u.driveFolderId = null;
  u.driveFolderName = null;
  u.updatedAt = Date.now();
  store.saveNow();
}

/** Public-safe view (never leaks tokens). */
function publicView(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    driveConnected: !!user.refreshTokenEnc,
    driveFolderId: user.driveFolderId || null,
    driveFolderName: user.driveFolderName || null,
  };
}

function allUserIds() {
  return Object.keys(store.data.users);
}

module.exports = {
  get, getByEmail, upsert, getRefreshToken, hasDriveConnection,
  setDriveFolder, disconnectDrive, publicView, allUserIds,
};
