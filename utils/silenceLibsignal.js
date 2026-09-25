'use strict';

/**
 * Silence libsignal's routine session chatter AND flood-control its failures.
 *
 * Baileys bundles libsignal, and libsignal logs straight to console.warn /
 * console.info — and sometimes writes stack frames directly to the process
 * streams — instead of going through the pino logger we hand to
 * makeWASocket. That means `pino({ level: 'fatal' })` cannot touch it: on a
 * live bot every session ratchet prints lines like
 *
 *   Closing open session in favor of incoming prekey bundle
 *   Closing session: SessionEntry { _chains: { ... }, currentRatchet: ... }
 *
 * and a desynced ratchet (classic after status replies) repeats
 *
 *   Session error:Error: Bad MAC Error: Bad MAC
 *       at Object.verifyMAC (.../libsignal/src/crypto.js:87:15)
 *       at SessionCipher.doDecryptWhisperMessage (.../session_cipher.js:250:16)
 *
 * dozens of times per minute, burying the console.
 *
 * Two layers, the second learned from the WDP source (their index.js
 * "Raw Output Suppression"):
 *   1. console.* methods are wrapped: routine lifecycle lines are dropped;
 *      session failures are RATE-LIMITED — the first in a 5-minute window
 *      prints as ONE line (stack dropped), repeats collapse into a count.
 *      (WDP silences Bad MAC completely; we keep one line so a desync is
 *      still visible.)
 *   2. process.stdout.write / process.stderr.write are wrapped the same way,
 *      because libsignal also emits noise and stack frames as raw stream
 *      writes that never touch console. After any suppressed/condensed
 *      failure line, a 2.5s window swallows the follow-up stack-frame writes
 *      ("    at …", paths containing /libsignal/, session_cipher.js, …).
 *
 * Suppressed stream writes still invoke their callback so callers never
 * hang. Set JUNE_LIBSIGNAL_LOG=1 to get the original raw output back.
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

// Session decryption failures: real, but repeatable into a flood.
const FAILURE = [
  /^Session error:/,                                    // session_cipher.js (Bad MAC …)
  /Failed to decrypt message with any known session/,   // session_cipher.js
];

// Stack-frame-looking writes: only swallowed inside the post-failure window,
// so genuine crashes (an Error: line followed by frames) still print in full.
const STACK_FRAME = [
  /\/libsignal\//,
  /session_cipher\.js/,
  /queue_job\.js/,
  /^\s*at\s/,
  /^\s*\.\.\.\s*$/,
];

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const STACK_WINDOW_MS = 2500;   // WDP uses the same 2.5s grace

let failureWindowStart = 0;
let failureSuppressed = 0;
let suppressStackUntil = 0;
let installed = false;
let emitting = false;   // reentrancy guard: our own condensed line passes streams untouched

function firstLine(text) { return String(text).split('\n')[0]; }

/**
 * Rate-limit decision for a session-failure line.
 * null  → not a failure line (print verbatim)
 * { print:true, line }  → print this single condensed line now
 * { print:false }       → swallow and count
 */
function decideFailure(first, now = Date.now()) {
  if (typeof first !== 'string' || !FAILURE.some((re) => re.test(first))) return null;
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    const line = firstLine(first).slice(0, 160)
      + (failureSuppressed ? `  (+${failureSuppressed} similar suppressed in the last 5 min)` : '')
      + '  [stack hidden — JUNE_LIBSIGNAL_LOG=1 for raw libsignal output]';
    failureSuppressed = 0;
    failureWindowStart = now;
    return { print: true, line };
  }
  failureSuppressed += 1;
  return { print: false, line: null };
}

/**
 * Full classify for one chunk/line of output.
 * { action: 'drop' }              — swallow entirely
 * { action: 'print', line }       — print this condensed line instead
 * { action: 'pass' }              — print verbatim
 */
function classify(text, now = Date.now()) {
  const head = firstLine(text);
  if (typeof head === 'string' && ROUTINE.some((re) => re.test(head))) return { action: 'drop' };
  const failure = decideFailure(head, now);
  if (failure) {
    suppressStackUntil = now + STACK_WINDOW_MS;   // swallow the frames that follow
    return failure.print ? { action: 'print', line: failure.line } : { action: 'drop' };
  }
  if (now < suppressStackUntil && STACK_FRAME.some((re) => re.test(head))) return { action: 'drop' };
  return { action: 'pass' };
}

function ack(encoding, callback) {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') { try { done(); } catch (_) {} }
  return true;
}

/**
 * Wrap console methods and the raw process streams. Idempotent, and a no-op
 * when JUNE_LIBSIGNAL_LOG asks for the raw output.
 */
function install() {
  if (installed) return;
  installed = true;

  const enabled = process.env.JUNE_LIBSIGNAL_LOG;
  if (enabled === '1' || enabled === 'true') return;

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = function silenced(...args) {
      const decision = classify(args[0]);
      if (decision.action === 'drop') return undefined;
      if (decision.action === 'print') {
        emitting = true;
        try { return original(decision.line); } finally { emitting = false; }
      }
      return original(...args);
    };
  }

  const rawOut = process.stdout.write.bind(process.stdout);
  const rawErr = process.stderr.write.bind(process.stderr);
  const wrap = (raw) => function (chunk, encoding, callback) {
    if (emitting) return raw(chunk, encoding, callback);
    const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const decision = classify(text);
    if (decision.action === 'drop') return ack(encoding, callback);
    if (decision.action === 'print') return raw(decision.line + '\n', typeof encoding === 'function' ? undefined : encoding, callback);
    return raw(chunk, encoding, callback);
  };
  process.stdout.write = wrap(rawOut);
  process.stderr.write = wrap(rawErr);
}

function _resetFailureWindow() {
  failureWindowStart = 0;
  failureSuppressed = 0;
  suppressStackUntil = 0;
}

module.exports = { install, ROUTINE, FAILURE, STACK_FRAME, decideFailure, classify, _resetFailureWindow };
