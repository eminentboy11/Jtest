'use strict';

/**
 * .setgoodbye — customize the goodbye message template.
 *
 * The goodbye counterpart of .setwelcome: same variables, same nopp mode,
 * same reset.
 */

const database = require('../../database');

module.exports = {
  name: 'setgoodbye',
  aliases: ['goodbyetext'],
  category: 'admin',
  description: 'Set the goodbye message or reset it to the default',
  usage: '.setgoodbye <message> | .setgoodbye reset',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const gs = database.getGroupSettings(extra.from);

      if (!args.length) {
        return extra.reply(
          '📝 *Goodbye Settings*\n\n' +
          `*Message:*\n${gs.goodbyeMessage}\n\n` +
          '*Variables you can use:*\n' +
          "• @user — member's phone number\n" +
          '• @group — group name\n' +
          '• groupDesc — group description\n' +
          '• time — current time\n' +
          '• #memberCount — member count\n' +
          '• botName — bot name\n\n' +
          '*Commands:*\n' +
          '• .setgoodbye <message> — set custom message\n' +
          '• .setgoodbye reset — restore default message'
        );
      }

      const input = args.join(' ').trim();

      if (input.toLowerCase() === 'reset') {
        database.updateGroupSettings(extra.from, {
          goodbyeMessage: database.getDefaultGroupSettings().goodbyeMessage,
        });
        return extra.reply('✅ Goodbye message reset to default.');
      }

      if (input.length > 500) {
        return extra.reply('❌ Goodbye message is too long! Maximum 500 characters.');
      }

      database.updateGroupSettings(extra.from, { goodbyeMessage: input });

      const preview = input
        .replace(/@user/g, '@' + String(msg.key.participant || msg.key.remoteJid).split('@')[0])
        .replace(/@group/g, extra.groupMetadata?.subject || 'This Group')
        .replace(/groupDesc/g, extra.groupMetadata?.desc || 'Group description here')
        .replace(/time/g, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }))
        .replace(/#memberCount/g, String(extra.groupMetadata?.participants?.length || '?'))
        .replace(/botName/g, database.getBotSetting('botName'));

      await extra.reply(`✅ Goodbye message updated!\n\n*Preview:*\n${preview}`);
    } catch (error) {
      console.error('[setgoodbye]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
