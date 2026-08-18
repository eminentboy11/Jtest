/**
 * June X Platform — session orchestration.
 *
 * Glues the engine bridge to the slot store and platform registry:
 *   - provisions engine sessions for public slots (code + qr modes)
 *   - streams QR / pairing-code / paired events into slots
 *   - runs garbage collection (expired slots, dead web sessions)
 *
 * All engine access goes through platform/sessionService, configured once by
 * the engine. The platform owns no second socket/session lifecycle.
 */

'use strict';

const qrcode = require('qrcode');

const bridge = require('./bridge');
const slots = require('./slots');
const registry = require('./registry');
const sessionService = require('./sessionService');

const GC_INTERVAL_MS = 60_000;
const NEEDS_LOGIN_GRACE_MS = 10 * 60_000; // web session parked needs-login -> removed after this
const gcStats = { runs: 0, slotsExpired: 0, sessionsRemoved: 0, lastRun: null, lastError: null };

function manager() {
    // Compatibility accessor for platform bridge code. HTTP routes no longer
    // manipulate SessionManager directly.
    return sessionService.configured() ? { get: sessionService.get, list: sessionService.list, snapshot: sessionService.snapshot } : null;
}

function activeSessionCount() {
    return sessionService.configured() ? sessionService.activeCount() : 0;
}

function provisioningMessage(reason) {
    const reasons = {
        'invalid-phone': 'Invalid phone number — use country code, digits only.',
        'duplicate-sessionId': 'This session credential already exists.',
        'duplicate-id': 'Generated session id collided — try again.',
        'device-limit': 'This number already has the maximum linked sessions.',
        quota: 'The platform is at capacity right now — try again later.',
        'reconcile-failed': 'The bot runtime could not start the session — try again.',
    };
    return reasons[reason] || `Provisioning failed (${reason || 'unknown'}).`;
}

// ── Public provisioning ───────────────────────────────────────────────────────
async function provisionSlot(slot) {
    try {
        const result = await sessionService.provision(
            { mode: slot.mode, phone: slot.phone },
            {
                commit: async (created) => {
                    slots.bindBot(slot, created.id);
                    await registry.trackSession(created.id, { mode: slot.mode, ipHash: slot.ipHash });
                },
            }
        );
        console.log(`[ PLATFORM ] Provisioned ${slot.mode} session "${result.id}" for slot ${slot.slotId.slice(0, 6)}…`);
        return slot;
    } catch (error) {
        const botId = slot.botId;
        if (botId) await registry.markRemoved(botId).catch(() => {});
        slots.discard(slot.slotId);
        const reason = error.result?.reason || String(error.message || '').replace(/^PROVISION_FAILED:/, '');
        if (error.rollbackError) {
            console.error(`[ PLATFORM ] Provision rollback failed for "${botId || '?'}": ${error.rollbackError.message}`);
        }
        throw new Error(provisioningMessage(reason));
    }
}

async function cancelSlot(slotId, reason = 'public cancellation') {
    const slot = slots.get(slotId);
    if (!slot) return { ok: false, reason: 'unknown-slot' };
    if (slot.status !== 'waiting') return { ok: false, reason: `slot-${slot.status}` };

    if (slot.botId) {
        const removed = await sessionService.remove(slot.botId, { reason });
        if (!removed?.ok) return { ok: false, reason: removed?.reason || 'remove-failed' };
        await registry.markRemoved(slot.botId).catch(() => {});
    }
    slots.discard(slotId);
    return { ok: true, botId: slot.botId || null };
}

/** Request one more pairing code inside the session's existing cycle (code mode). */
async function requestAnotherCode(slot) {
    const bot = sessionService.get(slot.botId);
    if (!bot) throw new Error('Session no longer exists.');
    if (!bot.sock) throw new Error('Session socket is not ready yet — wait a few seconds.');
    if (bot.pairingExhausted) throw new Error('Pairing code limit reached for this session.');

    const { requestPairingCodeForCycle, parsePairingMaxAttempts } = require('../utils/core/sessionManager');
    const result = await requestPairingCodeForCycle({
        bot,
        socket: bot.sock,
        maxAttempts: parsePairingMaxAttempts(process.env.JUNE_PAIRING_MAX_ATTEMPTS),
        stabilizeMs: 0,
        requestCode: (phone) => bot.sock.requestPairingCode(phone, 'JUNEXBOT'),
        onCode: async (rawCode, reservation) => {
            const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            bot._lastPairingCode = code;
            slots.setCode(bot.id, code, reservation.attempt, reservation.limit);
        },
        onExhausted: async () => {},
    });
    if (!result.ok) {
        const msgs = {
            exhausted: 'Pairing code limit reached (3 per session).',
            'inactive-or-stale': 'No active pairing cycle — create a new bot.',
            'request-failed': `WhatsApp rejected the request: ${result.error?.message || 'unknown'}`,
        };
        throw new Error(msgs[result.reason] || `Could not get a code (${result.reason}).`);
    }
    return result;
}

// ── Bridge wiring: engine events -> slots ─────────────────────────────────────
function wireBridge() {
    bridge.on('conn-update', async (bot, update, sock) => {
        const { connection, qr } = update;

        if (qr) {
            const slot = slots.getByBotId(bot.id);
            // Only render for qr-mode slots; code-mode QRs are consumed by the
            // engine's own pairing-code interception.
            if (slot && slot.mode === 'qr' && slot.status === 'waiting') {
                try {
                    const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
                    slots.setQR(bot.id, dataUrl);
                } catch (_) { /* ignore render errors */ }
            }
        }

        if (connection === 'open') {
            const botNum = sock?.user?.id?.split(':')[0] || bot.accountNumber || null;
            if (slots.getByBotId(bot.id)) {
                slots.setPaired(bot.id, botNum);
                console.log(`[ PLATFORM ] Slot paired — session "${bot.id}" is now linked (+${botNum || '?'}).`);
            }
            if (await registry.isWebManaged(bot.id)) {
                await registry.markPaired(bot.id, botNum);
            }
        }
    });

    bridge.on('pairing-code', (bot, code, reservation) => {
        slots.setCode(bot.id, code, reservation?.attempt || 1, reservation?.limit || 3);
    });

    bridge.on('pairing-exhausted', (bot) => {
        const slot = slots.getByBotId(bot.id);
        if (slot && slot.status === 'waiting') {
            slots.setFailed(bot.id, 'Pairing code limit reached — create a new bot to try again.');
        }
    });
}

// ── Garbage collection ────────────────────────────────────────────────────────
async function removeWebSession(botId, why) {
    try {
        const result = await sessionService.remove(String(botId), { reason: why });
        if (!result?.ok) throw new Error(result?.reason || 'remove-failed');
        await registry.markRemoved(botId);
        gcStats.sessionsRemoved++;
        console.log(`[ PLATFORM:GC ] Removed web session "${botId}" (${why}) — ok`);
        return result;
    } catch (err) {
        console.error(`[ PLATFORM:GC ] Failed to remove "${botId}":`, err.message);
        return { ok: false, reason: err.message };
    }
}

async function runGC(trigger = 'interval') {
    gcStats.runs++;
    gcStats.lastRun = Date.now();
    try {
        // 1. Expire overdue slots; unpaired sessions behind them are removed.
        const expired = slots.sweep();
        gcStats.slotsExpired += expired.length;
        for (const slot of expired) {
            if (!slot.botId) continue;
            const bot = sessionService.get(slot.botId);
            if (bot && bot.botState !== 'connected') {
                await removeWebSession(slot.botId, 'slot expired unpaired');
            }
        }

        // 2. Web-managed sessions that never paired and outlived the slot TTL
        //    (covers slots lost to a process restart).
        const tracked = await registry.listActive();
        const now = Date.now();
        for (const rec of tracked) {
            const bot = sessionService.get(rec.botId);
            if (!bot) {
                // Engine no longer knows it (removed elsewhere) — close the record.
                if (!rec.removedAt) await registry.markRemoved(rec.botId);
                continue;
            }
            const neverPaired = !rec.pairedAt && (now - rec.createdAt > slots.SLOT_TTL_MS + 5 * 60_000);
            const parkedDead = bot.botState === 'needs-login' &&
                (now - (rec.pairedAt || rec.createdAt) > NEEDS_LOGIN_GRACE_MS);
            if (bot.botState === 'connected') continue;
            if (neverPaired || parkedDead) {
                await removeWebSession(rec.botId, neverPaired ? 'never paired' : 'parked needs-login');
            }
        }

        require('./ratelimit').sweep();
        gcStats.lastError = null;
    } catch (err) {
        gcStats.lastError = err.message;
        console.error('[ PLATFORM:GC ] Sweep error:', err.message);
    }
    return { ...gcStats, trigger };
}

let _gcTimer = null;
function startGC() {
    if (_gcTimer) return;
    _gcTimer = setInterval(() => { void runGC('interval'); }, GC_INTERVAL_MS);
    _gcTimer.unref?.();
    console.log('[ PLATFORM ] GC started (every 60s)');
}

function getGcStats() { return { ...gcStats }; }

module.exports = {
    manager,
    activeSessionCount,
    provisionSlot,
    cancelSlot,
    requestAnotherCode,
    wireBridge,
    startGC,
    runGC,
    getGcStats,
    removeWebSession,
};
