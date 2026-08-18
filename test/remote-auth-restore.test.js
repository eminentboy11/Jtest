'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let dependenciesAvailable = true;
try { require.resolve('sql.js'); } catch (_) {
  try { require.resolve('better-sqlite3'); } catch (_) { dependenciesAvailable = false; }
}

function fakeAdapter({ source, snapshot = null, configured = true }) {
  return {
    async init() { return this.getStatus(); },
    getStatus() { return { configured, available: true, botId: 'test' }; },
    async fetchAuthState() {
      return snapshot ? { source, snapshot, updatedAt: snapshot.createdAt || Date.now() } : null;
    },
    async restoreIntoSQLite() { return { restored: 0 }; },
    async close() {},
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
