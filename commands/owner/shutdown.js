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
 *   1. Tells every bot's owner, from that bot, that the server is going down.
 *      Without this the 99 tenants who did not type the command just watch
 *      their bot go silent — no reason, no warning. Notification is
 *      best-effort and bounded: send failures and a slow network cannot hold
 *      the shutdown open. JUNE_SHUTDOWN_NOTICE=0 turns it off.
 *   2. Runs the real graceful close (platform/loader.js → global.__JUNE_SHUTDOWN,
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

const sessionService = require('../../platform/sessionService');
const database = require('../../database');
const loader = require('../../platform/loader');
const { isDev } = require('../../utils/devs');

const NOTICE = [
  '🔌 *Server going offline*',
  '',
  'The bot platform is being shut down by its operator. This bot will be ' +
  'offline until the server is started again — commands will not answer in ' +
  'the meantime.',
].join('\n');

/** How long the whole notification pass may take before it is abandoned. */
function noticeBudgetMs() {
  const n = Number(process.env.JUNE_SHUTDOWN_NOTICE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 8000;
}

/**
 * DM every bot's first owner from that bot. Returns how many actually sent.
 *
 * Bounded twice: a global race against noticeBudgetMs, and a per-bot try/catch,
 * so one dead socket cannot stall the others. Nothing here is fatal — the
 * shutdown proceeds whether this works or not.
 */
async function notifyOwners() {
  if (String(process.env.JUNE_SHUTDOWN_NOTICE || '').trim() === '0') return 0;

  let bots = [];
  try { bots = sessionService.configured() ? sessionService.list() : []; } catch (_) { return 0; }
  if (!bots.length) return 0;

  const sends = bots.map(async (entry) => {
    try {
      const sock = sessionService.get(entry.id)?.sock;
      if (!sock) return 0;
      const owners = await database.runAsBot(entry.id, async () => database.getOwners());
      if (!owners || !owners.length) return 0;
      const first = String(owners[0]);
      const jid = first.includes('@') ? first : `${first.replace(/\D/g, '')}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: NOTICE });
      return 1;
    } catch (_) {
      return 0;   // best effort: a bot with no socket or no owner is skipped
    }
  });

  const raced = await Promise.race([
    Promise.allSettled(sends),
    new Promise((resolve) => setTimeout(() => resolve(null), noticeBudgetMs())),
  ]);

  if (!Array.isArray(raced)) return 0;   // budget spent — do not wait any longer
  return raced.filter((r) => r.status === 'fulfilled' && r.value === 1).length;
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
        'the server is started again. Owners are being notified.\n' +
        `_Exiting with code ${loader.STAY_DOWN} (stay down)._`
      );

      const notified = await notifyOwners();
      if (notified) console.log(`[ SHUTDOWN ] Notified ${notified} bot owner(s).`);

      // Sockets are ended, queues flushed and every store written HERE — the
      // reply above has already gone out, so it cannot be cut off by this.
      await loader.gracefulClose();

      loader.exitForShutdown();

    } catch (error) {
      console.error('[shutdown]', error);
      await extra.reply(`❌ Shutdown failed: ${error.message}`);
    }
  },

  // exported for tests
  _internals: { notifyOwners, noticeBudgetMs, NOTICE },
};
