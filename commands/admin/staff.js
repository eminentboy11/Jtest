'use strict';

/**
 * .staff — list the group's admins and owner.
 *
 * Ported from ..wdp/commands/admin/staff.js, with LID-aware participant
 * rows (id / lid / phoneNumber may appear in any combination).
 */

const { displayUserTag } = require('../../utils/jidHelper');

module.exports = {
  name: 'staff',
  aliases: ['admins', 'adminlist'],
  category: 'admin',
  description: 'List the group admins and owner',
  usage: '.staff',
  groupOnly: true,
  adminOnly: false,
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    try {
      const participants = extra.groupMetadata?.participants || [];
      const tag = (p) => `@${displayUserTag(p.id || p.lid, extra.groupMetadata) || String(p.id || p.lid || '?').split('@')[0]}`;

      const superadmins = participants.filter((p) => p.admin === 'superadmin');
      const admins = participants.filter((p) => p.admin === 'admin');

      let text = '👑 *GROUP STAFF*\n\n';
      text += `👑 Owner: ${superadmins.length ? superadmins.map(tag).join(', ') : '—'}\n`;
      text += `🛡️ Admins (${admins.length}): ${admins.length ? admins.map(tag).join(', ') : '—'}\n`;
      text += `\n👥 Total members: ${participants.length}`;

      const mentions = participants
        .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
        .map((p) => p.id || p.lid)
        .filter(Boolean);

      await sock.sendMessage(extra.from, { text, mentions }, { quoted: msg });
    } catch (error) {
      console.error('[staff]', error.message);
      await extra.reply('❌ Failed to list staff.');
    }
  },
};
