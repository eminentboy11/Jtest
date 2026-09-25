'use strict';

/**
 * The paired-bot startup card, extracted from index.js so it can be tested
 * without pairing a phone. index.js fills in the fields; this only lays them
 * out and applies the bot's font.
 */

const { applyFont } = require('./fontConverter');

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

module.exports = { buildStartupCard };
