'use strict';

/**
 * .goodbye — toggle goodbye messages for leaving members.
 *
 * The goodbye counterpart of .welcome; settings live in
 * DEFAULT_GROUP_SETTINGS (goodbye / goodbyeMessage).
 */

const database = require('../../database');

module.exports = {
  name: 'goodbye',
  aliases: ['goodbyeon', 'goodbyeoff'],
  category: 'admin',
  description: 'Enable/disable goodbye messages for leaving members',
  usage: '.goodbye on/off',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const action = (args[0] || '').toLowerCase();

      if (!['on', 'off'].includes(action)) {
        const gs = database.getGroupSettings(extra.from);
        const status = gs.goodbye ? '✅ Enabled' : '❌ Disabled';
        return extra.reply(
          '👋 *Goodbye Messages*\n\n' +
          `Status: ${status}\n` +
          `Message:\n${gs.goodbyeMessage}\n\n` +
          'Usage: .goodbye on/off\n\n' +
          'To customize: .setgoodbye <message>'
        );
      }

      const enable = action === 'on';
      database.updateGroupSettings(extra.from, { goodbye: enable });

      await extra.reply(
        `✅ Goodbye messages ${enable ? 'enabled' : 'disabled'}!` +
        (enable ? '\n\nLeaving members will now receive goodbye messages.' : '')
      );
    } catch (error) {
      console.error('[goodbye]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
