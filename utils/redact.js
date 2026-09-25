/**
 * Console redaction — keep secrets out of the panel console.
 *
 * maskNumber: 254797204594  → 25479•••••94   (first 5 + last 2)
 * maskBotId : june-ultra-main-tk-258dd7a01344 → june-u…1344 (first 6 + last 4)
 *
 * Numbers keep enough of a hint to debug "which account is this", tokens
 * keep only a fingerprint. Zero dependencies — safe to require anywhere.
 */
'use strict';

const maskDigits = (s) => {
  const digits = String(s ?? '').replace(/\D/g, '');
  if (digits.length < 5) return '•••';
  const head = digits.slice(0, 5);
  const tail = digits.length > 7 ? digits.slice(-2) : '';
  const middle = '•'.repeat(Math.max(digits.length - head.length - tail.length, 3));
  return head + middle + tail;
};

const maskNumber = (v) => {
  const s = String(v ?? '');
  if (!s) return '(none)';
  if (!/\d/.test(s)) return '•••';
  return s.replace(/\d{5,}/, (m) => maskDigits(m));
};

const maskBotId = (v) => {
  const s = String(v ?? '');
  if (!s) return '(none)';
  if (s.length <= 10) return s.slice(0, 2) + '…';
  return s.slice(0, 6) + '…' + s.slice(-4);
};

module.exports = { maskNumber, maskBotId };
