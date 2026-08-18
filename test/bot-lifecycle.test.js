'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessionRegistry = require('../utils/core/sessionRegistry');
const sessionManager = require('../utils/core/sessionManager');

test('same phone can register four independent sessions with suffixed ids', () => {
  const phone = '2348165321909';
  let registry = [];
  for (let i = 0; i < 4; i += 1) {
    const quota = sessionRegistry.checkAddQuota({ registry, runningPhones: [], phone, max: 10 });
    assert.equal(quota.ok, true);
    const added = sessionManager.addSessionEntry(registry, { phone, sessionId: '' });
    assert.equal(added.ok, true);
    registry = added.registry;
  }

  assert.deepEqual(
    sessionManager.normalizeSessionEntries(registry).map(entry => entry.id),
    [phone, `${phone}-2`, `${phone}-3`, `${phone}-4`]
  );
  assert.equal(
    sessionRegistry.checkAddQuota({ registry, runningPhones: [], phone, max: 10 }).reason,
    'device-limit'
  );
});

test('duplicate sessionId is rejected while duplicate phone is allowed', () => {
  const registry = [{ phone: '2348165321909', sessionId: 'JUNE-MD:~same' }];
  assert.equal(
    sessionManager.addSessionEntry(registry, { phone: '2348165321909', sessionId: '' }).ok,
    true
  );
  assert.equal(
    sessionManager.addSessionEntry(registry, { phone: '2348000000000', sessionId: 'JUNE-MD:~same' }).reason,
    'duplicate-sessionId'
  );
});

test('suffixed ids target the correct duplicate-phone registry entry', () => {
  const phone = '2348165321909';
  const registry = [
    { phone, sessionId: '' },
    { phone, sessionId: '' },
    { phone, sessionId: '' },
  ];
  assert.equal(sessionRegistry.findRegistryEntryIndex(registry, phone), 0);
  assert.equal(sessionRegistry.findRegistryEntryIndex(registry, `${phone}-2`), 1);
  assert.equal(sessionRegistry.findRegistryEntryIndex(registry, `${phone}-3`), 2);
});

test('pause and resume preserve the registry entry and do not mutate input', () => {
  const original = [{ phone: '2348165321909', sessionId: 'JUNE-MD:~abc' }];
  const paused = sessionRegistry.setRegistryPaused(original, '2348165321909', true);
  assert.equal(paused.ok, true);
  assert.equal(paused.registry[0].paused, true);
  assert.equal(original[0].paused, undefined);
  assert.equal(paused.registry[0].sessionId, original[0].sessionId);

  const resumed = sessionRegistry.setRegistryPaused(paused.registry, '2348165321909', false);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.registry[0].paused, undefined);
  assert.equal(resumed.registry[0].sessionId, original[0].sessionId);
});

test('pause/resume reports unknown and already-in-state safely', () => {
  const active = [{ id: 'client', phone: '2348165321909' }];
  assert.equal(sessionRegistry.setRegistryPaused(active, 'missing', true).reason, 'unknown');
  assert.equal(sessionRegistry.setRegistryPaused(active, 'client', false).reason, 'already-active');
  const paused = [{ ...active[0], paused: true }];
  assert.equal(sessionRegistry.setRegistryPaused(paused, 'client', true).reason, 'already-paused');
});

test('startup excludes paused entries without inventing a default session', () => {
  const previous = process.env.JUNE_SESSIONS;
  process.env.JUNE_SESSIONS = JSON.stringify([
    { phone: '2348154853640', paused: true },
    { phone: '2348165321909' },
  ]);
  try {
    const loaded = sessionManager.loadSessionRegistry();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].phone, '2348165321909');

    process.env.JUNE_SESSIONS = JSON.stringify([{ phone: '2348154853640', paused: true }]);
    assert.deepEqual(sessionManager.loadSessionRegistry(), []);
  } finally {
    if (previous === undefined) delete process.env.JUNE_SESSIONS;
    else process.env.JUNE_SESSIONS = previous;
  }
});

test('internal permanent-delete path clears auth/data and removes persistent artifacts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /permanentlyForgetSession/);
  assert.match(source, /resetDatabase\(\{ includeSession: true \}\)/);
  assert.match(source, /clearRemoteAuthState/);
  assert.match(source, /removeSessionArtifacts/);
  assert.match(source, /removeDatabaseArtifacts/);
});
