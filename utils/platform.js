'use strict';

/**
 * Where are we running? One source of truth for the whole app.
 *
 * index.js sets global.platform from this at load; commands (menu) read
 * global.platform and fall back to calling this directly, so the answer is
 * computed at most once per process and never differs between the startup
 * card and the menu header.
 */

const os = require('os');

function detectPlatform() {
  if (process.env.DYNO) return '☁️ Heroku';
  if (process.env.RENDER) return '⚡ Render';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return '🚉 Railway';
  if (process.env.REPLIT_SLUG || process.env.REPL_ID) return '🔵 Replit';
  if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return '📱 Termux';
  if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return '🌀 CypherX Platform';
  if (process.env.P_SERVER_UUID) return '🖥️ Panel';
  if (process.env.LXC) return '🐦‍⬛ Linux Container (LXC)';
  switch (os.platform()) {
    case 'win32': return '🪟 Windows';
    case 'darwin': return '🍎 macOS';
    case 'linux': return '🐧 Linux';
    default: return '❓ Unknown';
  }
}

module.exports = detectPlatform;
module.exports.detectPlatform = detectPlatform;
