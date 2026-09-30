'use strict';

/**
 * .grouplink — post the group's invite link.
 *
 * Ported from ..wdp/commands/admin/grouplink.js.
 */

module.exports = {
  name: 'grouplink',
  aliases: ['link', 'gclink', 'invite'],
  category: 'admin',
  description: 'Get the group invite link',
  usage: '.grouplink',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const code = await sock.groupInviteCode(extra.from);
      const link = `https://chat.whatsapp.com/${code}`;

      let text = '🔗 *GROUP INVITE LINK*\n\n';
      text += `📱 Group: ${extra.groupMetadata?.subject || extra.from}\n`;
      text += `🔗 Link: ${link}\n\n`;
      text += "⚠️ Don't share this link publicly!";

      await extra.reply(text);
    } catch (error) {
      console.error('[grouplink]', error.message);
      await extra.reply('❌ Could not fetch the invite link. Make sure I am admin.');
    }
  },
};
