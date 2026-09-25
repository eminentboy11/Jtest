'use strict';

/**
 * Silence libsignal's routine session chatter.
 *
 * Baileys bundles libsignal, and libsignal logs straight to console.warn /
 * console.info instead of going through the pino logger we hand to
 * makeWASocket. That means `pino({ level: 'fatal' })` cannot touch it: on a
 * live bot every session ratchet prints lines like
 *
 *   Closing open session in favor of incoming prekey bundle
 *   Closing session: SessionEntry { _chains: { ... }, currentRatchet: { ... } }
 *
 * and the second one dumps the whole SessionEntry across a dozen lines of
 * base64 and hex, which floods hosted consoles until real errors scroll off.
 *
 * So we wrap the console methods libsignal uses and drop only the routine
 * session-lifecycle lines. Anything that signals an actual problem — decrypt
 * failures, malformed public keys, storage migration errors — still prints.
 *
 * Set JUNE_LIBSIGNAL_LOG=1 to see the original output again while debugging.
 */

// Routine lifecycle: fires during normal ratchets and session turnover, not on
// failure. Several of these pass the session record as a second argument,
// which is what produces the multi-line dump, so dropping the call drops it.
const ROUTINE = [
  /^Closing open session in favor of incoming prekey bundle/, // session_builder.js
  /^Closing session:/,          // session_record.js — dumps the SessionEntry
  /^Opening session:/,          // session_record.js — same dump
  /^Removing old closed session:/,
  /^Session already closed/,
  /^Session already open/,
  /^Migrating session to:/,
  /^Unhandled bucket type/,     // queue_job.js
];

// Failures stay visible but FLOOD-CONTROLLED, because a desynced session can
// repeat them dozens of times per minute with a full stack each — exactly
// what buried the VPS console after status-reply Bad MAC storms:
//   session_cipher.js "Session error:..." + stack           (Bad MAC etc.)
//   session_cipher.js "Failed to decrypt message with any known session..."
// The first failure in a window prints as ONE line (stack dropped); repeats
// inside the window are counted and the count rides on the next printed line.
// Still fully visible, never a wall of stacks.
//
// Printed verbatim (each one means something different went wrong):
//   curve.js          "WARNING: Expected pubkey of length 33..."
//   session_cipher.js "Decrypted message with closed session."
//   session_record.js "V1 session storage migration error: ..."

let installed = false;

/**
 * Wrap the console methods libsignal writes to. Idempotent, and a no-op when
 * JUNE_LIBSIGNAL_LOG asks for the raw output.
 */
function install() {
  if (installed) return;
  installed = true;

  const enabled = process.env.JUNE_LIBSIGNAL_LOG;
  if (enabled === '1' || enabled === 'true') return;

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = function silenced(...args) {
      const first = args[0];
      if (typeof first === 'string' && ROUTINE.some((re) => re.test(first))) return;
      const decision = decideFailure(first);
      if (decision) {
        if (!decision.print) return;
        return original(decision.line);
      }
      return original(...args);
    };
  }
}

// ── Failure flood control ────────────────────────────────────────────────────
const FAILURE = [
  /^Session error:/,                                    // session_cipher.js (Bad MAC …)
  /Failed to decrypt message with any known session/,   // session_cipher.js
];
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
let failureWindowStart = 0;
let failureSuppressed = 0;

/**
 * Pure-ish decision maker (state lives in the two counters above).
 * Returns null for lines that are not session failures (print verbatim),
 * otherwise { print, line } — print once per window, one line, no stack.
 */
function decideFailure(first, now = Date.now()) {
  if (typeof first !== 'string' || !FAILURE.some((re) => re.test(first))) return null;
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    const line = String(first).split('\n')[0].slice(0, 160)
      + (failureSuppressed ? `  (+${failureSuppressed} similar suppressed in the last 5 min)` : '')
      + '  [stack hidden — JUNE_LIBSIGNAL_LOG=1 for raw libsignal output]';
    failureSuppressed = 0;
    failureWindowStart = now;
    return { print: true, line };
  }
  failureSuppressed += 1;
  return { print: false, line: null };
}

function _resetFailureWindow() { failureWindowStart = 0; failureSuppressed = 0; }

module.exports = { install, ROUTINE, FAILURE, decideFailure, _resetFailureWindow };
