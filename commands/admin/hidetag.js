'use strict';

/**
 * .hidetag — silently tag every group member.
 *
 * Ported from ..wdp/commands/admin/hidetag.js: deletes the command message
 * and re-sends the payload (text, or quoted image/video/sticker) with the
 * full participant mention list attached, without listing anyone visibly.
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { resolveQuoted } = require('../../utils/msgTools');

module.exports = {
  name: 'hidetag',
  aliases: ['tag', 'taghidden'],
  category: 'admin',
  description: 'Silently tag all members in the group',
  usage: '.hidetag <message> (or reply to media)',
  groupOnly: true,
  adminOnly: false,
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    try {
      const participants = extra.groupMetadata?.participants || [];
      const mentions = participants
        .map((p) => (typeof p === 'string' ? p : p.id || p.lid))
        .filter(Boolean);

      // Hide the command itself (needs admin to delete others' messages — best effort).
      try { await sock.sendMessage(extra.from, { delete: msg.key }); } catch (_) {}

      const quoted = resolveQuoted(msg);
      const target = quoted ? quoted.fullQuoted : msg;
      const mediaMessage =
        target.message?.imageMessage ||
        target.message?.videoMessage ||
        target.message?.stickerMessage;

      if (mediaMessage) {
        const mediaBuffer = await downloadMediaMessage(
          target, 'buffer', {},
          { logger: undefined, reuploadRequest: sock.updateMediaMessage }
        );
        if (target.message?.imageMessage) {
          await sock.sendMessage(extra.from, {
            image: mediaBuffer,
            caption: args.join(' ') || target.message.imageMessage.caption || '',
            mentions,
          });
        } else if (target.message?.videoMessage) {
          await sock.sendMessage(extra.from, {
            video: mediaBuffer,
            caption: args.join(' ') || target.message.videoMessage.caption || '',
            mentions,
          });
        } else {
          await sock.sendMessage(extra.from, { sticker: mediaBuffer, mentions });
          if (args.join(' ')) await sock.sendMessage(extra.from, { text: args.join(' '), mentions });
        }
        return;
      }

      // Text payload: typed args win, else the quoted text, else a bare tag.
      const quotedText = quoted
        ? quoted.quotedMessage.conversation || quoted.quotedMessage.extendedTextMessage?.text
        : '';
      await sock.sendMessage(extra.from, {
        text: args.join(' ') || quotedText || ' ',
        mentions,
      });
    } catch (error) {
      console.error('[hidetag]', error.message);
      await extra.reply('❌ Failed to tag members.');
    }
  },
};
