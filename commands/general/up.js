/**
 * Uptime Command - Display how long THIS bot has been online
 */

const os = require('os');
const database = require('../../database');
const sessionService = require('../../platform/sessionService');

/**
 * Detect the platform where the bot is running
 * @returns {string} Platform name with emoji
 */
function detectPlatform() {
  if (process.env.DYNO) return '☁️ Heroku';
  if (process.env.RENDER) return '⚡ Render';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return '🚉 Railway';
  if (process.env.REPLIT_SLUG || process.env.REPL_ID) return '🔵 Replit';
  if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return '📱 Termux';
  if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return '🌀 CypherX Platform';
  if (process.env.P_SERVER_UUID) return '🖥️ Panel';
  if (process.env.LXC) return '🐦‍ Linux Container (LXC)';
  switch (os.platform()) {
    case 'win32': return '🪟 Windows';
    case 'darwin': return '🍎 macOS';
    case 'linux': return '🐧 Linux';
    default: return '❓ Unknown';
  }
}

/**
 * Format time difference into human-readable string
 * @param {number} seconds - Total seconds of uptime
 * @returns {string} Formatted uptime string
 */
function formatUptime(seconds) {
  if (seconds <= 0) {
    return '0 seconds';
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];

  if (days > 0) {
    parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs} ${secs === 1 ? 'second' : 'seconds'}`);
  }

  return parts.join(', ');
}

module.exports = {
  name: 'uptime',
  aliases: ['runtime', 'botuptime', 'up'],
  category: 'general',
  description: 'Show how long this bot has been online',
  usage: '.uptime',

  async execute(sock, msg, args, extra) {
    try {
      const platform = detectPlatform();
      const processUptime = formatUptime(process.uptime());

      // Per-bot online time. Every bot here lives in ONE Node process, so
      // process.uptime() alone makes all bots report the same number — the
      // exact thing two paired phones side by side immediately expose.
      // Each bot entry stamps connectedAt when its socket opens; that is
      // THIS bot's uptime. currentBotId() comes from the async-local dispatch
      // context, so concurrent messages on different bots cannot race.
      let botUptime = null;
      let botLabel = '';
      try {
        const bot = sessionService.get(database.currentBotId());
        if (bot?.connectedAt) {
          botUptime = formatUptime(Math.max(0, (Date.now() - bot.connectedAt) / 1000));
          if (bot.accountNumber) botLabel = ` (${bot.accountNumber})`;
        }
      } catch (_) { /* outside the platform (tests, standalone) — fall back */ }

      // Memory is process-wide by nature: one process hosts every bot, so
      // label it honestly instead of pretending it belongs to this bot.
      const mem = process.memoryUsage();
      const memUsed = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const memTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);

      const lines = [``, `⏰ Running on* ✓${platform}✓*`];
      if (botUptime) {
        lines.push(`🤖 *This bot online for:* ${botUptime}${botLabel}`);
        lines.push(`⚙️ *Server process up:* ${processUptime} (shared by every bot here)`);
      } else {
        lines.push(`⚙️ *Up for:* ${processUptime}`);
      }
      lines.push(`💾 *Memory:* ${memUsed}MB / ${memTotal}MB (process-wide)`);

      await extra.reply(lines.join('\n'));

    } catch (error) {
      console.error('Error in uptime command:', error);
      await extra.reply('❌ An error occurred while fetching uptime information. Please try again later.');
    }
  }
};
