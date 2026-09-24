const fs = require('fs');
const path = require('path');
const database = require('../../database');

module.exports = {
  name: 'setownername',
  aliases: ['setowner_name'],
  category: 'owner',
  description: 'Change the bot owner display name',
  usage: '.setownername <new name>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      let newName = '';

      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMsg) {
        newName = (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '').trim();
      } else {
        newName = args.join(' ').trim();
      }

      if (!newName) {
        const current = Array.isArray(database.getOwnerNames()) ? database.getOwnerNames()[0] : database.getOwnerNames();
        return extra.reply(`👑 *Set Owner Name*\n\nCurrent: *${current}*\n\nUsage: ${database.getBotSetting('prefix')}setownername <new name>`);
      }

      if (newName.length > 50) {
        return extra.reply('❌ Owner name must be 50 characters or less!');
      }

      // Assign, do not mutate. database.getOwnerNames() is a getter that builds a
      // fresh array from SQLite, so `database.getOwnerNames()[0] = x` would change a
      // throwaway copy. Assigning goes through the setter and persists.
      database.setOwnerNames([newName]);

      await extra.reply(`✅ Owner name changed to: *${newName}*`);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
