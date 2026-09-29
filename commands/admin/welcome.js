'use strict';

/**
 * .welcome — toggle welcome greetings for new members.
 *
 * Ported from ..wdp/commands/admin/welcome.js. The group settings
 * (welcome / welcomeMessage / welcomeNoPP) ship in DEFAULT_GROUP_SETTINGS;
 * this switch and the handler's participants.update hook make them live.
 */

const database = require('../../database');

module.exports = {
  name: 'welcome',
  aliases: ['welcomeon', 'welcomeoff'],
  category: 'admin',
  description: 'Enable/disable welcome messages for new members',
  usage: '.welcome on/off',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const action = (args[0] || '').toLowerCase();

      if (!['on', 'off'].includes(action)) {
        const gs = database.getGroupSettings(extra.from);
        const status = gs.welcome ? '✅ Enabled' : '❌ Disabled';
        return extra.reply(
          '👋 *Welcome Messages*\n\n' +
          `Status: ${status}\n` +
          `Message:\n${gs.welcomeMessage}\n\n` +
          'Usage: .welcome on/off\n\n' +
          'To customize: .setwelcome <message>'
        );
      }

      const enable = action === 'on';
      database.updateGroupSettings(extra.from, { welcome: enable });

      await extra.reply(
        `✅ Welcome messages ${enable ? 'enabled' : 'disabled'}!` +
        (enable ? '\n\nNew members will now receive welcome messages.' : '')
      );
    } catch (error) {
      console.error('[welcome]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
