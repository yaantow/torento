require('dotenv').config();
const path = require('path');
const os = require('os');

const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  appUrl: APP_URL,
  isProd: process.env.NODE_ENV === 'production',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  cacheDir: path.resolve(process.env.CACHE_DIR || './cache'),
  cacheMaxGB: parseInt(process.env.CACHE_MAX_GB, 10) || 28,
  cacheTTLHours: parseInt(process.env.CACHE_TTL_HOURS, 10) || 0,
  maxConcurrentTorrents: parseInt(process.env.MAX_CONCURRENT_TORRENTS, 10) || 2,

  auth: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: process.env.OAUTH_REDIRECT_URI || `${APP_URL}/api/auth/callback`,
    sessionSecret: process.env.SESSION_SECRET || '',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    allowedEmails: (process.env.ALLOWED_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive.file',
    ],
  },

  drive: {
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY || '',
    defaultFolder: process.env.DRIVE_DEFAULT_FOLDER || 'Torento',
  },

  opensubtitles: {
    apiKey: process.env.OPENSUBTITLES_API_KEY || '',
  },

  sources: {
    x1337: {
      enabled: true,
      domains: (process.env.X1337_DOMAINS || process.env.X1337_DOMAIN || '1377x.to,1337x.to,1337x.st,1337x.gd')
        .split(',').map(d => d.trim()).filter(Boolean),
      timeout: 20000,
      maxPages: parseInt(process.env.X1337_MAX_PAGES, 10) || 3,
    },
    yts: {
      enabled: true,
      timeout: 10000,
      limit: 50,
      maxPages: parseInt(process.env.YTS_MAX_PAGES, 10) || 3,
    },
    tpb: {
      enabled: true,
      timeout: 10000,
    },
    tgx: {
      enabled: false,
      domains: (process.env.TGX_DOMAINS || process.env.TGX_DOMAIN || 'torrentgalaxy.to,torrentgalaxy.mx,tgx.rs')
        .split(',').map(d => d.trim()).filter(Boolean),
      timeout: 15000,
      maxPages: parseInt(process.env.TGX_MAX_PAGES, 10) || 3,
    },
  },

  webtorrent: {
    maxConns: 100,
    uploadLimit: -1,
  },
};

module.exports = config;
