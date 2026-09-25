'use strict';

/**
 * libsignal logs session churn straight to console.warn / console.info, which
 * bypasses the pino logger handed to makeWASocket, so pino's level cannot
 * silence it. utils/silenceLibsignal.js wraps the console methods instead.
 *
 * These tests drive the REAL libsignal SessionRecord, not a fake: the noisy
 * lines and the multi-line SessionEntry dumps come from its own source.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Close, re-close, reopen and evict sessions: that is the exact sequence that
// prints "Closing session:", "Session already closed", "Session already open",
// "Opening session:" and "Removing old closed session:", each with a dump.
const PROBE = `
  const SessionRecord = require(${JSON.stringify(path.join(REPO, 'node_modules', 'libsignal', 'src', 'session_record.js'))});
  if (process.env.WITH_FILTER === '1') {
    require(${JSON.stringify(path.join(REPO, 'utils', 'silenceLibsignal.js'))}).install();
  }
  const rec = new SessionRecord();
  const mk = (n, closed) => ({ indexInfo: { baseKey: Buffer.from('key' + n), closed, used: n } });
  const open = mk(1, -1);
  rec.setSession(open);
  rec.closeSession(open);
  rec.closeSession(open);
  // "Session already open" only fires when re-opening a session that is still
  // open, so hand it a fresh open one.
  rec.openSession(mk(99, -1));
  // Eviction only runs past CLOSED_SESSIONS_MAX (40), so park 45 closed ones.
  for (let i = 0; i < 45; i++) rec.setSession(mk(i + 2, Date.now() + i));
  rec.removeOldSessions();
  console.log('APP-LINE must survive');
  console.error('Failed to decrypt message with any known session...');
`;

function run(env) {
  const r = cp.spawnSync(process.execPath, ['-e', PROBE], {
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: process.env.PATH, WITH_FILTER: '0', ...env },
  });
  assert.equal(r.status, 0, `probe exited ${r.status}: ${r.stderr}`);
  return r.stdout + r.stderr;
}

test('libsignal session churn is loud without the filter', () => {
  const out = run({});
  for (const line of ['Closing session:', 'Session already closed', 'Session already open',
    'Opening session:', 'Removing old closed session:']) {
    assert.ok(out.includes(line), `expected the unfiltered probe to print "${line}"`);
  }
});

test('the filter silences the churn', () => {
  const out = run({ WITH_FILTER: '1' });
  for (const line of ['Closing session:', 'Session already closed', 'Session already open',
    'Opening session:', 'Removing old closed session:', 'Closing open session in favor']) {
    assert.ok(!out.includes(line), `filter let "${line}" through`);
  }
});

test('app output and decrypt failures survive the filter', () => {
  const out = run({ WITH_FILTER: '1' });
  assert.ok(out.includes('APP-LINE must survive'), 'ordinary console.log must pass through');
  assert.ok(out.includes('Failed to decrypt message with any known session...'),
    'a real decrypt failure must still be visible');
});

test('JUNE_LIBSIGNAL_LOG=1 restores the original output', () => {
  const out = run({ WITH_FILTER: '1', JUNE_LIBSIGNAL_LOG: '1' });
  assert.ok(out.includes('Closing session:'), 'the escape hatch must bring the noise back');
});

test('the filter is installed before any socket can exist', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8');
  const installAt = src.indexOf("require('./utils/silenceLibsignal').install()");
  const socketAt = src.indexOf('makeWASocket(');
  assert.ok(installAt > -1, 'index.js must install the filter');
  assert.ok(socketAt > -1, 'index.js must create sockets');
  assert.ok(installAt < socketAt, 'the filter must be installed before makeWASocket is called');
});
