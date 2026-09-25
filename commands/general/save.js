'use strict';

/**
 * .save — save a quoted status update into your private chat.
 *
 * Status media arrives quoted from status@broadcast; replying there would be
 * useless, so the result always goes to the sender's own chat instead.
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = {
  name: 'save',
  aliases: ['savestatus', 'take'],
  category: 'general',
  description: 'Save a quoted status update to your private chat',
  usage: '.save (reply to a status message)',

  async execute(sock, msg, args, extra) {
    const sender = extra?.sender || msg.key.participant || msg.key.remoteJid;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

    if (quoted?.extendedTextMessage?.text) {
      await sock.sendMessage(sender, { text: `📌 Saved status:\n${quoted.extendedTextMessage.text}` });
      return;
    }

    const kind = quoted?.imageMessage ? 'image' : quoted?.videoMessage ? 'video' : null;
    if (!kind) {
      await sock.sendMessage(sender, { text: 'Reply to a status message with .save' });
      return;
    }

    const buf = await drain(await downloadContentFromMessage(quoted[`${kind}Message`], kind));
    const caption = quoted[`${kind}Message`].caption || '📌 Saved status';
    await sock.sendMessage(sender, { [kind]: buf, caption });
  },
};
