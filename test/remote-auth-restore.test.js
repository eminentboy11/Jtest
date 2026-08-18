'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep scheduler regression tests fast; database.js clamps this to >=500ms.
process.env.JUNE_AUTH_MIRROR_DEBOUNCE_MS = '500';

let dependenciesAvailable = true;
try { require.resolve('sql.js'); } catch (_) {
  try { require.resolve('better-sqlite3'); } catch (_) { dependenciesAvailable = false; }
}

function fakeAdapter({ source, snapshot = null, configured = true, mirrorAuthState = null, close = null }) {
  return {
    async init() { return this.getStatus(); },
    getStatus() { return { configured, available: true, botId: 'test' }; },
    async fetchAuthState() {
      return snapshot ? { source, snapshot, updatedAt: snapshot.createdAt || Date.now() } : null;
    },
    async mirrorAuthState(value) {
      return mirrorAuthState ? mirrorAuthState(value) : { acknowledged: true };
    },
    async restoreIntoSQLite() { return { restored: 0 }; },
    async close() { if (close) await close(); },
    getBotId() { return 'test'; },
  };
}

function validSnapshot() {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now,
    sessionCreds: [{ key: 'creds', value: '{"registered":true}', updated_at: now }],
    sessionKeys: [{ type: 'app-state-sync-key', id: 'key-1', value: '{}', updated_at: now }],
    sessionAuthMeta: [{ key: 'status', value: 'verified' }],
  };
}

test('MongoDB-backed auth snapshot restores into a fresh per-session SQLite database', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-mongo-auth-'));
  const dbFile = path.join(dir, 'session.db');
  const database = require('../database');
  const pg = fakeAdapter({ source: 'postgres', snapshot: null });
  const mongo = fakeAdapter({ source: 'mongo', snapshot: validSnapshot() });
  const db = database.createBotDatabase({ botId: 'mongo-restore-test', dbFile, pg, mongo });

  try {
    await db.ready;
    const result = await db.restoreRemoteAuthState();
    assert.equal(result.restored, true);
    assert.equal(result.source, 'mongo');
    assert.equal(result.credentialRows, 1);
    assert.equal(result.keyRows, 1);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS count FROM session_creds').get().count, 1);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS count FROM session_keys').get().count, 1);
    assert.equal(
      db._db.prepare("SELECT value FROM session_auth_meta WHERE key = 'status'").get().value,
      'verified'
    );
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an initial unverified skip does not poison later valid auth mirrors', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-auth-skip-recovery-'));
  const database = require('../database');
  let mirrors = 0;
  const db = database.createBotDatabase({
    botId: 'skip-then-valid-test',
    dbFile: path.join(dir, 'session.db'),
    pg: fakeAdapter({ source: 'postgres', snapshot: null, configured: false }),
    mongo: fakeAdapter({
      source: 'mongo',
      snapshot: validSnapshot(),
      mirrorAuthState: async () => { mirrors += 1; return { acknowledged: true }; },
    }),
  });

  try {
    await db.ready;
    const skipped = await db.mirrorRemoteAuthState('auth-fresh-init');
    assert.equal(skipped.skipped, 'local-auth-not-verified');
    assert.equal((await db.restoreRemoteAuthState()).restored, true);
    const persisted = await db.mirrorRemoteAuthState('auth-keys');
    assert.equal(persisted.ok, true);
    assert.deepEqual(persisted.succeeded, ['mongo']);
    assert.equal(mirrors, 1);
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth mirror and shutdown wait for the real MongoDB write acknowledgement', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-auth-flush-'));
  const database = require('../database');
  let mirrorFinished = false;
  let closedAfterMirror = false;
  const mongo = fakeAdapter({
    source: 'mongo',
    snapshot: validSnapshot(),
    mirrorAuthState: async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      mirrorFinished = true;
      return { acknowledged: true };
    },
    close: async () => { closedAfterMirror = mirrorFinished; },
  });
  const db = database.createBotDatabase({
    botId: 'awaited-mirror-test',
    dbFile: path.join(dir, 'session.db'),
    pg: fakeAdapter({ source: 'postgres', snapshot: null, configured: false }),
    mongo,
  });

  try {
    await db.ready;
    assert.equal((await db.restoreRemoteAuthState()).restored, true);
    mirrorFinished = false;
    const pending = db.mirrorRemoteAuthState('test-delayed-write');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mirrorFinished, false);
    const result = await pending;
    assert.equal(mirrorFinished, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.succeeded, ['mongo']);

    mirrorFinished = false;
    await db.shutdownDatabase();
    assert.equal(mirrorFinished, true);
    assert.equal(closedAfterMirror, true);
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('continuous auth mutations cannot starve the scheduled remote mirror', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-auth-scheduler-'));
  const database = require('../database');
  let mirrors = 0;
  const db = database.createBotDatabase({
    botId: 'mirror-scheduler-test',
    dbFile: path.join(dir, 'session.db'),
    pg: fakeAdapter({ source: 'postgres', snapshot: null, configured: false }),
    mongo: fakeAdapter({
      source: 'mongo',
      snapshot: validSnapshot(),
      mirrorAuthState: async () => { mirrors += 1; return { acknowledged: true }; },
    }),
  });

  try {
    await db.ready;
    assert.equal((await db.restoreRemoteAuthState()).restored, true);
    for (let i = 0; i < 7; i += 1) {
      assert.equal(db.scheduleRemoteAuthMirror(`mutation-${i}`), true);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(mirrors >= 1, 'first scheduled mirror must run despite later mutations');
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed auth mirror is reported and queued instead of falsely marked successful', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-auth-failure-'));
  const database = require('../database');
  const db = database.createBotDatabase({
    botId: 'failed-mirror-test',
    dbFile: path.join(dir, 'session.db'),
    pg: fakeAdapter({ source: 'postgres', snapshot: null, configured: false }),
    mongo: fakeAdapter({ source: 'mongo', snapshot: validSnapshot(), mirrorAuthState: async () => null }),
  });

  try {
    await db.ready;
    assert.equal((await db.restoreRemoteAuthState()).restored, true);
    const result = await db.mirrorRemoteAuthState('test-failure');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'all-configured-auth-mirrors-failed');
    assert.equal(result.failed[0].adapter, 'mongo');
    assert.ok(db.getRemoteSyncQueueStats().pending >= 1);
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid remote auth remains isolated and yields no verified local auth', { skip: !dependenciesAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-invalid-auth-'));
  const database = require('../database');
  const invalid = { ...validSnapshot(), sessionKeys: [] };
  const db = database.createBotDatabase({
    botId: 'invalid-restore-test',
    dbFile: path.join(dir, 'session.db'),
    pg: fakeAdapter({ source: 'postgres', snapshot: null }),
    mongo: fakeAdapter({ source: 'mongo', snapshot: invalid }),
  });

  try {
    await db.ready;
    const result = await db.restoreRemoteAuthState();
    assert.equal(result.restored, false);
    assert.equal(result.skipped, 'invalid-remote-auth-state');
    assert.equal(db._db.prepare('SELECT COUNT(*) AS count FROM session_keys').get().count, 0);
  } finally {
    await db.shutdownDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
