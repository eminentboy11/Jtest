'use strict';

/**
 * Console policy — what Jtest prints, and what it keeps quiet unless DEBUG=true.
 *
 * The rule for this repo: the console is for things a human must ACT on. If you
 * cannot do anything with a line, it is debug output.
 *
 *   ALWAYS (visible with DEBUG unset)
 *     - the startup box                 index.js banner
 *     - errors                          console.error, and the error-code paths
 *                                       (401 logout, failed restore, a handler
 *                                       that never loaded)
 *     - `[ <botId> ] ✅ Connected as …`  one line per bot coming online
 *     - pairing codes                   you cannot pair without seeing them
 *     - `.upgrade` / `.shutdown` / `.restart`
 *                                       the three process commands, and their
 *                                       loader-side exit/chain lines — rare, and
 *                                       each one ends the process
 *
 *   DEBUG=true
 *     - every message that flows through the handler
 *     - every command invocation
 *     - reconnect / backoff / watchdog chatter
 *     - boot bookkeeping, session provisioning, archiving, GC sweeps
 *
 * Previously these were raw console.log calls sprinkled through index.js,
 * handler.js and platform/*, which is why a bot doing nothing still filled the
 * panel with a line per inbound message.
 */

const TRUTHY = ['true', '1', 'yes', 'on'];

const DEBUG = TRUTHY.includes(String(process.env.DEBUG || '').trim().toLowerCase());

/** Chatter. Silent unless DEBUG=true. */
function debug(...args) {
  if (DEBUG) console.log(...args);
}

/** Always shown. Use sparingly — see the policy above. */
function info(...args) {
  console.log(...args);
}

/** Always shown, on stderr. Errors are never suppressed. */
function error(...args) {
  console.error(...args);
}

/** True when debug logging is on — for call sites doing expensive formatting. */
const enabled = () => DEBUG;

module.exports = { debug, info, error, enabled, DEBUG };
