'use strict';

/**
 * The auto-sync loader protocol.
 *
 * Jtest does not supervise itself. The loader that pulls the repo and launches
 * this bot owns the lifecycle: it decides whether a process that just exited
 * should come back, and how. All Jtest has to do is speak the protocol on the
 * way out — which is this file, and nothing more. The old
 * `utils/shutdown.js` was deleted with the rest of the orchestration (graceful
 * close, the 3-kill chain) because that work belongs to the process that is
 * still alive to do it. A dying process cannot restart itself.
 *
 * Exit codes
 * ----------
 *   44  QUICK_RESTART   re-sync the repo and relaunch me.
 *                       The panel container stays up, so the bot is only gone
 *                       for the seconds the sync takes. Used by `.upgrade`.
 *
 *   45  STAY_DOWN       do not relaunch me. Used by `.shutdown`.
 *
 * Anything else is an ordinary exit, and the loader treats it as one.
 *
 * `STAY_DOWN` only means anything if the loader implements it: a plain exit
 * still leaves the panel's own restart policy in charge, which is why the
 * loader-side snippet in the README re-arms the chain from the loader rather
 * than trusting the bot to have survived.
 *
 * Why 44 rather than restarting in-process
 * ----------------------------------------
 * Command files are loaded once into a shared table (handler.js owns the single
 * Map), so no in-process restart can pick up new code. Only an exit that the
 * loader acts on can.
 */

/** Re-sync and relaunch me. The loader's fast path. */
const QUICK_RESTART = 44;
/** Do not relaunch me. */
const STAY_DOWN = 45;

/** How long a command waits for its own reply to land before exiting. */
function exitDelayMs(envVar = 'JUNE_EXIT_DELAY_MS', fallback = 2000) {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Flush state, then exit with `code` after `delayMs`. `database.js` already
 * registers its own `process.on('exit')` flush (registered so groupstats'
 * listener writes first), so there is nothing to flush here — this is purely
 * "let the reply land, then go".
 */
function exitWith(code, { delayMs, exit = process.exit } = {}) {
  const wait = delayMs === undefined ? exitDelayMs() : delayMs;
  setTimeout(() => exit(code), wait);
}

/** `.upgrade` — reload the code. */
function exitForUpgrade(opts = {}) {
  return exitWith(opts.code || QUICK_RESTART, {
    delayMs: opts.delayMs === undefined ? exitDelayMs('JUNE_UPGRADE_DELAY_MS', 1500) : opts.delayMs,
    exit: opts.exit,
  });
}

/** `.shutdown` — stop for good. */
function exitForShutdown(opts = {}) {
  return exitWith(opts.code || STAY_DOWN, {
    delayMs: opts.delayMs === undefined ? exitDelayMs('JUNE_SHUTDOWN_DELAY_MS', 2000) : opts.delayMs,
    exit: opts.exit,
  });
}

module.exports = {
  QUICK_RESTART,
  STAY_DOWN,
  exitWith,
  exitForUpgrade,
  exitForShutdown,
};
