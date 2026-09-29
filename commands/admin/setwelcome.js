'use strict';

/**
 * .setwelcome — customize the welcome message template.
 *
 * Ported from ..wdp/commands/admin/setwelcome.js: message templates support
 * @user, @group, groupDesc, time, #memberCount and botName variables, plus a
 * "nopp" mode that sends text without the member's profile photo.
 */

const database = require('../../database');

module.exports = {
  name: 'setwelcome',
  aliases: ['welcometext'],
  category: 'admin',
  description: 'Set the welcome message, toggle no-photo mode, or reset',
  usage: '.setwelcome <message> | .setwelcome nopp | .setwelcome reset',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const gs = database.getGroupSettings(extra.from);

      // No args: show the current template and the variable cheatsheet.
      if (!args.length) {
        const noppStatus = gs.welcomeNoPP ? '✅ ON (text only)' : '❌ OFF (with profile photo)';
        return extra.reply(
          '📝 *Welcome Settings*\n\n' +
          `*Message:*\n${gs.welcomeMessage}\n\n` +
          `*No-photo mode (nopp):* ${noppStatus}\n\n` +
          '*Variables you can use:*\n' +
          "• @user — member's phone number\n" +
          '• @group — group name\n' +
          '• groupDesc — group description\n' +
          '• time — current time\n' +
          '• #memberCount — member count\n' +
          '• botName — bot name\n\n' +
          '*Commands:*\n' +
          '• .setwelcome <message> — set custom message\n' +
          '• .setwelcome nopp — toggle no-photo mode\n' +
          '• .setwelcome reset — restore default message'
        );
      }

      const input = args.join(' ').trim();

      if (input.toLowerCase() === 'nopp') {
        const newNoPP = !gs.welcomeNoPP;
        database.updateGroupSettings(extra.from, { welcomeNoPP: newNoPP });
        return extra.reply(
          `🖼️ *No-photo mode* is now *${newNoPP ? 'ON' : 'OFF'}*.\n\n` +
          (newNoPP
            ? 'Welcome & goodbye messages will be sent as *text only* (no profile photo).'
            : 'Welcome & goodbye messages will include the *member profile photo* (or group photo as fallback).')
        );
      }

      if (input.toLowerCase() === 'reset') {
        database.updateGroupSettings(extra.from, {
          welcomeMessage: database.getDefaultGroupSettings().welcomeMessage,
        });
        return extra.reply('✅ Welcome message reset to default.');
      }

      if (input.length > 500) {
        return extra.reply('❌ Welcome message is too long! Maximum 500 characters.');
      }

      database.updateGroupSettings(extra.from, { welcomeMessage: input });

      // Show a live preview so admins see the variables fill in.
      const preview = input
        .replace(/@user/g, '@' + String(msg.key.participant || msg.key.remoteJid).split('@')[0])
        .replace(/@group/g, extra.groupMetadata?.subject || 'This Group')
        .replace(/groupDesc/g, extra.groupMetadata?.desc || 'Group description here')
        .replace(/time/g, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }))
        .replace(/#memberCount/g, String(extra.groupMetadata?.participants?.length || '?'))
        .replace(/botName/g, database.getBotSetting('botName'));

      await extra.reply(`✅ Welcome message updated!\n\n*Preview:*\n${preview}`);
    } catch (error) {
      console.error('[setwelcome]', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
