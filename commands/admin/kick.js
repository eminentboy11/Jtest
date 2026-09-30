'use strict';

/**
 * .kick — remove mentioned or replied members from the group.
 *
 * Ported from ..wdp/commands/admin/kick.js: keeps the mentor's robust
 * self-kick prevention, which understands both phone-number JIDs and the
 * rc13 LID JIDs (the bot can appear as either, and a naive comparison let
 * the bot kick itself).
 */

const { buildComparableIds } = require('../../utils/jidHelper');
const { getTargets } = require('../../utils/msgTools');

/** True when userId resolves to the bot itself (PN or LID form). */
function isBotTarget(sock, userId, participants) {
  const botId = sock.user?.id || '';
  const botLid = sock.user?.lid || '';
  const botPhone = botId.split(':')[0].split('@')[0];
  const botComparable = new Set([
    ...buildComparableIds(botId),
    ...buildComparableIds(botLid || `${botPhone}@lid`),
  ]);
  if (buildComparableIds(userId).some((id) => botComparable.has(id))) return true;

  // The bot's participant row may hold either form — match through it.
  const botRow = (participants || []).find((p) => {
    const ids = [p?.id, p?.lid, p?.phoneNumber, p?.pn, p?.userJid].filter(Boolean);
    return ids.some((id) => buildComparableIds(id).some((x) => botComparable.has(x)));
  });
  if (!botRow) return false;
  const rowIds = [botRow.id, botRow.lid, botRow.phoneNumber, botRow.pn, botRow.userJid]
    .filter(Boolean)
    .flatMap(buildComparableIds);
  return buildComparableIds(userId).some((id) => rowIds.includes(id));
}

module.exports = {
  name: 'kick',
  aliases: ['remove', 'out'],
  category: 'admin',
  description: 'Kick mentioned/replied members from the group',
  usage: '.kick @user',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const usersToKick = getTargets(msg);

      if (!usersToKick.length) {
        return extra.reply('👤 Mention or reply to the user you want to kick.');
      }

      const participants = extra.groupMetadata?.participants || [];
      if (usersToKick.some((uid) => isBotTarget(sock, uid, participants))) {
        return extra.reply('❌ Cannot kick myself!');
      }

      await sock.groupParticipantsUpdate(extra.from, usersToKick, 'remove');

      const usernames = usersToKick.map((jid) => `@${jid.split('@')[0]}`);
      await sock.sendMessage(extra.from, {
        text: `✅ ${usernames.join(', ')} has been kicked successfully.`,
        mentions: usersToKick,
      }, { quoted: msg });
    } catch (error) {
      console.error('[kick]', error.message);
      await extra.reply('❌ Failed to kick user(s). Make sure I am admin.');
    }
  },
};
