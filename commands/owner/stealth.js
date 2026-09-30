/**
 * .stealth — make the bot completely invisible.
 * When ON: no presence updates (typing/recording/online) and no read
 * receipts leave the socket, and the bot connects without the "online" mark.
 * autotyping / autorecording / alwaysonline / autoread settings are not
 * changed — they are simply muted while stealth is on.
 */
'use strict';
const stealthMode = require('../../utils/stealthMode');

module.exports = {
  name: 'stealth',
  aliases: ['stealthmode', 'ghost', 'ghostmode'],
  category: 'owner',
  ownerOnly: true,
  description: 'Toggle complete stealth (no presence, no read receipts)',
  usage: '.stealth <on|off>',

  async execute(sock, msg, args, extra) {
    try {
      const opt = (args[0] || '').toLowerCase().trim();

      if (!opt || !['on', 'off'].includes(opt)) {
        const on = stealthMode.isEnabled();
        return extra.reply(
          `👻 *Stealth Mode:* ${on ? 'ON ✅' : 'OFF ❌'}\n\n` +
          `*Usage:* .stealth <on|off>\n\n` +
          `*What it does:*\n` +
          `• Blocks all presence updates (typing, recording, online, last seen)\n` +
          `• Blocks all read receipts (chats and statuses)\n` +
          `• Bot connects without the "online" mark\n\n` +
          `*While stealth is ON:*\n` +
          `✓ No "typing…" indicator\n` +
          `✓ No "online" status\n` +
          `✓ Chats stay grey-ticked (no blue doubles)\n\n` +
          `_autotyping, autorecording, alwaysonline and autoread are muted while stealth is on — their settings are kept and resume when you turn stealth off._`
        );
      }

      const turnOn = opt === 'on';
      stealthMode.setEnabled(turnOn);

      if (turnOn) {
        // 'unavailable' is the one presence stealth lets through — use it
        // to go dark immediately, without waiting for the next reconnect.
        try { await sock.sendPresenceUpdate('unavailable'); } catch (_) {}
        return extra.reply(
          `👻 *Stealth Mode: ON*\n\n` +
          `✓ Bot is now completely invisible\n` +
          `✓ No presence updates\n` +
          `✓ No read receipts\n\n` +
          `_Use .stealth off when you want presence again._`
        );
      }

      return extra.reply(
        `👻 *Stealth Mode: OFF*\n\n` +
        `✓ Presence updates enabled\n` +
        `✓ Read receipts enabled\n\n` +
        `_autotyping / autorecording / alwaysonline / autoread resume their own settings now._`
      );
    } catch (err) {
      await extra.reply(`❌ Error: ${err.message}`);
    }
  },
};
