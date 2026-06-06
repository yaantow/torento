require('dotenv').config();
const path = require('path');
const os = require('os');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  cacheDir: path.resolve(process.env.CACHE_DIR || './cache'),
  cacheMaxGB: parseInt(process.env.CACHE_MAX_GB, 10) || 28,
  cacheTTLHours: parseInt(process.env.CACHE_TTL_HOURS, 10) || 0,
  maxConcurrentTorrents: parseInt(process.env.MAX_CONCURRENT_TORRENTS, 10) || 2,

  sources: {
    x1337: {
      enabled: true,
      domain: process.env.X1337_DOMAIN || '1377x.to',
      timeout: 20000,
    },
    yts: {
      enabled: true,
      timeout: 10000,
    },
    tpb: {
      enabled: true,
      timeout: 10000,
    },
    tgx: {
      enabled: false,
      domain: process.env.TGX_DOMAIN || 'torrentgalaxy.to',
      timeout: 15000,
    },
  },

  webtorrent: {
    maxConns: 100,
    uploadLimit: -1,
  },
};

module.exports = config;
