const crypto = require('crypto');
const path = require('path');
const config = require('../../config');
const { createStore } = require('../store/jsonStore');

/**
 * A "space" is a shared library backed by ONE owner's Google Drive folder.
 * The owner connects Drive (token + folder live on their user record); invited
 * members ride on the owner's connection — they sign in only for identity and
 * share the same library. Library/queue data is keyed by space id, so everyone
 * in a space sees the same collection.
 *
 * space = { id, name, ownerUserId, memberEmails[], memberUserIds[], createdAt }
 */

const store = createStore(path.join(config.dataDir, 'spaces.json'), { spaces: {} });

function list() { return Object.values(store.data.spaces); }
function get(id) { return store.data.spaces[id] || null; }
function findByOwner(userId) { return list().find(s => s.ownerUserId === userId) || null; }

function createSpace(ownerUser) {
  const id = 'sp_' + crypto.randomBytes(8).toString('hex');
  const space = {
    id,
    name: (ownerUser.name ? `${ownerUser.name.split(' ')[0]}'s Library` : 'Shared Library'),
    ownerUserId: ownerUser.id,
    memberEmails: [],
    memberUserIds: [],
    createdAt: Date.now(),
  };
  store.data.spaces[id] = space;
  store.saveNow();
  return space;
}

/**
 * Which space does this user belong to right now?
 *  1. If invited by email to someone else's space -> join it (invited wins).
 *  2. Else if they own a space -> that one.
 *  3. Else create their personal space (they become its owner).
 */
function resolveSpace(user) {
  const email = String(user.email || '').toLowerCase();
  const invited = list().find(s => s.ownerUserId !== user.id && s.memberEmails.includes(email));
  if (invited) {
    if (!invited.memberUserIds.includes(user.id)) {
      invited.memberUserIds.push(user.id);
      store.saveNow();
    }
    return invited;
  }
  return findByOwner(user.id) || createSpace(user);
}

function isOwner(space, userId) { return space && space.ownerUserId === userId; }

/** Is this email invited to any space? (lets invitees bypass ALLOWED_EMAILS) */
function isInvitedEmail(email) {
  const e = String(email || '').toLowerCase();
  return list().some(s => s.memberEmails.includes(e));
}

function addMember(spaceId, email) {
  const space = get(spaceId);
  if (!space) return null;
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address');
  if (e === '') return space;
  if (!space.memberEmails.includes(e)) {
    space.memberEmails.push(e);
    store.saveNow();
  }
  return space;
}

function removeMember(spaceId, email) {
  const space = get(spaceId);
  if (!space) return null;
  const e = String(email || '').trim().toLowerCase();
  space.memberEmails = space.memberEmails.filter(m => m !== e);
  // Drop the cached userId link too; that user re-resolves to their own space.
  const users = require('./users');
  space.memberUserIds = space.memberUserIds.filter(uid => {
    const u = users.get(uid);
    return u && String(u.email).toLowerCase() !== e;
  });
  store.saveNow();
  return space;
}

function rename(spaceId, name) {
  const space = get(spaceId);
  if (!space) return null;
  space.name = String(name || '').trim().slice(0, 80) || space.name;
  store.saveNow();
  return space;
}

/** Space view for the UI, tailored to the viewer. */
function publicView(space, viewerUserId, ownerUser) {
  if (!space) return null;
  return {
    id: space.id,
    name: space.name,
    isOwner: space.ownerUserId === viewerUserId,
    owner: ownerUser ? { name: ownerUser.name, email: ownerUser.email } : null,
    members: space.memberEmails.slice(),
    memberCount: space.memberEmails.length,
  };
}

module.exports = {
  list, get, findByOwner, createSpace, resolveSpace,
  isOwner, isInvitedEmail, addMember, removeMember, rename, publicView,
};
