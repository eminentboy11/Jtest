const database = require('../../database');

module.exports = {
  name: 'setownernumber',
  aliases: ['setowner_number', 'setown'],
  category: 'owner',
  description: 'Change the bot owner number',
  usage: '.setownernumber <number>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      let newNumber = '';

      const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (mentioned && mentioned.length > 0) {
        newNumber = mentioned[0].split('@')[0];
      } else if (args.length > 0) {
        newNumber = args[0].replace(/[^0-9]/g, '');
      }

      if (!newNumber) {
        const current = database.getOwners();
        const shown = current.length ? current.map(n => `*${n}*`).join(', ') : '_none set_';
        return extra.reply(
          `📱 *Set Owner Number*\n\nCurrent: ${shown}\n\n` +
          `Usage:\n${database.getBotSetting('prefix')}setownernumber <number>\n${database.getBotSetting('prefix')}setownernumber @mention\n\n` +
          `_This replaces the entire owner list._\n_Only needed when the bot runs on a different number from yours — the paired account is claimed automatically._`
        );
      }

      if (newNumber.length < 7 || newNumber.length > 15) {
        return extra.reply('❌ Invalid phone number! Must be 7-15 digits.');
      }

      // Replace the whole list. This used to rewrite only slot [0] of the
      // hardcoded array in config.js, silently leaving the remaining entries
      // as owners, and the file was overwritten on the next boot anyway.
      // SQLite lives in a directory the loader preserves, so this persists.
      // 'command' marks this as deliberate, so the startup claim will never
      // replace it even if the bot is later paired to a different account.
      database.setOwners([newNumber], 'command');

      await extra.reply(
        `✅ Owner set to: *${newNumber}*\n\n` +
        `_Any previous owners have been removed._`
      );
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
