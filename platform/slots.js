/**
 * June X Platform — pairing slot store.
 *
 * A SLOT is one visitor's in-progress pairing attempt. It is ephemeral,
 * in-memory, and identified by an unguessable random id — that id is routing
 * (so each visitor sees only their own QR/code), NOT ownership: it dies when
 * pairing completes or the slot expires, and is never stored or reusable.
 *
 * Slot lifecycle: waiting -> paired | expired | failed
 */

'use strict';

const crypto = require('crypto');

const SLOT_TTL_MS = Math.max(3, parseInt(process.env.PLATFORM_SLOT_TTL_MIN || '15', 10)) * 60_000;
const PAIRED_RETENTION_MS = 10 * 60_000; // keep paired slots visible briefly, then drop

const slots = new Map();      // slotId -> slot
const byBotId = new Map();    // botId -> slotId

const subscribers = new Set(); // fn(event) — ws layer subscribes

function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
function emit(event) {
    for (const fn of subscribers) {
        try { fn(event); } catch (_) { /* ignore */ }
    }
}

function newSlotId() {
    return crypto.randomBytes(18).toString('base64url'); // 24 chars, unguessable
}

function create({ mode, phone = null, ipHash = null }) {
    const slot = {
        slotId: newSlotId(),
        mode,                    // 'qr' | 'code'
        phone,                   // digits, code mode only
        botId: null,             // engine session id once provisioned
        status: 'waiting',       // waiting | paired | expired | failed
        error: null,
        qr: null,                // { dataUrl, at } (qr mode)
        codes: [],               // [{ code, attempt, limit, at }] (code mode)
        attemptsUsed: 0,
        attemptsLimit: 3,
        botNum: null,
        ipHash,
        createdAt: Date.now(),
        expiresAt: Date.now() + SLOT_TTL_MS,
    };
    slots.set(slot.slotId, slot);
    return slot;
}

function bindBot(slot, botId) {
    slot.botId = String(botId);
    byBotId.set(slot.botId, slot.slotId);
}

function get(slotId) { return slots.get(slotId) || null; }
function getByBotId(botId) {
    const slotId = byBotId.get(String(botId));
    return slotId ? slots.get(slotId) || null : null;
}
function list() { return [...slots.values()]; }

/** Public JSON view — never leaks ipHash or internals. */
function publicView(slot) {
    return {
        slotId: slot.slotId,
        mode: slot.mode,
        status: slot.status,
        error: slot.error,
        qr: slot.status === 'waiting' ? slot.qr : null,
        codes: slot.codes,
        attemptsUsed: slot.attemptsUsed,
        attemptsLimit: slot.attemptsLimit,
        botNum: slot.botNum,
        expiresAt: slot.expiresAt,
    };
}

function update(slot, patch) {
    Object.assign(slot, patch);
    emit({ type: 'slot', slotId: slot.slotId, slot: publicView(slot) });
}

function setQR(botId, dataUrl) {
    const slot = getByBotId(botId);
    if (!slot || slot.status !== 'waiting') return;
    update(slot, { qr: { dataUrl, at: Date.now() } });
}

function setCode(botId, code, attempt, limit) {
    const slot = getByBotId(botId);
    if (!slot || slot.status !== 'waiting') return;
    slot.codes.push({ code, attempt, limit, at: Date.now() });
    update(slot, { attemptsUsed: attempt, attemptsLimit: limit });
}

function setPaired(botId, botNum) {
    const slot = getByBotId(botId);
    if (!slot) return;
    update(slot, { status: 'paired', botNum: botNum || null, qr: null });
}

function setFailed(botId, error) {
    const slot = getByBotId(botId);
    if (!slot || slot.status === 'paired') return;
    update(slot, { status: 'failed', error: String(error || 'failed') });
}

/** Expire + prune. Returns slots that expired while still waiting (for GC). */
function sweep() {
    const now = Date.now();
    const expiredWaiting = [];
    for (const slot of slots.values()) {
        if (slot.status === 'waiting' && now > slot.expiresAt) {
            update(slot, { status: 'expired', qr: null });
            expiredWaiting.push(slot);
        }
        const retire =
            (slot.status === 'paired' && now > (slot.expiresAt + PAIRED_RETENTION_MS)) ||
            ((slot.status === 'expired' || slot.status === 'failed') && now > (slot.expiresAt + PAIRED_RETENTION_MS));
        if (retire) {
            if (slot.botId) byBotId.delete(slot.botId);
            slots.delete(slot.slotId);
        }
    }
    return expiredWaiting;
}

function forceExpire(slotId) {
    const slot = slots.get(slotId);
    if (!slot) return null;
    if (slot.status === 'waiting') update(slot, { status: 'expired', qr: null });
    return slot;
}

/** Immediately remove a slot and its reverse bot lookup (rollback/cancel). */
function discard(slotId) {
    const slot = slots.get(slotId);
    if (!slot) return null;
    if (slot.botId) byBotId.delete(String(slot.botId));
    slots.delete(slotId);
    emit({ type: 'slot_removed', slotId, botId: slot.botId || null });
    return slot;
}

function stats() {
    const all = list();
    return {
        total: all.length,
        waiting: all.filter((s) => s.status === 'waiting').length,
        paired: all.filter((s) => s.status === 'paired').length,
        expired: all.filter((s) => s.status === 'expired').length,
        failed: all.filter((s) => s.status === 'failed').length,
        ttlMinutes: SLOT_TTL_MS / 60000,
    };
}

module.exports = {
    SLOT_TTL_MS,
    subscribe,
    create,
    bindBot,
    get,
    getByBotId,
    list,
    publicView,
    setQR,
    setCode,
    setPaired,
    setFailed,
    sweep,
    forceExpire,
    discard,
    stats,
};
