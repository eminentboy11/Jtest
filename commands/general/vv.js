'use strict';

/**
 * .vv — open a quoted view-once and resend it as a normal message.
 *
 * The handler also routes quoted view-once media here automatically when the
 * user reacts/replies in the old June X style; either path lands in execute().
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

function quotedViewOnce(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo
    || null;
  const q = ctx?.quotedMessage || null;
  if (!q) return null;
  const inner = q.viewOnceMessage?.message || q.viewOnceMessageV2?.message || null;
  if (!inner) return null;
  if (inner.imageMessage) return { type: 'image', m: inner.imageMessage };
  if (inner.videoMessage) return { type: 'video', m: inner.videoMessage };
  if (inner.audioMessage) return { type: 'audio', m: inner.audioMessage };
  return null;
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = {
  name: 'vv',
  aliases: ['rvo', 'viewonce', 'reveal'],
  category: 'general',
  description: 'Open a quoted view-once image/video and resend it normally',
  usage: '.vv (reply to a view-once message)',

  async execute(sock, msg, args, extra) {
    const chat = extra?.from || msg.key.remoteJid;
    const vo = quotedViewOnce(msg);
    if (!vo) {
      await sock.sendMessage(chat, { text: 'Reply to a view-once message with .vv' }, { quoted: msg });
      return;
    }
    const buf = await drain(await downloadContentFromMessage(vo.m, vo.type));
    const payload = vo.type === 'image' ? { image: buf }
      : vo.type === 'video' ? { video: buf }
        : { audio: buf, mimetype: vo.m.mimetype, ptt: true };
    if (vo.type !== 'audio') payload.caption = '♻️ View-once opened';
    await sock.sendMessage(chat, payload, { quoted: msg });
  },
};
