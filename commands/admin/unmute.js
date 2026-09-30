'use strict';

/**
 * .unmute — lift a member's mute, or with no target reopen the group.
 *
 * Ported from ..wdp/commands/admin/unmute.js, the counterpart of .mute.
 */

const database = require('../../database');
const { getTargets } = require('../../utils/msgTools');

module.exports = {
  name: 'unmute',
  aliases: ['unsilence', 'opengroup'],
  category: 'admin',
  description: 'Unmute a member or reopen the group',
  usage: '.unmute @user  OR  .unmute  (opens group)',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);

      // ── No target → reopen the whole group ───────────────────────────────
      if (!targets.length) {
        await sock.groupSettingUpdate(extra.from, 'not_announcement');
        return extra.reply(
          '🔓 *Group Reopened*\n\n' +
          'All members can send messages again.\n' +
          'Use `.mute` to lock it again.'
        );
      }

      const target = targets[0];
      if (!database.isUserMuted(extra.from, target)) {
        return sock.sendMessage(extra.from, {
          text: `✅ @${target.split('@')[0]} is not muted.`,
          mentions: [target],
        }, { quoted: msg });
      }

      database.unmuteUser(extra.from, target);

      await sock.sendMessage(extra.from, {
        text:
          '🔊 *User Unmuted*\n\n' +
          `👤 @${target.split('@')[0]} can speak again.`,
        mentions: [target],
      }, { quoted: msg });
    } catch (err) {
      console.error('[unmute]', err.message);
      await extra.reply(`❌ Error: ${err.message}`);
    }
  },
};
