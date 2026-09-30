module.exports = {
  name: 'restart',
  aliases: ['reboot'],
  category: 'owner',
  description: 'Restart the bot.',
  ownerOnly: true,

  async execute(sock, msg, args, { reply }) {
    await reply('🔄 Restarting...');
    // Give the reply time to land before the process goes down.
    setTimeout(() => process.exit(1), 2000);
  }
};
