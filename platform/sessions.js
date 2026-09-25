/**
 * Web Lite — session orchestration (provision + GC), no heavy deps.
 */
'use strict';

const DEBUG_LOG = ['true','1','yes','on'].includes(String(process.env.DEBUG || '').trim().toLowerCase());
const qrcode = require('qrcode');
const bridge = require('./bridge');
const slots = require('./slots');
const registry = require('./registry');
const sessionService = require('./sessionService');

const GC_INTERVAL_MS = 60_000;
const NEEDS_LOGIN_GRACE_MS = 10 * 60_000;
const gcStats = { runs: 0, slotsExpired: 0, sessionsRemoved: 0, lastRun: null, lastError: null };

function activeSessionCount() { return sessionService.configured() ? sessionService.activeCount() : 0; }

function provisioningMessage(reason) {
    const reasons = {
        'invalid-phone': 'Invalid phone number.',
        'duplicate-id': 'Session id collided — try again.',
        quota: 'Platform at capacity — try later.',
    };
    return reasons[reason] || `Provisioning failed (${reason || 'unknown'}).`;
}

async function provisionSlot(slot) {
    try {
        const result = await sessionService.provision(
            { mode: slot.mode, phone: slot.phone },
            {
                commit: async (created) => {
                    slots.bindBot(slot, created.id);
                    // Also set bot.slotId for direct slot updates (fixes UI not showing code)
                    try {
                        const bot = sessionService.get(created.id);
                        if (bot) {
                            bot.slotId = slot.slotId;
                            // If pairing code was already generated inside provision (before bind), push it to slot now
                            if (bot.pairing?.lastCode) {
                                console.log(`[ ${bot.id} ] Commit: pushing existing code ${bot.pairing.lastCode} to slot ${slot.slotId.slice(0,6)}`);
                                slots.setCode(bot.id, bot.pairing.lastCode, bot.pairing.attempts, 3);
                            }
                            // If QR was generated before bind, push it too
                            if (bot._lastQrDataUrl) {
                                slots.setQR(bot.id, bot._lastQrDataUrl);
                            }
                        }
                    } catch (_) {}
                    await registry.trackSession(created.id, {
                        mode: slot.mode,
                        phone: created.phone || slot.phone || null,
                        ipHash: slot.ipHash,
                    });
                },
            }
        );
        console.log(`[ PLATFORM ] Provisioned ${slot.mode} session "${result.id}" for slot ${slot.slotId.slice(0,6)}…`);
        return slot;
    } catch (error) {
        const botId = slot.botId;
        if (botId) await registry.markRemoved(botId).catch(() => {});
        slots.discard(slot.slotId);
        const reason = error.result?.reason || String(error.message || '').replace(/^PROVISION_FAILED:/, '');
        if (error.rollbackError) console.error(`[ PLATFORM ] Rollback failed for "${botId || '?'}": ${error.rollbackError.message}`);
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

async function requestAnotherCode(slot) {
    const bot = sessionService.get(slot.botId);
    if (!bot) throw new Error('Session no longer exists.');
    if (!bot.sock) throw new Error('Socket not ready — wait a few seconds.');
    if (bot.pairing?.exhausted) throw new Error('Pairing code limit reached.');

    try {
        // Reset the internal requested flag to allow fresh code (pairing code only, no QR talk)
        if (bot.pairing) bot.pairing._requested = false;
        const cleanPhone = String(bot.phone).replace(/\D/g, '');
        console.log(`[ ${bot.id} ] Explicit retry: requesting new pairing code for ${cleanPhone}`);
        const code = await bot.sock.requestPairingCode(cleanPhone);
        const attempt = (bot.pairing.attempts || 0) + 1;
        bot.pairing.attempts = attempt;
        bot.pairing.lastCode = code;
        bot.pairing._requested = true; // keep true to prevent QR double-trigger after explicit retry
        if (attempt >= 3) bot.pairing.exhausted = true;
        slots.setCode(bot.id, code, attempt, 3);
        bridge.emitPairingCode(bot, code, { attempt, limit: 3 });
        console.log(`[ ${bot.id} ] 🔑 New pairing code: ${code} (attempt ${attempt}/3)`);
        return { ok: true, code };
    } catch (e) {
        throw new Error(e.message);
    }
}

function wireBridge() {
    bridge.on('conn-update', async (bot, update, sock) => {
        const { connection, qr } = update;
        if (qr) {
            const slot = slots.getByBotId(bot.id);
            if (slot && slot.mode === 'qr' && slot.status === 'waiting') {
                try {
                    const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
                    slots.setQR(bot.id, dataUrl);
                } catch (_) {}
            }
        }
        if (connection === 'open') {
            const botNum = sock?.user?.id?.split(':')[0] || bot.accountNumber || null;
            if (slots.getByBotId(bot.id)) {
                slots.setPaired(bot.id, botNum);
                console.log(`[ PLATFORM ] Slot paired — session "${bot.id}" linked (+${botNum || '?'}).`);
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
        if (slot && slot.status === 'waiting') slots.setFailed(bot.id, 'Pairing limit reached — create new bot.');
    });
}

async function removeWebSession(botId, why) {
    try {
        const result = await sessionService.remove(String(botId), { reason: why });
        if (!result?.ok) throw new Error(result?.reason || 'remove-failed');
        await registry.markRemoved(botId);
        gcStats.sessionsRemoved++;
        console.log(`[ GC ] Removed "${botId}" (${why})`);
        return result;
    } catch (err) {
        console.error(`[ GC ] Failed to remove "${botId}":`, err.message);
        return { ok: false, reason: err.message };
    }
}

async function runGC(trigger = 'interval') {
    gcStats.runs++;
    gcStats.lastRun = Date.now();
    try {
        const expired = slots.sweep();
        gcStats.slotsExpired += expired.length;
        for (const slot of expired) {
            if (!slot.botId) continue;
            const bot = sessionService.get(slot.botId);
            if (bot && bot.state !== 'connected') await removeWebSession(slot.botId, 'slot expired unpaired');
        }
        const tracked = await registry.listActive();
        const now = Date.now();
        for (const rec of tracked) {
            const bot = sessionService.get(rec.botId);
            if (!bot) { if (!rec.removedAt) await registry.markRemoved(rec.botId); continue; }
            const neverPaired = !rec.pairedAt && (now - rec.createdAt > slots.SLOT_TTL_MS + 5*60_000);
            const parkedDead = bot.state === 'needs-login' && (now - (rec.pairedAt || rec.createdAt) > NEEDS_LOGIN_GRACE_MS);
            if (bot.state === 'connected') continue;
            if (neverPaired || parkedDead) await removeWebSession(rec.botId, neverPaired ? 'never paired' : 'parked needs-login');
        }
        try { require('./ratelimit').sweep(); } catch (_) {}
        gcStats.lastError = null;
    } catch (err) {
        gcStats.lastError = err.message;
        console.error('[ GC ] Sweep error:', err.message);
    }
    return { ...gcStats, trigger };
}

let _gcTimer = null;
function startGC() { if (_gcTimer) return; _gcTimer = setInterval(() => { void runGC('interval'); }, GC_INTERVAL_MS); _gcTimer.unref?.(); if (DEBUG_LOG) console.log('[ PLATFORM ] GC started (60s)'); }
function stopGC() { if (_gcTimer) clearInterval(_gcTimer); _gcTimer = null; }
function getGcStats() { return { ...gcStats }; }

module.exports = { activeSessionCount, provisionSlot, cancelSlot, requestAnotherCode, wireBridge, startGC, stopGC, runGC, getGcStats, removeWebSession };
