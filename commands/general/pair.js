'use strict';

/**
 * .deploy — provision a new bot session from chat and deliver its pairing code.
 *
 * The first version of this file called an external USER_DEPLOY_URL over HTTP
 * and rendered the result through gifted-btns (a dep this repo does not have),
 * so the command never even loaded. Everything it needs already lives in this
 * process: the web gateway provisions slots through platform/slots.js and
 * platform/sessions.js, so the command uses the exact same in-process path —
 * no env var, no HTTP hop, no extra dependency.
 *
 * Owner-only on purpose: deploying a bot spends a session slot and opens a
 * WhatsApp socket, so it must not be reachable from a random group member.
 */

const slots = require('../../platform/slots');
const sessions = require('../../platform/sessions');
const ratelimit = require('../../platform/ratelimit');
const database = require('../../database');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CODE_WAIT_MS = 25000;   // socket needs a few seconds to stabilise
const MAX_PER_CALL = 3;       // chat is not a bulk-provisioning interface

function linkInstructions(code, number, botName) {
  return [
    `🔐 *Pairing code for ${number}*`,
    '',
    '```' + code + '```',
    '',
    '📲 *How to link:*',
    '1️⃣ Open WhatsApp on the phone',
    '2️⃣ Settings → Linked Devices',
    '3️⃣ Tap *Link a Device*',
    '4️⃣ Choose *Link with phone number instead*',
    '5️⃣ Enter the code above',
    '',
    '⏱️ _The code expires in a few minutes — act fast._',
    `> Powered by ${botName || 'JUNE X'}`,
  ].join('\n');
}

module.exports = {
  name: 'deploy',
  aliases: ['pair', 'deploybot'],
  category: 'general',
  description: 'Deploy a new bot session and get its WhatsApp pairing code (owner only)',
  usage: '.deploy <number> [, <number2>]  e.g. .deploy 2348012345678',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } });

    if (!extra?.isOwner && !extra?.isSudo) {
      await reply('❗ *Owner only.* Deploying bots is not open to this chat.');
      return;
    }

    const q = args.join(' ').trim();
    if (!q) {
      await reply('⚠️ *You forgot the number.*\n\n👉 Example:\n.deploy 2348012345678');
      await react('⚠️');
      return;
    }

    const numbers = [...new Set(
      q.split(',')
        .map((v) => v.replace(/[^0-9]/g, ''))
        .filter((v) => v.length >= 7 && v.length <= 15),
    )].slice(0, MAX_PER_CALL);

    if (numbers.length === 0) {
      await reply('❌ *Invalid number format.*\n\n👉 Digits only, 7–15 digits, country code included.');
      await react('❌');
      return;
    }

    for (const number of numbers) {
      try {
        const check = await sock.onWhatsApp?.(`${number}@s.whatsapp.net`);
        if (check && check[0] && check[0].exists === false) {
          await reply(`🚫 *${number}* is not registered on WhatsApp.`);
          continue;
        }
      } catch (_) { /* lookup problems should not block a deploy */ }

      // Same abuse guards the public web route applies.
      const ipHash = `chat:${extra?.sender || chatId}`;
      const rl = ratelimit.allowCreate(ipHash);
      if (!rl.ok) {
        await reply(`⏳ Too many deploys from you — try again in ~${rl.retryInMin} min.`);
        continue;
      }
      if (!ratelimit.underGlobalCap(sessions.activeSessionCount())) {
        await reply('🈵 The platform is at capacity right now — try again later.');
        continue;
      }

      await reply(`⏳ Deploying a session for *${number}*…`);
      let slot = null;
      try {
        slot = slots.create({ mode: 'code', phone: number, ipHash });
        await sessions.provisionSlot(slot);
      } catch (err) {
        if (slot) {
          try { slot.status = 'failed'; slot.error = err.message; } catch (_) {}
        }
        await reply(`❌ Deploy failed for *${number}*: ${err.message}`);
        await react('⚠️');
        continue;
      }

      // The code arrives a few seconds later, once the socket stabilises.
      const deadline = Date.now() + CODE_WAIT_MS;
      let code = null;
      while (Date.now() < deadline) {
        await sleep(1000);
        const live = slots.get(slot.slotId);
        if (!live) break;
        code = live.codes?.[0]?.code || null;
        if (code || live.status === 'failed') break;
      }

      if (!code) {
        await reply(`⚠️ Session for *${number}* started but no code arrived yet.\nCheck the panel at / or retry in a moment.`);
        await react('⚠️');
        continue;
      }

      await reply(linkInstructions(code, number, database.getBotSetting('botName')));
      await react('✅');
    }
  },
};
