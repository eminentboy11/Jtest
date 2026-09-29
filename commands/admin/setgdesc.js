'use strict';

/**
 * .setgdesc — update the group description.
 *
 * Ported from ..wdp/commands/admin/setgdesc.js.
 */

module.exports = {
  name: 'setgdesc',
  aliases: ['setdesc', 'setgroupdesc', 'setdescription'],
  category: 'admin',
  description: 'Update the group description',
  usage: '.setgdesc <description>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    const desc = args.join(' ').trim();
    if (!desc) {
      return extra.reply('❌ Please provide a new description.\n\nExample: .setgdesc Rules: be nice');
    }
    try {
      await sock.groupUpdateDescription(extra.from, desc);
      await extra.reply('✅ Group description updated.');
    } catch (error) {
      console.error('[setgdesc]', error.message);
      await extra.reply('❌ Failed to update the description. Make sure I am admin.');
    }
  },
};
