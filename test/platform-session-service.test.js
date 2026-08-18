'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const service = require('../platform/sessionService');

function fakeEngine() {
    const bots = new Map();
    const calls = [];
    return {
        bots,
        calls,
        adapter: {
            async restorePersisted(entries) {
                calls.push(['restorePersisted', entries]);
                for (const entry of entries) {
                    if (bots.has(entry.id)) continue;
                    bots.set(entry.id, {
                        id: entry.id,
                        phone: entry.phone || '',
                        qrLogin: entry.qrLogin === true,
                        restoreOnly: true,
                        botState: 'disconnected',
                        status: { id: entry.id, state: 'disconnected' },
                    });
                }
                return { ok: true, restored: entries.length, ids: entries.map(entry => entry.id) };
            },
            async provision(entry, options) {
                calls.push(['provision', entry, options]);
                const id = entry.id || entry.phone;
                if (bots.has(id)) return { ok: false, reason: 'duplicate-id' };
                const bot = { id, phone: entry.phone || '', qrLogin: entry.qrLogin === true, botState: 'connecting', status: { id, state: 'connecting' } };
                bots.set(id, bot);
                return { ok: true, id, phone: bot.phone, qrLogin: bot.qrLogin };
            },
            async remove(id, options) {
                calls.push(['remove', id, options]);
                if (!bots.has(id)) return { ok: false, reason: 'unknown' };
                bots.delete(id);
                return { ok: true, id, permanent: true };
            },
            async stop(id) {
                calls.push(['stop', id]);
                const bot = bots.get(id);
                if (!bot) return { ok: false, reason: 'unknown' };
                bot.botState = 'disconnected';
                bot.status = { id, state: 'disconnected' };
                return { ok: true, id };
            },
            async reconnect(id, options) {
                calls.push(['reconnect', id, options]);
                const bot = bots.get(id);
                if (!bot) return { ok: false, reason: 'unknown' };
                bot.botState = 'connected';
                bot.status = { id, state: 'connected' };
                return { ok: true, id, connected: true };
            },
            async reconcile() { calls.push(['reconcile']); return true; },
            get: id => bots.get(String(id)) || null,
            list: () => [...bots.values()],
            snapshot: () => [...bots.values()].map(bot => bot.status),
        },
    };
}

function configureFake() {
    service._resetForTests();
    const fake = fakeEngine();
    service.configure(fake.adapter);
    return fake;
}

test('QR and code provisioning use the same configured engine pipeline', async () => {
    const fake = configureFake();
    const code = await service.provision({ mode: 'code', phone: '2348154853640' });
    const qr = await service.provision({ mode: 'qr' });

    assert.equal(code.id, '2348154853640');
    assert.match(qr.id, /^web-[a-f0-9]{10}$/);
    assert.equal(fake.calls.filter(call => call[0] === 'provision').length, 2);
    assert.equal(fake.calls[0][2].source, 'web');
    assert.equal(fake.calls[1][2].source, 'web');
    assert.equal(fake.bots.size, 2);
});

test('multiple persisted web sessions are reconstructed before engine boot', async () => {
    const fake = configureFake();
    const result = await service.restorePersisted([
        { botId: '2348154853640', mode: 'code', phone: '2348154853640', webManaged: true, removedAt: null },
        { botId: '2348165321909-2', mode: 'code', webManaged: true, removedAt: null },
        { botId: 'web-a1b2c3d4e5', mode: 'qr', webManaged: true, removedAt: null },
        { botId: 'removed', mode: 'qr', webManaged: true, removedAt: Date.now() },
    ]);

    assert.equal(result.restored, 3);
    assert.ok(fake.bots.has('2348154853640'));
    assert.equal(fake.bots.get('2348165321909-2').phone, '2348165321909');
    assert.equal(fake.bots.get('web-a1b2c3d4e5').qrLogin, true);
    assert.equal(fake.bots.has('removed'), false);
    const entries = fake.calls.find(call => call[0] === 'restorePersisted')[1];
    assert.ok(entries.every(entry => entry.restoreOnly === true));
});

test('failed platform commit rolls the new engine session back permanently', async () => {
    const fake = configureFake();
    await assert.rejects(
        service.provision(
            { mode: 'code', phone: '2348165321909' },
            { commit: async () => { throw new Error('registry unavailable'); } }
        ),
        /registry unavailable/
    );
    assert.equal(fake.bots.size, 0);
    const remove = fake.calls.find(call => call[0] === 'remove');
    assert.equal(remove[1], '2348165321909');
    assert.equal(remove[2].reason, 'provision-rollback');
});

test('two-session operations are strictly scoped by botId', async () => {
    const fake = configureFake();
    await service.provision({ mode: 'code', phone: '1111111' });
    await service.provision({ mode: 'code', phone: '2222222' });

    await service.stop('1111111');
    assert.equal(service.get('1111111').botState, 'disconnected');
    assert.equal(service.get('2222222').botState, 'connecting');

    await service.reconnect('1111111');
    assert.equal(service.get('1111111').botState, 'connected');
    assert.equal(service.get('2222222').botState, 'connecting');

    await service.remove('2222222', { reason: 'test-delete' });
    assert.ok(service.get('1111111'));
    assert.equal(service.get('2222222'), null);
});

test('platform slot orchestration provisions both QR and pairing-code modes', async () => {
    const fake = configureFake();
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,test' };
        return originalLoad.call(this, request, parent, isMain);
    };
    let sessions;
    try { sessions = require('../platform/sessions'); }
    finally { Module._load = originalLoad; }
    const slots = require('../platform/slots');
    const registry = require('../platform/registry');
    const originalTrack = registry.trackSession;
    registry.trackSession = async () => ({});

    const qrSlot = slots.create({ mode: 'qr', ipHash: 'qr-test' });
    const codeSlot = slots.create({ mode: 'code', phone: '4444444', ipHash: 'code-test' });
    try {
        await sessions.provisionSlot(qrSlot);
        await sessions.provisionSlot(codeSlot);
        assert.match(qrSlot.botId, /^web-[a-f0-9]{10}$/);
        assert.equal(codeSlot.botId, '4444444');
        assert.ok(service.get(qrSlot.botId));
        assert.ok(service.get(codeSlot.botId));
        assert.equal(fake.calls.filter(call => call[0] === 'provision').length, 2);
    } finally {
        registry.trackSession = originalTrack;
        if (qrSlot.botId) await service.remove(qrSlot.botId);
        if (codeSlot.botId) await service.remove(codeSlot.botId);
        slots.discard(qrSlot.slotId);
        slots.discard(codeSlot.slotId);
    }
});

test('public cancellation removes both temporary session and slot', async () => {
    const fake = configureFake();
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,test' };
        return originalLoad.call(this, request, parent, isMain);
    };
    let sessions;
    try { sessions = require('../platform/sessions'); }
    finally { Module._load = originalLoad; }
    const slots = require('../platform/slots');

    const slot = slots.create({ mode: 'code', phone: '3333333', ipHash: 'test' });
    const created = await service.provision({ mode: 'code', phone: slot.phone });
    slots.bindBot(slot, created.id);
    const result = await sessions.cancelSlot(slot.slotId);

    assert.equal(result.ok, true);
    assert.equal(service.get(created.id), null);
    assert.equal(slots.get(slot.slotId), null);
    assert.equal(fake.bots.size, 0);
});

test('failed slot registry commit leaves no session and no pairing slot', async () => {
    const fake = configureFake();
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,test' };
        return originalLoad.call(this, request, parent, isMain);
    };
    let sessions;
    try { sessions = require('../platform/sessions'); }
    finally { Module._load = originalLoad; }
    const slots = require('../platform/slots');
    const registry = require('../platform/registry');
    const originalTrack = registry.trackSession;
    const originalMarkRemoved = registry.markRemoved;
    registry.trackSession = async () => { throw new Error('registry write failed'); };
    registry.markRemoved = async () => {};

    const slot = slots.create({ mode: 'qr', ipHash: 'rollback-test' });
    try {
        await assert.rejects(sessions.provisionSlot(slot), /Provisioning failed|registry write failed/);
        assert.equal(fake.bots.size, 0);
        assert.equal(slots.get(slot.slotId), null);
    } finally {
        registry.trackSession = originalTrack;
        registry.markRemoved = originalMarkRemoved;
        slots.discard(slot.slotId);
    }
});

test('zero-session platform startup resolves to an empty registry, not legacy default', () => {
    const previous = process.env.JUNE_SESSIONS;
    process.env.JUNE_SESSIONS = '[]';
    try {
        const { loadSessionRegistry } = require('../utils/core/sessionManager');
        assert.deepEqual(loadSessionRegistry(), []);
        const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        assert.match(indexSource, /platformBridge\.platformEnabled \? 'JUNE_SESSIONS=\[\]'/);
        assert.match(indexSource, /platformBridge\.platformEnabled\) process\.env\.JUNE_SESSIONS = '\[\]'/);
    } finally {
        if (previous === undefined) delete process.env.JUNE_SESSIONS;
        else process.env.JUNE_SESSIONS = previous;
    }
});

test('reconciliation is exposed through the configured internal engine only', async () => {
    const fake = configureFake();
    await service.reconcile();
    assert.deepEqual(fake.calls, [['reconcile']]);
});

test('platform and engine provisioning share one dashboard capacity', () => {
    const limits = require('../platform/limits');
    const ratelimit = require('../platform/ratelimit');
    assert.equal(ratelimit.MAX_BOTS, limits.MAX_BOTS);
    assert.equal(ratelimit.stats().maxBots, limits.MAX_BOTS);
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(indexSource, /platformBridge\.platformEnabled \? platformLimits\.MAX_BOTS/);
});

test('platform modules no longer depend on legacy __JUNE session globals', () => {
    for (const file of ['sessions.js', 'devRoutes.js', 'publicRoutes.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'platform', file), 'utf8');
        assert.doesNotMatch(source, /global\.__JUNE_/);
    }
});
