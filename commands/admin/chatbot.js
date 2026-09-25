'use strict';

/**
 * .chatbot — minimal auto-reply, one AI provider, keyed by env.
 *
 * The June X original was 1,654 lines across several providers. This is the
 * deliberately small version: any OpenAI-compatible chat-completions endpoint,
 * configured entirely by env, per-chat on/off through the group settings.
 *
 *   CHATBOT_API_KEY   required; no key means the chatbot stays silent
 *   CHATBOT_BASE_URL  default https://api.openai.com/v1
 *   CHATBOT_MODEL     default gpt-4o-mini
 *
 * A dead key, a 402, or a timeout all mean silence: an auto-reply feature must
 * never turn a provider outage into chat spam or a crash.
 */

const axios = require('axios');
const database = require('../../database');

const apiKey = () => String(process.env.CHATBOT_API_KEY || '').trim();
const baseUrl = () => String(process.env.CHATBOT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const model = () => String(process.env.CHATBOT_MODEL || 'gpt-4o-mini');

const SYSTEM = 'You are a friendly WhatsApp bot answering inside a chat. '
  + 'Reply in at most three sentences, in the user\'s language, plain text only.';

module.exports = {
  name: 'chatbot',
  aliases: ['ai', 'autoreply'],
  category: 'admin',
  description: 'Auto-reply to messages via one env-keyed AI provider',
  usage: '.chatbot on|off|status',

  async execute(sock, msg, args, extra) {
    const chat = extra?.from || msg.key.remoteJid;
    if (!extra?.isAdmin && !extra?.isOwner) {
      await sock.sendMessage(chat, { text: '❗ Admins only.' }, { quoted: msg });
      return;
    }

    const act = String(args[0] || 'status').toLowerCase();
    if (act === 'on' || act === 'off') {
      database.updateGroupSettings(chat, { chatbot: act === 'on' });
    }

    const on = database.getGroupSettings(chat).chatbot === true;
    const keyed = apiKey() !== '';
    await sock.sendMessage(chat, {
      text: [
        `🤖 *Chatbot:* ${on ? 'ON' : 'OFF'}`,
        `🔑 *API key:* ${keyed ? 'configured' : 'MISSING — set CHATBOT_API_KEY'}`,
        `⚙️ *Model:* ${model()}`,
        '',
        '_.chatbot on | .chatbot off | .chatbot status_',
      ].join('\n'),
    }, { quoted: msg });
  },

  /**
   * Called by the handler for every inbound message that is not from the bot.
   * Silent unless the chat enabled it AND a key is configured.
   */
  async handleAutoReply(sock, msg, ctx = {}) {
    if (!apiKey()) return;
    const chat = ctx.from || msg.key.remoteJid;
    if (database.getGroupSettings(chat).chatbot !== true) return;

    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';
    const clean = text.trim();
    if (!clean || clean.startsWith('.') || clean.startsWith('/')) return;

    try {
      const r = await axios.post(`${baseUrl()}/chat/completions`, {
        model: model(),
        max_tokens: 150,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: clean.slice(0, 500) },
        ],
      }, {
        headers: { authorization: `Bearer ${apiKey()}` },
        timeout: 8000,
      });
      const reply = String(r.data?.choices?.[0]?.message?.content || '').trim();
      if (reply) await sock.sendMessage(chat, { text: reply }, { quoted: msg });
    } catch (_) {
      // silence is the correct behaviour for a dead or unpaid key
    }
  },
};
