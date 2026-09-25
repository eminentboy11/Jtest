'use strict';

/**
 * The paired-bot startup card, extracted from index.js so it can be tested
 * without pairing a phone. index.js fills in the fields; this only lays them
 * out and applies the bot's font.
 */

const { applyFont } = require('./fontConverter');
const detectPlatform = require('./platform');

function buildStartupCard(f) {
  return applyFont(
    '┏━━━✧ JUNE X WEB ✧━━━━\n' +
    '┃✧ Bot: ' + f.botName + '\n' +
    '┃✧ Prefix: [ ' + f.prefix + ' ]\n' +
    '┃✧ Owner: ' + f.ownerName + '\n' +
    '┃✧ Platform: ' + f.platform + '\n' +
    '┃✧ Status: online\n' +
    '┃✧ Time: ' + f.time + '\n' +
    '┃✧ Commands: ' + f.commandCount + '\n' +
    '┃✧ BotId: ' + f.botId + '\n' +
    '┃✧ Number: +' + f.accountNumber + '\n' +
    '┃✧ T.Group: t.me/juneOff\n' +
    '┃✧ Telegram: t.me/supremlord\n' +
    '┃✧ Repo: https://github.com/Vinpink2\n' +
    '┗━━━━━━━━━━━━━━━');
}


/**
 * Collect the card's fields INSIDE database.runAsBot(bot.id, ...).
 *
 * This is the bug the first card shipped with: connection.update fires outside
 * any bot context, so getBotSetting() silently read the DEFAULT bot's file and
 * the card showed "." for a bot whose prefix was "i", and "Bot Owner" because
 * the real bot's owners were never looked at.
 *
 * Owner name chain, first hit wins:
 *   1. an explicitly stored ownerName setting
 *   2. the first owner JID's contact name, else their number
 *   3. the paired account's own display name (sock.user.name) — on the web
 *      edition the person who paired the number is the operator
 *   4. "Bot Owner"
 * A resolved human name is persisted so the menu and later boots agree.
 */
async function resolveStartupFields({ database, sock, bot, commandCount }) {
  return database.runAsBot(bot.id, async () => {
    const rawPrefix = database.getBotSetting('prefix');
    const prefix = rawPrefix === '' ? 'none' : (rawPrefix || '.');

    const stored = database.getBotSetting('ownerName');
    const storedList = (Array.isArray(stored) ? stored : [stored])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');

    let ownerName = storedList.length ? String(storedList[0]) : null;

    if (!ownerName) {
      const owners = database.getOwners();
      if (owners.length) {
        let contact = null;
        try { contact = await sock.getName?.(owners[0]); } catch (_) { /* no store */ }
        ownerName = (contact && !/^\+?\d{6,}$/.test(String(contact)))
          ? String(contact)
          : '+' + String(owners[0]).split('@')[0].split(':')[0];
      }
    }

    if (!ownerName) ownerName = sock.user?.name || 'Bot Owner';

    if (ownerName !== 'Bot Owner' && !storedList.length) {
      try { database.setOwnerNames([ownerName]); } catch (_) { /* keep going */ }
    }

    return {
      botName: database.getBotSetting('botName'),
      prefix,
      ownerName,
      platform: global.platform || detectPlatform(),
      time: new Date().toLocaleString(),
      commandCount,
      botId: bot.id,
      accountNumber: bot.accountNumber,
    };
  });
}

module.exports = { buildStartupCard, resolveStartupFields };
