/**
 * `.upgrade` — pull the latest `main` and relaunch, without restarting the
 * container.
 *
 * DEV NUMBERS ONLY, AND SILENTLY SO. A number that is not on the allowlist gets
 * no reply, no reaction, nothing — the command is indistinguishable from a
 * typo. It is NOT marked ownerOnly, because that flag makes the handler send
 * "this command is owner only", which is a response. See utils/devs.js.
 *
 * WHY THIS IS NOT `.restart`
 * --------------------------
 * `.restart` reboots one bot's socket inside the running process; it cannot pick
 * up a new commit, because the command table is loaded once and shared. This
 * command exits with code 44 — the loader's "re-sync and relaunch me" signal —
 * which is the only path that fetches new code. It brings every bot back, since
 * they all live in the one process.
 *
 * The 44 is not hardcoded here: `platform/loader.js` owns the protocol, and a
 * test asserts the two cannot drift.
 */

const loader = require('../../platform/loader');
const { isDev } = require('../../utils/devs');

/**
 * Path fragments that prove the loader is in charge. The loader extracts into
 * `<loader>/node_platform/lib_signals/<repo>/` and launches the bot with that as
 * cwd, so "node_platform" appearing in cwd is the signal. JUNE_LOADER=1 (or
 * JUNE_LOADER_ASSUME=1) forces it on for a different layout.
 */
const LOADER_PATH_MARKERS = ['node_platform'];
const TRUTHY = ['1', 'true', 'yes', 'on'];

function loaderDetected() {
  if (TRUTHY.includes(String(process.env.JUNE_LOADER || '').toLowerCase())) return true;
  if (TRUTHY.includes(String(process.env.JUNE_LOADER_ASSUME || '').toLowerCase())) return true;
  let cwd = '';
  try { cwd = process.cwd().toLowerCase(); } catch (_) { return false; }
  return LOADER_PATH_MARKERS.some((m) => cwd.includes(m));
}

module.exports = {
  name: 'upgrade',
  aliases: ['resync', 'sync'],
  category: 'owner',
  description: 'Re-sync the repo and relaunch without restarting the container',
  usage: '.upgrade',

  // No ownerOnly — the dev gate is inside execute().
  async execute(sock, msg, args, extra) {
    try {
      // 1. Silent gate. No reply, no react, no log a user could ever see.
      if (!isDev(msg, extra)) return;

      // 2. Refuse rather than brick the bot when nothing will relaunch it.
      if (!loaderDetected()) {
        return extra.reply(
          '⚠️ *No auto-sync loader detected — not restarting.*\n\n' +
          `Exit code ${loader.QUICK_RESTART} tells the loader to re-sync and relaunch. ` +
          'Without the loader nothing would bring the bot back, so a restart here ' +
          'would just take it down.\n\n' +
          'If a loader *is* managing this bot, set `JUNE_LOADER=1` in its ' +
          'environment and try again.\n' +
          `_cwd: ${process.cwd()}_`
        );
      }

      // 3. Confirm first — this message has to land before the process goes.
      await extra.reply(
        '🔄 *Upgrading* — re-syncing the repo and relaunching every bot.\n\n' +
        'The panel container stays up; only the bot process is replaced.\n' +
        `_Exiting with code ${loader.QUICK_RESTART} (quick restart)._`
      );

      // Close cleanly before exiting, exactly like .shutdown: 100 sockets
      // dropped abruptly look like a crash to WhatsApp, and the store's
      // debounce window would be cut short. The loader is about to relaunch
      // every one of them, so they should go down properly first.
      await loader.gracefulClose();

      loader.exitForUpgrade();

    } catch (error) {
      console.error('[upgrade]', error);
      // A dev-triggered failure is worth surfacing; users never get here.
      await extra.reply(`❌ Upgrade failed: ${error.message}`);
    }
  },

  // exported for tests
  _internals: {
    loaderDetected,
    LOADER_PATH_MARKERS,
  },
};
