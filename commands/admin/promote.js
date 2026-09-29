'use strict';

/**
 * .promote — make a member a group admin.
 *
 * Ported from ..wdp/commands/admin/promote.js: resolves the target through
 * findParticipant (LID-aware) against FRESH metadata so rc13 LID senders
 * are matched to their participant row.
 */

const { findParticipant } = require('../../utils/jidHelper');
const { getTargets } = require('../../utils/msgTools');

module.exports = {
  name: 'promote',
  aliases: ['makeadmin'],
  category: 'admin',
  description: 'Promote a member to group admin',
  usage: '.promote @user',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);
      if (!targets.length) {
        return extra.reply('❌ Please mention or reply to the user to promote!\n\nExample: .promote @user');
      }

      // Fresh metadata — a stale cache can hold pre-promote admin states.
      const fresh = await sock.groupMetadata(extra.from);
      const promoted = [];
      for (const target of targets) {
        const row = findParticipant(fresh.participants || [], target);
        if (!row) {
          await extra.reply(`❌ @${target.split('@')[0]} is not in this group!`);
          continue;
        }
        if (row.admin === 'admin' || row.admin === 'superadmin') {
          await extra.reply(`ℹ️ @${target.split('@')[0]} is already an admin.`);
          continue;
        }
        await sock.groupParticipantsUpdate(extra.from, [target], 'promote');
        promoted.push(target);
      }

      if (promoted.length) {
        await sock.sendMessage(extra.from, {
          text: `✅ Promoted ${promoted.map((j) => `@${j.split('@')[0]}`).join(', ')} to admin.`,
          mentions: promoted,
        }, { quoted: msg });
      }
    } catch (error) {
      console.error('[promote]', error.message);
      await extra.reply('❌ Failed to promote. Make sure I am admin.');
    }
  },
};
