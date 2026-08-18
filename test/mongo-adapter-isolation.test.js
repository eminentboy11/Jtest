'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function snapshot() {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now,
    sessionCreds: [{ key: 'creds', value: '{}', updated_at: now }],
    sessionKeys: [{ type: 'key', id: '1', value: '{}', updated_at: now }],
    sessionAuthMeta: [{ key: 'status', value: 'verified' }],
  };
}

test('closing one per-bot Mongo adapter cannot close or disable another', async () => {
  const previousUri = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://unit-test';
  const clients = [];
  const writes = [];

  class FakeMongoClient {
    constructor() { this.closed = false; clients.push(this); }
    async connect() {}
    db() {
      return {
        collection: () => ({
          createIndex: async () => ({}),
          updateOne: async (filter, update) => {
            if (this.closed) throw new Error('client closed');
            writes.push({ client: this, filter, update });
            return { acknowledged: true };
          },
          deleteOne: async () => ({ acknowledged: true }),
          findOne: async () => null,
        }),
      };
    }
    async close() { this.closed = true; }
  }

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'mongodb') return { MongoClient: FakeMongoClient };
    return originalLoad.call(this, request, parent, isMain);
  };

  const adapterPath = require.resolve('../utils/juneDb/mongoAdapter');
  delete require.cache[adapterPath];
  let registry;
  try {
    registry = require('../utils/juneDb/mongoAdapter');
    const first = registry.forBot('bot-a');
    const second = registry.forBot('bot-b');
    await Promise.all([first.init(), second.init()]);

    assert.equal(clients.length, 2);
    assert.equal(first.getStatus().available, true);
    assert.equal(second.getStatus().available, true);

    await first.close();
    assert.equal(clients[0].closed, true);
    assert.equal(clients[1].closed, false);
    assert.equal(first.getStatus().available, false);
    assert.equal(second.getStatus().available, true);

    const result = await second.mirrorAuthState(snapshot());
    assert.ok(result);
    assert.equal(writes.length, 1);
    assert.match(writes[0].filter._id, /^auth-state\|bot-b$/);

    await second.close();
    registry.unregister('bot-a');
    registry.unregister('bot-b');
  } finally {
    Module._load = originalLoad;
    delete require.cache[adapterPath];
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
  }
});
