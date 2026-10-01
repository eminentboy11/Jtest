'use strict';

/**
 * `.devinfo` — the dev console.
 *
 * Two things matter here:
 *
 *   1. It is SILENT for anyone who is not a dev number. Not a refusal, not a
 *      reaction — nothing. Same rule as `.upgrade` and `.shutdown`.
 *
 *   2. Its headline claim has to be true. The backup runs in the LOADER, not in
 *      this process, so the command reads the status file the loader writes. A
 *      file that says "enabled" while it has not been touched in three intervals
 *      must report STALLED — reporting a dead backup as healthy is the one
 *      failure this command exists to catch.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-devinfo';
const A = 'bot-alpha';
const DEV = '2348154853640';
const RANDO = '2348033333333';

let database, handler, statusDir, statusFile;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devinfo-'));
  statusFile = path.join(statusDir, 'sync-status.json');
  process.env.JUNE_SYNC_STATUS = statusFile;
});

after(() => {
  H.teardown(handler, database);
  delete process.env.JUNE_SYNC_STATUS;
  fs.rmSync(statusDir, { recursive: true, force: true });
});

const run = (sock, m) => H.dispatch(database, handler, A, sock, m);
const devMsg = (text = '.devinfo') => H.textMsg(text, { dm: true, remoteJid: `${DEV}@s.whatsapp.net` });
const sendCount = (sock) => sock._rec.sent.length + sock._rec.texts.length + sock._rec.reacts.length;

/** Write a status file the way the loader does. */
function statusFileWith(patch) {
  fs.writeFileSync(statusFile, JSON.stringify({
    enabled: true, reason: null, pid: process.pid, remote: 'eminentboy11/june-web-data',
    dir: DATA, intervalMin: 5, startedAt: new Date().toISOString(),
    lastRunAt: new Date().toISOString(), lastResult: 'idle', lastError: null,
    ...patch,
  }, null, 2));
}

const info = () => require(path.join(H.REPO, 'commands/owner/devinfo.js'))._internals;

describe('.devinfo is silent for non-devs', () => {
  test('a stranger in a group gets nothing at all', async () => {
    const sock = H.makeSock();
    await run(sock, H.textMsg('.devinfo', { sender: `${RANDO}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0);
  });

  test('a stranger in a DM gets nothing at all', async () => {
    const sock = H.makeDmSock();
    await run(sock, H.textMsg('.devinfo', { dm: true, remoteJid: `${RANDO}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0);
  });

  test('the group owner is not a dev here either', async () => {
    const sock = H.makeSock();
    await run(sock, H.textMsg('.devinfo', { sender: H.OWNER }));
    assert.equal(sendCount(sock), 0);
  });
});

describe('.devinfo answers for a dev', () => {
  test('a dev gets the full report', async () => {
    statusFileWith({});
    const sock = H.makeDmSock();
    await run(sock, devMsg());
    assert.equal(sock._rec.texts.length, 1, 'exactly one reply');
    const text = sock._rec.texts[0];
    assert.match(text, /DEV INFO/);
    assert.match(text, /DATA BACKUP/);
    assert.match(text, /eminentboy11\/june-web-data/);
    assert.match(text, /LOADER/);
    assert.match(text, /PROCESS/);
    assert.match(text, /SWITCHES/);
    assert.match(text, /DEBUG:/);
  });

  test('a boot restore is reported, and is not reported when there was none', async () => {
    statusFileWith({ restoredFiles: 3, restoredAt: '2026-10-01T09:00:00.000Z' });
    const sock = H.makeDmSock();
    await run(sock, devMsg());
    assert.match(sock._rec.texts[0], /Restored 3 file\(s\) at boot/);

    statusFileWith({});
    const plain = H.makeDmSock();
    await run(plain, devMsg());
    assert.equal(/Restored/.test(plain._rec.texts[0]), false, 'no restore, no line');
  });

  test('it never echoes a token', async () => {
    statusFileWith({});
    const saved = process.env.JUNE_DATA_TOKEN;
    process.env.JUNE_DATA_TOKEN = 'ghp_SUPERSECRETVALUE123';
    try {
      const sock = H.makeDmSock();
      await run(sock, devMsg());
      assert.equal(sock._rec.texts[0].includes('SUPERSECRET'), false);
    } finally {
      if (saved === undefined) delete process.env.JUNE_DATA_TOKEN;
      else process.env.JUNE_DATA_TOKEN = saved;
    }
  });
});

describe('the backup verdict is honest', () => {
  test('running when the loader ran recently', () => {
    statusFileWith({ lastRunAt: new Date().toISOString(), lastResult: 'pushed' });
    const r = info().backupReport();
    assert.equal(r.state, 'running');
    assert.match(r.detail, /pushed/);
  });

  test('STALLED when the file claims enabled but has not been touched', () => {
    statusFileWith({
      lastRunAt: new Date(Date.now() - 40 * 60_000).toISOString(),   // 40 min, interval 5
      lastResult: 'idle',
    });
    const r = info().backupReport();
    assert.equal(r.state, 'stalled', 'a dead backup must never be reported as running');
    assert.match(r.detail, /looks dead/i);
  });

  test('error when the last run failed', () => {
    statusFileWith({ lastResult: 'error', lastError: 'repository not found' });
    const r = info().backupReport();
    assert.equal(r.state, 'error');
  });

  test('armed before the first run', () => {
    statusFileWith({ lastRunAt: null });
    assert.equal(info().backupReport().state, 'armed');
  });

  test('off, with the reason, when the token is missing', () => {
    statusFileWith({ enabled: false, reason: 'no-token' });
    const r = info().backupReport();
    assert.equal(r.state, 'off');
    assert.match(r.detail, /JUNE_DATA_TOKEN/);
  });

  test('a missing status file is unknown, not healthy', () => {
    fs.rmSync(statusFile, { force: true });
    const r = info().backupReport();
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /never started|does not exist/i);
  });

  test('an unreadable status file is unknown, not a crash', () => {
    fs.writeFileSync(statusFile, '{ this is not json');
    const r = info().backupReport();
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /unreadable/);
  });

  test('with no JUNE_SYNC_STATUS at all it says so instead of guessing', () => {
    const saved = process.env.JUNE_SYNC_STATUS;
    delete process.env.JUNE_SYNC_STATUS;
    try {
      const r = info().backupReport();
      assert.equal(r.state, 'unknown');
      assert.match(r.detail, /not launched by the loader/);
    } finally {
      process.env.JUNE_SYNC_STATUS = saved;
    }
  });
});
