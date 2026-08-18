'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logStore = require('../platform/logStore');

test('developer log stream suppresses recoverable libsignal noise and stack frames', () => {
  const marker = `normal-log-${Date.now()}`;
  logStore.pushLog('error', ['Failed to decrypt message with any known session...']);
  logStore.pushLog('error', ['Session error:Error: Bad MAC Error: Bad MAC']);
  logStore.pushLog('error', ['    at SessionCipher.decryptWithSessions (/app/node_modules/libsignal/session_cipher.js:147:29)']);
  logStore.pushLog('info', ['Closing open session in favor of incoming prekey bundle']);
  logStore.pushLog('info', [marker]);

  const messages = logStore.getLogs(50).map(entry => entry.msg);
  assert.equal(messages.some(message => /Bad MAC|Failed to decrypt|libsignal|incoming prekey bundle/i.test(message)), false);
  assert.equal(messages.includes(marker), true);
});

test('ordinary errors remain visible during the signal suppression window', () => {
  const marker = `ordinary-error-${Date.now()}`;
  logStore.pushLog('error', ['Session error: Error: Bad MAC']);
  logStore.pushLog('error', [marker]);
  assert.equal(logStore.getLogs(20, 'error').some(entry => entry.msg === marker), true);
});
