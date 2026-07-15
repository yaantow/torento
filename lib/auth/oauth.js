const { google } = require('googleapis');
const config = require('../../config');
const users = require('./users');

function isConfigured() {
  return !!(config.auth.clientId && config.auth.clientSecret);
}

function createClient() {
  return new google.auth.OAuth2(
    config.auth.clientId,
    config.auth.clientSecret,
    config.auth.redirectUri
  );
}

/**
 * Build the Google consent URL.
 * access_type=offline is what yields a refresh token (needed for background
 * uploads). We only force the consent prompt when explicitly reconnecting —
 * a normal repeat login reuses the refresh token we already stored.
 */
function getAuthUrl(state, forceConsent = false) {
  const client = createClient();
  const params = {
    access_type: 'offline',
    scope: config.auth.scopes,
    include_granted_scopes: true,
    state,
  };
  if (forceConsent) params.prompt = 'consent';
  return client.generateAuthUrl(params);
}

async function exchangeCode(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token?, id_token, expiry_date, scope }
}

/** Verify the id_token and return a normalized Google profile. */
async function getProfile(idToken) {
  const client = createClient();
  const ticket = await client.verifyIdToken({ idToken, audience: config.auth.clientId });
  const p = ticket.getPayload();
  if (!p || !p.sub) throw new Error('Invalid Google identity token');
  if (p.email && p.email_verified === false) throw new Error('Google email is not verified');
  return { id: p.sub, email: p.email, name: p.name, picture: p.picture };
}

/**
 * An OAuth2 client authorized as `userId` via their stored refresh token.
 * googleapis transparently refreshes the short-lived access token as needed.
 * Returns null if the user has no Drive connection.
 *
 * Clients are cached per user and reused across calls so the (short-lived,
 * ~1hr) access token survives between requests instead of being thrown away
 * and re-fetched from Google on every single one — that round trip was
 * adding a full extra network hop to every streamed video chunk.
 */
const clientCache = new Map(); // userId -> { client, refreshToken }

function authorizedClient(userId) {
  const refreshToken = users.getRefreshToken(userId);
  if (!refreshToken) {
    clientCache.delete(userId);
    return null;
  }
  const cached = clientCache.get(userId);
  if (cached && cached.refreshToken === refreshToken) return cached.client;

  const client = createClient();
  client.setCredentials({ refresh_token: refreshToken });
  clientCache.set(userId, { client, refreshToken });
  return client;
}

module.exports = {
  isConfigured, createClient, getAuthUrl, exchangeCode, getProfile, authorizedClient,
};
