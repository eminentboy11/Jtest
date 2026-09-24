/**
 * NUCLEAR SHUTDOWN — self-contained 3-kill chain.
 *
 * The process supervisor (panel/pm2/docker) auto-restarts the bot, so a single
 * process.exit() can never keep it offline. The chain persists a small state
 * file that survives restarts and re-kills the process on every boot until
 * the count is spent:
 *
 *   .shutdown (command)  → kill 1/3 — writes { killsLeft: 2 }, then exit(44)
 *   supervisor reboot    → kill 2/3 — chain sees 2, writes 1, exit(44)
 *   supervisor reboot    → kill 3/3 — chain sees 1, deletes state, exit(44)
 *   supervisor reboot    → no state file → boots normally and STAYS ALIVE
 *
 * State file: database/shutdown-state.json
 * Lives inside `database/` on purpose — the loader's mirror-clean wipes the
 * whole bot folder on every sync but never touches its SKIP_DIRS
 * (data/session/database). A state file in the bot root would be deleted on
 * the first restart and the chain would break.
 *
 * Rules:
 *   - Only fs/path/process — no DB, no Baileys, no dotenv. Runs at the very
 *     top of index.js, before anything else, so the bot dies in the same
 *     tick and never touches auth or connects to WhatsApp during the chain.
 *   - The kill is a SYNCHRONOUS process.exit: index.js is plain top-level
 *     code, so a delayed exit would let it keep booting (half-start). The
 *     kill-path log uses fs.writeSync(2, ...) for the same reason — a normal
 *     console.log can be lost when process.exit() runs in the same tick on a
 *     pipe (pm2/docker log capture).
 *   - Fail-open: any read/parse error → delete state, boot normally. The
 *     helper can never brick the bot.
 *   - Exit code 44 throughout (legacy "Pterodactyl Trap" marker).
 *   - No TTL: the state is trusted until the chain completes naturally.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXIT_CODE = 44;
/** Kills performed by enforceShutdownChain() after the command's own exit. */
const KILLS_AFTER_COMMAND = 2;
/** Total kills per nuclear shutdown (command exit + re-kills). */
const TOTAL_KILLS = KILLS_AFTER_COMMAND + 1;
const STATE_FILE = path.join(__dirname, '..', 'database', 'shutdown-state.json');

/**
 * Kill-path logger: synchronous write to stdout (fd 1) — the channel
    console views reliably show. Safe to call immediately
 * before a same-tick process.exit() even when stderr is a pipe.
 */
function defaultFatalLog(line) {
  try {
    fs.writeSync(1, line + '\n');
  } catch (_) {
    /* stderr unavailable — the exit still happens */
  }
}

/**
 * Called by the .shutdown command. Persists the chain state so the next two
 * boots re-kill the process. Returns true on success. A failed write is not
 * fatal — the command still exits, the restart is just one-shot.
 */
function requestShutdown(opts = {}) {
  const stateFile = opts.stateFile || STATE_FILE;
  const log = opts.log || console.log;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ killsLeft: KILLS_AFTER_COMMAND, at: Date.now() }, null, 2),
      'utf8'
    );
    log(`[SHUTDOWN] Nuclear shutdown requested — ${KILLS_AFTER_COMMAND} re-kill(s) queued.`);
    return true;
  } catch (e) {
    log(`[SHUTDOWN] WARNING: failed to write shutdown state (${e.message}) — restart will be one-shot.`);
    return false;
  }
}

/**
 * Called at the very top of index.js (before dotenv, before everything).
 * If a nuclear chain is pending, decrements it and exits(44) synchronously.
 * No state file (or a corrupt/spent one) → returns so the bot boots normally.
 *
 * Test hooks via opts: stateFile, log, fatalLog, exit.
 */
function enforceShutdownChain(opts = {}) {
  const stateFile = opts.stateFile || STATE_FILE;
  const log = opts.log || defaultFatalLog;
  const fatalLog = opts.fatalLog || defaultFatalLog;
  const exit = opts.exit || process.exit;

  try {
    if (!fs.existsSync(stateFile)) return; // normal boot

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const killsLeft = Number(state && state.killsLeft);

    if (!Number.isInteger(killsLeft) || killsLeft < 1) {
      // Corrupt or already spent — clear it and boot normally (fail-open).
      fs.unlinkSync(stateFile);
      log('[SHUTDOWN] Stale/corrupt shutdown state cleared — booting normally.');
      return;
    }

    const killNumber = TOTAL_KILLS - killsLeft + 1; // killsLeft 2 → kill 2/3, 1 → kill 3/3
    if (killsLeft > 1) {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ killsLeft: killsLeft - 1, at: Date.now() }, null, 2),
        'utf8'
      );
      fatalLog(`[SHUTDOWN] Nuclear chain kill ${killNumber}/${TOTAL_KILLS} — exiting again (${killsLeft - 1} re-kill(s) left).`);
    } else {
      fs.unlinkSync(stateFile);
      fatalLog(`[SHUTDOWN] Nuclear chain kill ${killNumber}/${TOTAL_KILLS} — final kill, state cleared.`);
    }
    exit(EXIT_CODE);
  } catch (e) {
    // Fail-open: never let the helper brick the bot.
    try { fs.unlinkSync(stateFile); } catch (_) { /* already gone */ }
    log(`[SHUTDOWN] Chain check failed (${e.message}) — clearing state and booting normally.`);
  }
}

/**
 * Standard shutdown orchestration — the .shutdown command calls this.
 *
 *   1. Graceful close: runs global.__JUNE_SHUTDOWN (registered by index.js —
 *      the same routine SIGINT/SIGTERM use: socket close, queue flushes,
 *      keep-alive server close, SQLite flush+close). Guarded by a timeout so
 *      a stuck close can never hang the shutdown. Missing/throwing routine
 *      is not fatal (fail-open) — the exit still happens.
 *   2. Arms the 3-kill chain (state file) so the supervisor's auto-restart
 *      can't resurrect the bot.
 *   3. process.exit(44). The boot-time chain performs kills 2 and 3.
 *
 * Test hooks via opts: stateFile, log, exit, timeoutMs.
 */
async function shutdownNow(opts = {}) {
  const log = opts.log || console.log;
  const exit = opts.exit || process.exit;
  const timeoutMs = opts.timeoutMs === undefined ? 10000 : opts.timeoutMs;

  try {
    const routine = typeof global.__JUNE_SHUTDOWN === 'function' ? global.__JUNE_SHUTDOWN : null;
    if (routine) {
      await withTimeout(routine(), timeoutMs);
    } else {
      log('[SHUTDOWN] No graceful routine registered — skipping close, exiting raw.');
    }
  } catch (e) {
    log(`[SHUTDOWN] Graceful close ended with error (${e.message}) — proceeding to exit.`);
  }

  requestShutdown(opts);
  exit(EXIT_CODE);
}

/** Promise timeout guard: rejects after ms so a stuck routine can't hang us. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

module.exports = {
  EXIT_CODE,
  KILLS_AFTER_COMMAND,
  TOTAL_KILLS,
  STATE_FILE,
  requestShutdown,
  enforceShutdownChain,
  shutdownNow,
};
