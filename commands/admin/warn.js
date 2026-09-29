'use strict';

/**
 * .warn — warn a member; at the bot's maxWarnings they are removed.
 *
 * Ported from ..wdp/commands/admin/warn.js onto Jtest's JSON store:
 * database.addWarning() returns the new COUNT here (the mentor's store
 * returned an object). Warns are the same records .antiforward uses, and
 * .resetwarn / .unmute clear them.
 */

const database = require('../../database');
const { getTargets } = require('../../utils/msgTools');
const { findParticipant } = require('../../utils/jidHelper');

module.exports = {
  name: 'warn',
  aliases: ['warning'],
  category: 'admin',
  description: 'Warn a member (removal at the warning limit)',
  usage: '.warn @user <reason>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);
      if (!targets.length) {
        return extra.reply('❌ Please mention or reply to the user to warn!\n\nExample: .warn @user Breaking rules');
      }
      const target = targets[0];

      // Never warn the bot itself (PN or LID form).
      const botComparable = (sock.user?.id || '').split(':')[0].split('@')[0];
      if (target.split('@')[0].split(':')[0] === botComparable) {
        return extra.reply('🤖 I cannot warn myself!');
      }

      // Mentions are consumed as target slots by the mentor convention:
      // ".warn @user <reason>" — drop mention tokens, the rest is the reason.
      const reason = args.filter((a) => !a.startsWith('@')).join(' ').trim() || 'No reason specified';

      // Admins are immune.
      const row = findParticipant(extra.groupMetadata?.participants || [], target);
      if (row && (row.admin === 'admin' || row.admin === 'superadmin')) {
        return extra.reply('❌ Cannot warn an admin!');
      }

      const count = database.addWarning(extra.from, target, reason);
      const limit = database.getBotSetting('maxWarnings') || 3;

      let text = '⚠️ *USER WARNING*\n\n';
      text += `👤 User: @${target.split('@')[0]}\n`;
      text += `📝 Reason: ${reason}\n`;
      text += `⚠️ Warnings: ${count}/${limit}\n\n`;

      if (count >= limit) {
        text += '❌ User has reached the maximum warnings and will be removed!';
        await sock.sendMessage(extra.from, { text, mentions: [target] }, { quoted: msg });
        if (extra.isBotAdmin) {
          await sock.groupParticipantsUpdate(extra.from, [target], 'remove');
          database.clearWarnings(extra.from, target);
        }
      } else {
        text += limit - count === 1
          ? '⚠️ One more warning and they will be removed!'
          : `⚠️ ${limit - count} more warnings and they will be removed.`;
        await sock.sendMessage(extra.from, { text, mentions: [target] }, { quoted: msg });
      }
    } catch (error) {
      console.error('[warn]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
