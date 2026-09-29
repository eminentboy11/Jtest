'use strict';

/**
 * .setgname — rename the group.
 *
 * Ported from ..wdp/commands/admin/setgname.js.
 */

module.exports = {
  name: 'setgname',
  aliases: ['setgroupname', 'setsubject'],
  category: 'admin',
  description: 'Rename the group',
  usage: '.setgname <new name>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    const name = args.join(' ').trim();
    if (!name) {
      return extra.reply('❌ Please provide a new group name.\n\nExample: .setgname My Squad');
    }
    if (name.length > 100) {
      return extra.reply('❌ Group name is too long (max 100 characters).');
    }
    try {
      await sock.groupUpdateSubject(extra.from, name);
      await extra.reply(`✅ Group name updated to:\n*${name}*`);
    } catch (error) {
      console.error('[setgname]', error.message);
      await extra.reply('❌ Failed to rename the group. Make sure I am admin.');
    }
  },
};
