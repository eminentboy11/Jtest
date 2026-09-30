/**
 * `.restart` — reboot THE SENDER'S OWN BOT, not the process.
 *
 * Jtest is one process running up to 100 bots behind a shared handler, so this
 * command must never call `process.exit()`: that would drop every other tenant
 * to fix one. `platform/sessionService.reconnect(botId)` is the right tool —
 * it bumps the bot's boot generation, tears down the old socket and reboots
 * that one session. Siblings do not notice it happened.
 *
 * THE BOT ID COMES FROM THE MESSAGE, NOT FROM ARGUMENTS
 * ----------------------------------------------------
 * `global.__BOT_ID__` is set by index.js around every dispatch, inside the same
 * `runAsBot()` scope, so it is always the bot that received the message. This
 * command takes no id argument by design: an owner being able to name someone
 * else's bot would be exactly the cross-tenant hole this rewrite exists to
 * close.
 *
 * OWNER OF *THAT* BOT ONLY. `database.getOwners()` is resolved per bot through
 * AsyncLocalStorage, so "owner" here is the owner of the bot being restarted.
 * Everyone else is ignored silently — same rule as `.upgrade` and `.shutdown`.
 *
 * WHAT THIS CANNOT DO: load new code. Command files are read once into a shared
 * table, so only `.upgrade` (loader re-sync) picks up a new commit. `.restart`
 * is for a stuck socket, a wedged session, a reconnect loop.
 */

const sessionService = require('../../platform/sessionService');

module.exports = {
  name: 'restart',
  aliases: ['reboot'],
  category: 'owner',
  description: 'Restart this bot only, leaving every other bot running',
  usage: '.restart',

  // Not ownerOnly: that flag makes the handler send a refusal, and non-owners
  // are ignored silently here (see the header).
  async execute(sock, msg, args, extra) {
    try {
      const botId = global.__BOT_ID__;

      // No dispatcher scope (direct call, test, or a future non-message caller):
      // refuse rather than guess an id and restart the wrong bot.
      if (!botId) {
        await extra.reply('⚠️ I could not tell which bot this is, so I did not restart anything.');
        return;
      }

      if (!extra.isOwner) return;   // silent for everyone else

      if (!sessionService.configured() || !sessionService.get(botId)) {
        await extra.reply('⚠️ This bot is not managed by the session service — nothing to restart.');
        return;
      }

      await extra.reply(`🔄 Restarting *${botId}* only — every other bot stays online.`);

      const result = await sessionService.reconnect(botId);
      if (!result || result.ok === false) {
        await extra.reply(`❌ Restart did not take: ${(result && result.reason) || 'unknown reason'}`);
      }

    } catch (error) {
      console.error('[restart]', error);
      await extra.reply(`❌ Restart failed: ${error.message}`);
    }
  },
};
