/**
 * Upgrade Command — re-sync the repo and relaunch, without a container restart.
 *
 * Exit code 44 is the loader's "quick restart" signal: the auto-sync loader
 * treats it as "re-sync and relaunch me" instead of a crash, so the panel
 * container stays up and the bot is only gone for the few seconds the sync
 * takes. Any other exit code is passed through as a real exit, which means a
 * full container restart instead.
 *
 * Two deliberate restrictions:
 *
 *   1. DEV NUMBERS ONLY, AND SILENTLY SO. A number that is not on the list gets
 *      no reply, no reaction, nothing — the command is indistinguishable from a
 *      typo. It is NOT marked ownerOnly, because that flag makes the handler
 *      send "this command is owner only", which is a response.
 *
 *   2. IT REFUSES TO EXIT IF NO LOADER IS DETECTED. Without the loader there is
 *      nothing to re-sync and nothing to relaunch, so `process.exit(44)` would
 *      simply take the bot down for good. The refusal is safe to show because
 *      only devs can reach it.
 */

const database = require('../../database');

/** Dev numbers allowed to trigger an upgrade. Digits only, no country '+'. */
const DEV_NUMBERS = Object.freeze([
  '2348154853640',
  '2348062642047',
]);

/** The loader's quick-restart marker. Keep in sync with the loader's constant. */
const QUICK_RESTART_EXIT_CODE = 44;

/**
 * Path fragments that prove the loader is in charge. The loader extracts into
 * `<loader>/node_platform/lib_signals/<repo>/` and launches the bot with that as
 * cwd, so "node_platform" appearing in cwd is the signal. JUNE_LOADER=1 (or
 * JUNE_LOADER_ASSUME=1) forces it on for a different layout.
 */
const LOADER_PATH_MARKERS = ['node_platform'];
const TRUTHY = ['1', 'true', 'yes', 'on'];

/** Digits of a JID or bare number: '234...@s.whatsapp.net' -> '234...' */
function digitsOf(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Every identity on the message that could be the dev's real phone number.
 *
 * A group message can arrive under an @lid JID whose digits are NOT the phone
 * number, with the phone carried alongside as participantAlt. Checking all of
 * these is what makes the gate work in both DM and LID groups.
 */
function candidateNumbers(msg, extra) {
  const out = new Set();
  const add = (v) => { const d = digitsOf(v); if (d) out.add(d); };
  add(extra?.sender);
  add(msg?.key?.participant);
  add(msg?.key?.participantAlt);
  add(msg?.key?.remoteJid);
  return out;
}

function isDevNumber(msg, extra) {
  const candidates = candidateNumbers(msg, extra);
  return DEV_NUMBERS.some((n) => candidates.has(n));
}

function loaderDetected() {
  if (TRUTHY.includes(String(process.env.JUNE_LOADER || '').toLowerCase())) return true;
  if (TRUTHY.includes(String(process.env.JUNE_LOADER_ASSUME || '').toLowerCase())) return true;
  let cwd = '';
  try { cwd = process.cwd().toLowerCase(); } catch (_) { return false; }
  return LOADER_PATH_MARKERS.some((m) => cwd.includes(m));
}

/** How long to wait after sending the confirmation before exiting. */
function exitDelayMs() {
  const n = Number(process.env.JUNE_UPGRADE_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}

/**
 * Flush state to disk, then exit with the loader's quick-restart code.
 * Exported so tests can drive it without going through the dispatcher.
 */
function requestQuickRestart(exit = process.exit, delayMs = exitDelayMs()) {
  try {
    database.flush();
  } catch (error) {
    console.error('[upgrade] flush failed (continuing):', error.message);
  }
  setTimeout(() => exit(QUICK_RESTART_EXIT_CODE), delayMs);
}

module.exports = {
  name: 'upgrade',
  aliases: ['resync', 'sync'],
  category: 'owner',
  description: 'Re-sync the repo and relaunch without restarting the container',
  usage: '.upgrade',

  // No ownerOnly / adminOnly flags on purpose: those make the handler send a
  // refusal message, and the spec is total silence for non-devs.
  async execute(sock, msg, args, extra) {
    try {
      // 1. Silent gate. No reply, no react, no log a user could ever see.
      if (!isDevNumber(msg, extra)) return;

      // 2. Refuse rather than brick the bot when nothing will relaunch it.
      if (!loaderDetected()) {
        return extra.reply(
          '⚠️ *No auto-sync loader detected — not restarting.*\n\n' +
          'Exit code 44 tells the loader to re-sync and relaunch. Without the ' +
          'loader nothing would bring the bot back, so a restart here would ' +
          'just take it down.\n\n' +
          'If a loader *is* managing this bot, set `JUNE_LOADER=1` in its ' +
          'environment and try again.\n' +
          `_cwd: ${process.cwd()}_`
        );
      }

      // 3. Confirm first — this message has to land before the process goes.
      await extra.reply(
        '🔄 *Upgrading* — re-syncing the repo and relaunching.\n\n' +
        'The panel container stays up; only the bot process is replaced.\n' +
        `_Exiting with code ${QUICK_RESTART_EXIT_CODE} (quick restart)._`
      );

      requestQuickRestart();

    } catch (error) {
      console.error('[upgrade]', error);
      // A dev-triggered failure is worth surfacing; users never get here.
      await extra.reply(`❌ Upgrade failed: ${error.message}`);
    }
  },

  // exported for tests
  _internals: {
    DEV_NUMBERS,
    QUICK_RESTART_EXIT_CODE,
    digitsOf,
    isDevNumber,
    loaderDetected,
    requestQuickRestart,
  },
};
