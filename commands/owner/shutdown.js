const { shutdownNow } = require('../../utils/shutdown');

module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  category: 'owner',
  description: 'Forces the bot and server to stay offline.',
  ownerOnly: true,

  async execute(sock, msg, args, { from, reply }) {
    console.log('[ BOT ] Shutdown command received. Triggering Nuclear Shutdown...');

    try {
      await reply('☢️ *Nuclear Shutdown Engaged.* Forcing server offline...');
      // Wait 2 seconds so the message finishes sending before the socket closes.
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error('Error sending shutdown feedback:', e);
    }

    // Standard shutdown: graceful close (socket/queues/keep-alive/SQLite
    // flush+close) → arm the 3-kill chain → exit 44 (utils/shutdown.js).
    await shutdownNow();
  }
};
