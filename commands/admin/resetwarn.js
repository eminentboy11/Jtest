'use strict';

/**
 * .resetwarn — clear a member's warnings.
 *
 * Ported from ..wdp/commands/admin/resetwarn.js onto Jtest's JSON store.
 */

const database = require('../../database');
const { getTargets } = require('../../utils/msgTools');

module.exports = {
  name: 'resetwarn',
  aliases: ['resetwarning', 'clearwarn', 'unwarn', 'delwarn'],
  category: 'admin',
  description: 'Reset all warnings for a member',
  usage: '.resetwarn @user',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);
      if (!targets.length) {
        return extra.reply('❌ Please mention or reply to the user to reset warnings!\n\nExample: .resetwarn @user');
      }
      const target = targets[0];

      const current = database.getWarnings(extra.from, target);
      if (!current.count) {
        return sock.sendMessage(extra.from, {
          text: `✅ @${target.split('@')[0]} has no warnings to reset.`,
          mentions: [target],
        }, { quoted: msg });
      }

      database.clearWarnings(extra.from, target);

      await sock.sendMessage(extra.from, {
        text:
          '✅ *Warnings Reset*\n\n' +
          `👤 User: @${target.split('@')[0]}\n` +
          `⚠️ Previous warnings: ${current.count}\n\n` +
          'All warnings have been cleared.',
        mentions: [target],
      }, { quoted: msg });
    } catch (error) {
      console.error('[resetwarn]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
