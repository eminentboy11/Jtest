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

// Deliberately NOT silenced, because each one means something went wrong:
//   curve.js          "WARNING: Expected pubkey of length 33..."
//   session_cipher.js "Failed to decrypt message with any known session..."
//   session_cipher.js "Session error:..." + stack
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
      return original(...args);
    };
  }
}

module.exports = { install, ROUTINE };
