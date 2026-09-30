'use strict';

/**
 * .mute — silence a member (their messages get auto-deleted) or, with no
 * target, lock the whole group to admins only.
 *
 * Ported from ..wdp/commands/admin/mute.js. The per-user part lights up the
 * mute list the handler has enforced all along (database.isUserMuted →
 * delete); the group part is the mentor's announcement-mode toggle.
 */

const database = require('../../database');
const { getTargets } = require('../../utils/msgTools');
const { findParticipant } = require('../../utils/jidHelper');

module.exports = {
  name: 'mute',
  aliases: ['silence', 'closegroup'],
  category: 'admin',
  description: 'Mute a member (auto-deletes their messages) or lock the group',
  usage: '.mute @user   OR   .mute  (locks group)',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);

      // ── No target → lock the whole group ─────────────────────────────────
      if (!targets.length) {
        await sock.groupSettingUpdate(extra.from, 'announcement');
        return extra.reply(
          '🔒 *Group Locked*\n\n' +
          'Only admins can send messages now.\n' +
          'Use `.unmute` to reopen.'
        );
      }

      const target = targets[0];

      // Never mute the bot itself (PN or LID form).
      const botNum = (sock.user?.id || '').split(':')[0].split('@')[0];
      if (target.split('@')[0].split(':')[0] === botNum) {
        return extra.reply('🤖 I cannot mute myself!');
      }

      const row = findParticipant(extra.groupMetadata?.participants || [], target);
      if (row && (row.admin === 'admin' || row.admin === 'superadmin')) {
        return extra.reply('❌ Cannot mute a group admin!');
      }

      database.muteUser(extra.from, target);
      database.clearWarnings(extra.from, target);   // mentor behaviour: a mute replaces the warn trail

      await sock.sendMessage(extra.from, {
        text:
          '🔇 *User Muted*\n\n' +
          `👤 @${target.split('@')[0]} has been muted.\n` +
          '🗑️ Their messages will be automatically deleted.\n' +
          '⚠️ Their warnings have been cleared.\n\n' +
          '_Use .unmute @user to restore their access._',
        mentions: [target],
      }, { quoted: msg });
    } catch (err) {
      console.error('[mute]', err.message);
      await extra.reply(`❌ Error: ${err.message}`);
    }
  },
};
