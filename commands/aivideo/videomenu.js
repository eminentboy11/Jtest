const database = require('../../database');

module.exports = {
  name: 'videomenu',
  aliases: ['vidmenu', 'aividmenu', 'videoeffects'],
  description: 'Show AI video effect commands',
  category: 'aivideo',
  usage: `${database.getBotSetting('prefix') || '.'}videomenu`,

  async execute(sock, msg, args, extra = {}) {
    const jid = msg.key.remoteJid;
    const prefix = extra.prefix || database.getBotSetting('prefix') || '.';
    const commandsText = [
      '🎬 AI video commands',
      '',
      `${prefix}tigervideo`,
      `${prefix}introvideo`,
      `${prefix}lightningpubg`,
      `${prefix}lovevideo`,
      `${prefix}videogen`,
    ].join('\n');

    return sock.sendMessage(jid, { text: commandsText }, { quoted: msg });
  },
};