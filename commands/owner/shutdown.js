/**
 * `.shutdown` — take the whole bot down and keep it down.
 *
 * DEV NUMBERS ONLY, AND SILENTLY SO. Anyone else gets no reply, no reaction,
 * nothing. That is why this command is not marked `ownerOnly`: the handler
 * answers that flag with an "owner only" message, which is a response. The gate
 * lives here and returns.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Replies to the dev who asked.
 *   2. Runs the graceful close (platform/loader.js → global.__JUNE_SHUTDOWN,
 *      registered by index.js): every socket ended properly, group counters
 *      flushed, every bot's JSON store written, HTTP server released. This is
 *      the step the old utils/shutdown.js only *described* — index.js never
 *      registered the global it was looking for, so nothing ever ran it.
 *   3. Exits 45: the loader keeps the bot down instead of relaunching it.
 *
 * WHY THIS IS NOT AN OWNER COMMAND
 * --------------------------------
 * Jtest is one process running up to 100 bots. Exiting from any chat therefore
 * kills every bot, not just the one the sender is talking to — that is a dev
 * decision, not a tenant decision, so the allowlist is the two dev numbers.
 * (`.restart` is the command that acts on one bot only.)
 */

const loader = require('../../platform/loader');
const { isDev } = require('../../utils/devs');

module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  category: 'owner',
  description: 'Shut the bot down and keep it down (devs only)',
  usage: '.shutdown',

  // No ownerOnly — see the header. The dev gate is inside execute().
  async execute(sock, msg, args, extra) {
    try {
      // Silent for everyone who is not a dev.
      if (!isDev(msg, extra)) return;

      await extra.reply(
        '☢️ *Shutting down.*\n\n' +
        'Every bot on this process is going offline and will stay offline until ' +
        'the server is started again.\n' +
        `_Exiting with code ${loader.STAY_DOWN} (stay down)._`
      );

      // Sockets are ended, queues flushed and every store written HERE — the
      // reply above has already gone out, so it cannot be cut off by this.
      await loader.gracefulClose();

      loader.exitForShutdown();

    } catch (error) {
      console.error('[shutdown]', error);
      await extra.reply(`❌ Shutdown failed: ${error.message}`);
    }
  },
};
