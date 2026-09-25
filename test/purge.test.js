'use strict';

// JUNE_DATA_DIR must be set at MODULE TOP, before anything requires the
// database graph — fontConverter/database lazily bind the data dir on first
// use and a late env var silently binds the repo's real data/ instead.
// (Same guard that startup.test.js pins; see its 'database is bound' test.)
const DATA = '/tmp/jtest-test-purge';
process.env.JUNE_DATA_DIR = DATA;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const database = require('../database');
const slots = require('../platform/slots');
const { purgeBot } = require('../platform/purge');

const BOT = 'purge-target';
const AUTH_ROOT = path.join(DATA, 'auth');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('purgeBot clears everything about a botId', () => {
  before(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(AUTH_ROOT, { recursive: true });
  });
  after(() => { fs.rmSync(DATA, { recursive: true, force: true }); });

  test('guard: database is bound to the test data dir', () => {
    assert.equal(database.getDataDir(), DATA);
  });

  test('purges memory, credentials, settings and slot', async () => {
    // settings file, written through the real debounced database path
    await database.runAsBot(BOT, async () => { database.setBotSetting('prefix', 'z'); });
    await sleep(400); // let the 250ms debounce flush
    const dataFile = database.botDataFile(BOT);
    assert.ok(fs.existsSync(dataFile), 'settings file should exist before purge');

    // session credentials on disk
    fs.mkdirSync(path.join(AUTH_ROOT, BOT), { recursive: true });
    fs.writeFileSync(path.join(AUTH_ROOT, BOT, 'creds.json'), '{}');

    // in-memory bot with a fake socket (bots Map is injected, like index.js passes its own)
    let ended = false; let listenersCleared = false;
    const bots = new Map([[BOT, {
      id: BOT,
      sock: {
        ev: { removeAllListeners() { listenersCleared = true; } },
        end() { ended = true; },
      },
    }]]);

    // pairing slot bound to this bot
    const slot = slots.create({ mode: 'code', phone: '2348012345678', ipHash: 'test' });
    slots.bindBot(slot, BOT);
    assert.ok(slots.getByBotId(BOT), 'slot should resolve by botId before purge');

    const result = await purgeBot(BOT, { reason: 'test-logout', bots, authRoot: AUTH_ROOT });

    assert.equal(result.ok, true);
    for (const what of ['memory', 'credentials', 'settings', 'slot']) {
      assert.ok(result.cleared.includes(what), `expected "${what}" cleared, got: ${result.cleared}`);
    }
    assert.ok(listenersCleared && ended, 'socket must be detached and ended');
    assert.equal(bots.has(BOT), false, 'bots Map entry must be gone');
    assert.equal(fs.existsSync(path.join(AUTH_ROOT, BOT)), false, 'auth dir must be gone');
    assert.equal(fs.existsSync(dataFile), false, 'settings file must be gone');
    assert.equal(slots.getByBotId(BOT), null, 'slot must be discarded');
  });

  test('a pending debounced write cannot resurrect a purged settings file', async () => {
    await database.runAsBot(BOT, async () => { database.setBotSetting('prefix', 'q'); });
    // purge IMMEDIATELY — the 250ms write timer is still in flight
    await purgeBot(BOT, { reason: 'race', authRoot: AUTH_ROOT });
    await sleep(500);
    assert.equal(fs.existsSync(database.botDataFile(BOT)), false,
      'the in-flight debounce timer must have been cancelled, not fired');
  });

  test('idempotent — purging an unknown bot is a clean no-op', async () => {
    const result = await purgeBot('never-existed', { reason: 'again', authRoot: AUTH_ROOT });
    assert.equal(result.ok, true);
    assert.deepEqual(result.cleared, []);
  });
});
