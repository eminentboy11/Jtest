'use strict';

// Flood control for libsignal session failures: a desynced session repeats
// "Session error: … Bad MAC" with a full stack dozens of times per minute.
// decideFailure() must print the first one as a single line, collapse the
// rest of the window into a count, and pass everything else through.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { decideFailure, classify, _resetFailureWindow, FAILURE, ROUTINE, STACK_FRAME } = require('../utils/silenceLibsignal');

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

  test('classify: routine lines drop, failures condense, plain output passes', () => {
    _resetFailureWindow();
    assert.deepEqual(classify('Closing session: SessionEntry { _chains: {} }', 7_000_000), { action: 'drop' });
    const first = classify(STACK, 7_000_000);
    assert.equal(first.action, 'print');
    assert.ok(!first.line.includes('\n'));
    assert.deepEqual(classify(STACK, 7_000_001), { action: 'drop' });
    assert.deepEqual(classify('[ BOOT ] Commands ready — 31 commands', 7_000_002), { action: 'pass' });
  });

  test('stack-frame writes are swallowed only inside the 2.5s post-failure window', () => {
    _resetFailureWindow();
    classify(BAD_MAC, 8_000_000);                      // opens the stack window
    const frame = '    at SessionCipher.doDecryptWhisperMessage (/x/libsignal/src/session_cipher.js:250:16)';
    assert.deepEqual(classify(frame, 8_000_000 + 1000), { action: 'drop' });
    assert.ok(STACK_FRAME.some((re) => re.test(frame)));
    // after the window the same frame shape passes (real crashes stay visible)
    assert.deepEqual(classify(frame, 8_000_000 + 4000), { action: 'pass' });
  });

  test('a genuine crash stack (no preceding failure line) passes in full', () => {
    _resetFailureWindow();
    const crash = 'Error: boom in our code\n    at Object.<anonymous> (/app/index.js:10:1)';
    assert.deepEqual(classify(crash, 9_000_000), { action: 'pass' });
  });
});
