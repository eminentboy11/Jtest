'use strict';

/**
 * .demote — remove a member's admin rights.
 *
 * Ported from ..wdp/commands/admin/demote.js with the same LID-aware
 * target resolution as .promote.
 */

const { findParticipant } = require('../../utils/jidHelper');
const { getTargets } = require('../../utils/msgTools');

module.exports = {
  name: 'demote',
  aliases: ['makedemote', 'stripadmin'],
  category: 'admin',
  description: 'Demote a group admin to member',
  usage: '.demote @user',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const targets = getTargets(msg);
      if (!targets.length) {
        return extra.reply('❌ Please mention or reply to the user to demote!\n\nExample: .demote @user');
      }

      const fresh = await sock.groupMetadata(extra.from);
      const demoted = [];
      for (const target of targets) {
        const row = findParticipant(fresh.participants || [], target);
        if (!row) {
          await extra.reply(`❌ @${target.split('@')[0]} is not in this group!`);
          continue;
        }
        if (row.admin !== 'admin' && row.admin !== 'superadmin') {
          await extra.reply(`ℹ️ @${target.split('@')[0]} is not an admin.`);
          continue;
        }
        await sock.groupParticipantsUpdate(extra.from, [target], 'demote');
        demoted.push(target);
      }

      if (demoted.length) {
        await sock.sendMessage(extra.from, {
          text: `✅ Demoted ${demoted.map((j) => `@${j.split('@')[0]}`).join(', ')}.`,
          mentions: demoted,
        }, { quoted: msg });
      }
    } catch (error) {
      console.error('[demote]', error.message);
      await extra.reply('❌ Failed to demote. Make sure I am admin.');
    }
  },
};
