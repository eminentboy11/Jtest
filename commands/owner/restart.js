/**
 * Restart only the WhatsApp session that receives this command.
 * All other sessions in the shared Node.js process remain untouched.
 */

'use strict';

const { getCurrentBotId } = require('../../utils/core/botContext');
const sessionService = require('../../platform/sessionService');

module.exports = {
  name: 'restart',
  aliases: ['reboot', 'reload'],
  category: 'owner',
  description: 'Reconnect only the current bot session (Owner Only)',
  usage: '.restart',
  ownerOnly: true,

  async execute(_sock, _msg, _args, extra) {
    const botId = getCurrentBotId();
    await extra.reply('🔁 Restarting this session only...');

    try {
      const result = await sessionService.reconnect(botId, { repair: false });
      if (!result?.ok) {
        return extra.reply(`❌ Session restart failed: ${result?.error || result?.reason || 'unknown error'}`);
      }
      // The original command socket is intentionally replaced. The engine's
      // reconnect result is authoritative; no process-level exit is used.
      if (result.connected === false) return null;
      try {
        await result.sock?.sendMessage?.(extra.from, { text: '✅ Session restarted successfully.' });
      } catch (_) {}
      return null;
    } catch (error) {
      try { await extra.reply(`❌ Session restart failed: ${error.message}`); } catch (_) {}
      return null;
    }
  },
};
