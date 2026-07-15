const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../../config');
const users = require('./users');

const SESSION_COOKIE = 'torento_session';
const STATE_COOKIE = 'torento_oauth_state';
const SESSION_TTL = '30d';

function secret() {
  if (!config.auth.sessionSecret) {
    throw new Error('SESSION_SECRET is not set — cannot issue sessions.');
  }
  return config.auth.sessionSecret;
}

function cookieOpts(extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    ...extra,
  };
}

/** Whether this email is permitted to sign in (empty allowlist = open). */
function isEmailAllowed(email) {
  const list = config.auth.allowedEmails;
  if (!list.length) return true;
  return list.includes(String(email || '').toLowerCase());
}

function issueSession(res, userId) {
  const token = jwt.sign({ uid: userId }, secret(), { expiresIn: SESSION_TTL });
  res.cookie(SESSION_COOKIE, token, cookieOpts({ maxAge: 30 * 24 * 60 * 60 * 1000 }));
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, cookieOpts());
}

function readUserId(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, secret()).uid;
  } catch {
    return null;
  }
}

/** Populates req.user (full record) if a valid session exists. */
function attachUser(req, _res, next) {
  const uid = readUserId(req);
  req.user = uid ? users.get(uid) : null;
  next();
}

/** Populates req.space (shared library) for a signed-in user. */
function attachSpace(req, _res, next) {
  if (req.user) {
    const spaces = require('./spaces');
    req.space = spaces.resolveSpace(req.user);
  } else {
    req.space = null;
  }
  next();
}

/** Gate: 401 for API calls, otherwise require a signed-in user. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

/** Gate: only the space owner may pass (manage Drive, members, deletions). */
function requireOwner(req, res, next) {
  if (req.user && req.space && req.space.ownerUserId === req.user.id) return next();
  res.status(403).json({ error: 'Only the library owner can do that' });
}

// ---- OAuth state (CSRF) ----
function issueState(res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, cookieOpts({ maxAge: 10 * 60 * 1000 }));
  return state;
}

function verifyState(req, res) {
  const expected = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, cookieOpts());
  return expected && req.query.state && expected === req.query.state;
}

module.exports = {
  SESSION_COOKIE, isEmailAllowed, issueSession, clearSession,
  attachUser, attachSpace, requireAuth, requireOwner, issueState, verifyState,
};
