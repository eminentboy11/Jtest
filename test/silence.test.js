'use strict';

// Flood control for libsignal session failures: a desynced session repeats
// "Session error: … Bad MAC" with a full stack dozens of times per minute.
// decideFailure() must print the first one as a single line, collapse the
// rest of the window into a count, and pass everything else through.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { decideFailure, _resetFailureWindow, FAILURE, ROUTINE } = require('../utils/silenceLibsignal');

const BAD_MAC = 'Session error:Error: Bad MAC Error: Bad MAC';
const STACK = 'Session error:Error: Bad MAC\n    at Object.verifyMAC (crypto.js:87:15)\n    at SessionCipher.doDecryptWhisperMessage (session_cipher.js:250:16)';

describe('libsignal failure flood control', () => {
  before(() => { _resetFailureWindow(); });

  test('first failure in a window prints, as ONE line, stack dropped', () => {
    const d = decideFailure(STACK, 1_000_000);
    assert.equal(d.print, true);
    assert.ok(!d.line.includes('\n'), 'no stack frames in the printed line');
    assert.ok(d.line.startsWith('Session error:Error: Bad MAC'), d.line);
    assert.ok(d.line.includes('stack hidden'), d.line);
  });

  test('repeats inside the window are suppressed and counted', () => {
    for (let i = 0; i < 40; i++) {
      const d = decideFailure(BAD_MAC, 1_000_000 + i * 1000);
      assert.equal(d.print, false, `repeat #${i} must not print`);
    }
  });

  test('after the window the next failure prints with the suppressed count', () => {
    const d = decideFailure(BAD_MAC, 1_000_000 + 6 * 60 * 1000);
    assert.equal(d.print, true);
    assert.ok(d.line.includes('+40 similar suppressed'), d.line);
  });

  test('non-failure lines pass through untouched (null)', () => {
    assert.equal(decideFailure('✅ Connected as 2348012345678', 2_000_000), null);
    assert.equal(decideFailure('WARNING: Expected pubkey of length 33', 2_000_000), null);
    assert.equal(decideFailure(undefined, 2_000_000), null);
  });

  test('routine lifecycle lines are still matched by ROUTINE (dropped earlier)', () => {
    assert.ok(ROUTINE.some((re) => re.test('Closing open session in favor of incoming prekey bundle')));
    assert.ok(ROUTINE.some((re) => re.test('Closing session: SessionEntry { _chains:')));
  });

  test('FAILURE patterns cover the Bad MAC family', () => {
    assert.ok(FAILURE.some((re) => re.test(BAD_MAC)));
    assert.ok(FAILURE.some((re) => re.test('Failed to decrypt message with any known session...')));
  });
});
