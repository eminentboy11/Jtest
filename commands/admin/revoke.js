'use strict';

/**
 * .revoke — revoke the group invite link and issue a fresh one.
 *
 * Ported from ..wdp/commands/admin/revokelink.js: old link dies immediately,
 * which is the fix for a leaked invite.
 */

module.exports = {
  name: 'revoke',
  aliases: ['revokelink', 'resetlink'],
  category: 'admin',
  description: 'Revoke the group invite link (old link stops working)',
  usage: '.revoke',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      await sock.groupRevokeInvite(extra.from);
      const code = await sock.groupInviteCode(extra.from);

      await extra.reply(
        '🔁 *Invite link revoked!*\n\n' +
        `🔗 New link: https://chat.whatsapp.com/${code}\n\n` +
        '⚠️ The previous link no longer works.'
      );
    } catch (error) {
      console.error('[revoke]', error.message);
      await extra.reply('❌ Could not revoke the link. Make sure I am admin.');
    }
  },
};
