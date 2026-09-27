'use strict';

// JUNE_DATA_DIR at MODULE TOP — fontConverter/database bind the data dir on
// first require; a late env var silently binds the repo's real data/.
const DATA = '/tmp/jtest-test-lru';
process.env.JUNE_DATA_DIR = DATA;
process.env.JUNE_HOT_STORES = '3';
process.env.JUNE_KV_MAX_PER_NS = '5';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const database = require('../database');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

describe('database LRU hot tier', () => {
  before(() => { fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true }); });
  after(() => { fs.rmSync(DATA, { recursive: true, force: true }); });

  test('guard: bound to test dir', () => assert.equal(database.getDataDir(), DATA));

  test('idle stores are evicted and reload from disk with their values', async () => {
    await database.runAsBot('lru-a', async () => { database.setBotSetting('prefix', 'q'); });
    await sleep(400);                       // let the debounce flush the file
    assert.ok(database.lruStats().hot >= 1);
    const evicted = database.evictIdle(Date.now() + DAY, true);
    assert.ok(evicted.includes('lru-a'), JSON.stringify(evicted));
    assert.equal(database.lruStats().hot, 0, 'the only store should be gone from RAM');
    // reload: same value, from disk, transparently
    const prefix = await database.runAsBot('lru-a', async () => database.getBotSetting('prefix'));
    assert.equal(prefix, 'q');
  });

  test('stores with a pending debounced write are NOT evicted', async () => {
    await database.runAsBot('lru-b', async () => { database.setBotSetting('prefix', 'w'); });
    const evicted = database.evictIdle(Date.now() + DAY, true);   // write still pending
    assert.ok(!evicted.includes('lru-b'), 'dirty store must survive eviction');
    await sleep(400);                                             // now it flushes
    const later = database.evictIdle(Date.now() + DAY, true);
    assert.ok(later.includes('lru-b'));
  });

  test('over the cap, least-recently-used stores go first', async () => {
    for (const id of ['cap-1', 'cap-2', 'cap-3', 'cap-4', 'cap-5']) {
      await database.runAsBot(id, async () => { database.setBotSetting('botName', id); });
      await sleep(60);
    }
    await sleep(400);
    database.evictIdle(Date.now(), true);   // nothing idle, but cap = 3
    assert.ok(database.lruStats().hot <= 3, `hot=${database.lruStats().hot}`);
    // every value still readable (evicted ones come back from disk)
    for (const id of ['cap-1', 'cap-5']) {
      const name = await database.runAsBot(id, async () => database.getBotSetting('botName'));
      assert.equal(name, id);
    }
  });

  test('KV namespaces are capped: oldest keys pruned first', async () => {
    await database.runAsBot('kv-bot', async () => {
      for (let i = 0; i < 10; i++) database.setKV('antidelete', `k${i}`, i);
    });
    await sleep(400);
    const all = await database.runAsBot('kv-bot', async () => database.getAllKV('antidelete'));
    const keys = Object.keys(all).sort();
    assert.equal(keys.length, 5, JSON.stringify(keys));
    assert.deepEqual(keys, ['k5', 'k6', 'k7', 'k8', 'k9'], 'newest five survive');
  });
});
