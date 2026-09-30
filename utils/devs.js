'use strict';

/**
 * The dev allowlist — the two phone numbers that may drive process-level
 * commands (`.upgrade`, `.shutdown`).
 *
 * Why this is its own module: those commands must ignore everyone else
 * *silently*. They cannot use `ownerOnly: true`, because the handler answers
 * that flag by sending "this command is owner only" — which is a response. So
 * the gate has to live inside `execute()` and return early, and the moment you
 * have two commands doing that you have two copies of the number list to keep
 * in sync. This is that one copy.
 *
 * Matching is deliberately generous about WHERE the number comes from and
 * strict about WHAT it is:
 *
 *   - any identity on the message counts: the sender, key.participant,
 *     key.participantAlt and the chat jid. A group message can arrive under an
 *     @lid jid whose digits are not the phone number, with the real number
 *     carried in participantAlt; checking all of them is what makes the gate
 *     work in a LID group as well as in a DM.
 *   - digits are compared whole, so 23481548536401 does not match
 *     2348154853640. Prefix matching here would be a real hole.
 */

/** Digits only — no '+', no spaces. A JID's device suffix is stripped. */
const DEV_NUMBERS = Object.freeze([
  '2348154853640',
  '2348062642047',
]);

/** '2348...@s.whatsapp.net' / '2348...:12@s.whatsapp.net' -> '2348...' */
function digitsOf(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Every identity on the message that could carry the sender's phone number. */
function candidateNumbers(msg, extra) {
  const out = new Set();
  const add = (v) => { const d = digitsOf(v); if (d) out.add(d); };
  add(extra && extra.sender);
  add(msg && msg.key && msg.key.participant);
  add(msg && msg.key && msg.key.participantAlt);
  add(msg && msg.key && msg.key.remoteJid);
  return out;
}

/** True when the sender of this message is one of the dev numbers. */
function isDev(msg, extra) {
  const seen = candidateNumbers(msg, extra);
  return DEV_NUMBERS.some((n) => seen.has(n));
}

module.exports = { DEV_NUMBERS, digitsOf, candidateNumbers, isDev };
