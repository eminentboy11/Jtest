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

/** Close budget. A stuck close must never hold the shutdown open. */
const CLOSE_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`close timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Run everything that must happen before the process dies, and NOTHING about
 * how it dies — the caller picks the exit code.
 *
 * index.js registers the routine as `global.__JUNE_SHUTDOWN`: close every bot
 * socket cleanly, flush the queue, flush group counters, write every bot's JSON
 * store synchronously, release the HTTP server, close the command watcher. This
 * is the step utils/shutdown.js described but could never actually run, because
 * index.js never registered the global it was looking for — so every shutdown
 * in this repo until now exited raw, mid-write.
 *
 * Fail-open, always: a missing routine, a throwing routine or a routine that
 * hangs is logged and the caller still exits. A shutdown that cannot complete
 * must never become a shutdown that does not happen.
 *
 * Test hooks: log, timeoutMs, exit-through `global.__JUNE_SHUTDOWN`.
 */
async function gracefulClose({ timeoutMs = CLOSE_TIMEOUT_MS, log = console.log } = {}) {
  const routine = typeof global.__JUNE_SHUTDOWN === 'function' ? global.__JUNE_SHUTDOWN : null;

  if (!routine) {
    log('[ SHUTDOWN ] No close routine registered — exiting without a graceful close.');
    return { ok: false, reason: 'no-routine' };
  }

  try {
    await withTimeout(routine(), timeoutMs);
    log('[ SHUTDOWN ] Graceful close finished — sockets ended, store flushed.');
    return { ok: true };
  } catch (error) {
    log(`[ SHUTDOWN ] Graceful close ended with error (${error.message}) — exiting anyway.`);
    return { ok: false, reason: error.message };
  }
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
  CLOSE_TIMEOUT_MS,
  gracefulClose,
  exitWith,
  exitForUpgrade,
  exitForShutdown,
};
