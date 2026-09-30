/**
 * `.shutdown` — take the whole bot down and keep it down.
 *
 * DEV NUMBERS ONLY, AND SILENTLY SO. Anyone else gets no reply, no reaction,
 * nothing. That is why this command is not marked `ownerOnly`: the handler
 * answers that flag with an "owner only" message, which is a response. The gate
 * lives here and returns.
 *
 * WHY THIS IS NOT AN OWNER COMMAND ANY MORE
 * -----------------------------------------
 * Jtest is one process running up to 100 bots. `process.exit()` from any chat
 * therefore kills every bot, not just the one the sender is talking to — and
 * `.shutdown` kills the server on purpose. That is a dev decision, not a
 * tenant decision, so the allowlist moved to the two dev numbers. (`.restart`
 * is the command that acts on one bot only; see commands/owner/restart.js.)
 *
 * WHY EXIT 45 AND NOT THE OLD KILL CHAIN
 * --------------------------------------
 * The chain lived in utils/shutdown.js: write a state file, exit, and let the
 * *next* boot kill itself again — three boots total — to outlast a supervisor
 * that auto-restarts everything. That was the right idea in the wrong process.
 * A bot that is exiting cannot guarantee it will be the one to come back (a
 * failed sync, a crash, a panel restart in between), so the loader owns it now:
 * exit 45 tells the loader "do not relaunch me", and the loader re-arms the
 * countdown from its own side. See README → "Loader protocol".
 */

const sessionService = require('../../platform/sessionService');
const loader = require('../../platform/loader');
const { isDev } = require('../../utils/devs');

/**
 * Close every bot's socket before the process goes.
 *
 * Worth the two lines: WhatsApp notices a clean close instead of a dropped
 * connection, and the sessions do not look like a crash on the phone. A failure
 * here is never fatal — the exit happens either way.
 */
async function closeSockets() {
  try {
    if (!sessionService.configured()) return;
    for (const bot of sessionService.list()) {
      try { await sessionService.stop(bot.id); } catch (_) { /* best effort */ }
    }
  } catch (error) {
    console.error('[shutdown] socket close failed (continuing):', error.message);
  }
}

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

      await closeSockets();
      loader.exitForShutdown();

    } catch (error) {
      console.error('[shutdown]', error);
      await extra.reply(`❌ Shutdown failed: ${error.message}`);
    }
  },
};
