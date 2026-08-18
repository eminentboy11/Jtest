/**
 * June X Platform — session orchestration.
 *
 * Glues the engine bridge to the slot store and platform registry:
 *   - provisions engine sessions for public slots (code + qr modes)
 *   - streams QR / pairing-code / paired events into slots
 *   - runs garbage collection (expired slots, dead web sessions)
 *
 * All engine access goes through the engine's OWN runtime hooks
 * (__JUNE_ADD_SESSION, __JUNE_REMOVE_SESSION, __JUNE_RECONCILE_SESSIONS,
 * __JUNE_SESSION_MANAGER) — no second session-lifecycle implementation.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode');

const bridge = require('./bridge');
const slots = require('./slots');
const registry = require('./registry');

const GC_INTERVAL_MS = 60_000;
const NEEDS_LOGIN_GRACE_MS = 10 * 60_000; // web session parked needs-login -> removed after this
const gcStats = { runs: 0, slotsExpired: 0, sessionsRemoved: 0, lastRun: null, lastError: null };

function manager() {
    return global.__JUNE_SESSION_MANAGER || null;
}

function activeSessionCount() {
    return manager()?.list()?.length || 0;
}

// ── QR-mode registry append ───────────────────────────────────────────────────
// Code-mode uses the engine's own __JUNE_ADD_SESSION (which validates phones).
// QR-mode entries have no phone, so we append the {id, qrLogin} entry to the
// JUNE_SESSIONS registry directly and reuse the engine's reconcile pipeline —
// the same pipeline .addbot uses. normalizeSessionEntries preserves the
// qrLogin flag through to BotInstance.
function persistSessionsEnvLine(value) {
    try {
        const envPath = path.join(process.cwd(), '.env');
        if (!fs.existsSync(envPath)) return false;
        const content = fs.readFileSync(envPath, 'utf8');
        if (!/^JUNE_SESSIONS=.*$/m.test(content)) return false;
        global._suppressEnvWatcherUntil = Date.now() + 3000; // engine watcher cooperation
        fs.writeFileSync(envPath, content.replace(/^JUNE_SESSIONS=.*$/m, `JUNE_SESSIONS=${value}`));
        return true;
    } catch (_) {
        return false;
    }
}

async function addQrSession() {
    const id = `web-${crypto.randomBytes(5).toString('hex')}`;
    let parsed;
    try { parsed = JSON.parse(process.env.JUNE_SESSIONS || '[]'); } catch (_) { parsed = []; }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sessions) ? parsed.sessions : []);
    list.push({ id, name: `June X ${id.slice(-3)}`, qrLogin: true });
    const value = JSON.stringify(list);
    process.env.JUNE_SESSIONS = value;
    persistSessionsEnvLine(value);
    if (typeof global.__JUNE_RECONCILE_SESSIONS === 'function') {
        await global.__JUNE_RECONCILE_SESSIONS();
    }
    return { ok: true, id };
}

// ── Public provisioning ───────────────────────────────────────────────────────
async function provisionSlot(slot) {
    if (slot.mode === 'code') {
        const result = await global.__JUNE_ADD_SESSION({ phone: slot.phone });
        if (!result?.ok) {
            const reasons = {
                'invalid-phone': 'Invalid phone number — use country code, digits only.',
                'duplicate-sessionId': 'This session already exists.',
                'quota-phone': 'This number already has the maximum linked sessions.',
                'quota-global': 'The platform is at capacity right now — try again later.',
            };
            throw new Error(reasons[result?.reason] || `Provisioning failed (${result?.reason || 'unknown'}).`);
        }
        slots.bindBot(slot, result.id);
    } else {
        const result = await addQrSession();
        slots.bindBot(slot, result.id);
    }
    await registry.trackSession(slot.botId, { mode: slot.mode, ipHash: slot.ipHash });
    console.log(`[ PLATFORM ] Provisioned ${slot.mode} session "${slot.botId}" for slot ${slot.slotId.slice(0, 6)}…`);
    return slot;
}

/** Request one more pairing code inside the session's existing cycle (code mode). */
async function requestAnotherCode(slot) {
    const bot = manager()?.get(slot.botId);
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
        const result = await global.__JUNE_REMOVE_SESSION(String(botId));
        await registry.markRemoved(botId);
        gcStats.sessionsRemoved++;
        console.log(`[ PLATFORM:GC ] Removed web session "${botId}" (${why}) — ${result?.ok ? 'ok' : result?.reason}`);
    } catch (err) {
        console.error(`[ PLATFORM:GC ] Failed to remove "${botId}":`, err.message);
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
            const bot = manager()?.get(slot.botId);
            if (bot && bot.botState !== 'connected') {
                await removeWebSession(slot.botId, 'slot expired unpaired');
            }
        }

        // 2. Web-managed sessions that never paired and outlived the slot TTL
        //    (covers slots lost to a process restart).
        const tracked = await registry.listActive();
        const now = Date.now();
        for (const rec of tracked) {
            const bot = manager()?.get(rec.botId);
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
    requestAnotherCode,
    wireBridge,
    startGC,
    runGC,
    getGcStats,
    removeWebSession,
};
