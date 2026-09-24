/**
 * Web Lite — pairing slot store (ephemeral, in-memory)
 */
'use strict';
const crypto = require('crypto');
const SLOT_TTL_MS = Math.max(3, parseInt(process.env.PLATFORM_SLOT_TTL_MIN || '15', 10)) * 60_000;
const PAIRED_RETENTION_MS = 10 * 60_000;

const slots = new Map();
const byBotId = new Map();
const subscribers = new Set();

function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
function emit(event) { for (const fn of subscribers) { try { fn(event); } catch (_) {} } }

function newSlotId() { return crypto.randomBytes(18).toString('base64url'); }

function create({ mode, phone = null, ipHash = null }) {
    const slot = {
        slotId: newSlotId(),
        mode,
        phone,
        botId: null,
        status: 'waiting',
        error: null,
        qr: null,
        codes: [],
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

function bindBot(slot, botId) { slot.botId = String(botId); byBotId.set(slot.botId, slot.slotId); }
function get(slotId) { return slots.get(slotId) || null; }
function getByBotId(botId) { const sid = byBotId.get(String(botId)); return sid ? slots.get(sid) || null : null; }
function list() { return [...slots.values()]; }
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
function update(slot, patch) { Object.assign(slot, patch); emit({ type: 'slot', slotId: slot.slotId, slot: publicView(slot) }); }

function setQR(botId, dataUrl) { const s = getByBotId(botId); if (!s || s.status !== 'waiting') return; update(s, { qr: { dataUrl, at: Date.now() } }); }
function updateQr(slotId, dataUrl) { const s = get(slotId); if (!s) return; if (typeof slotId === 'string' && dataUrl && !s.botId) { update(s, { qr: { dataUrl, at: Date.now() } }); return; } setQR(s.botId || slotId, dataUrl); }
function setCode(botId, code, attempt, limit) { const s = getByBotId(botId); if (!s || s.status !== 'waiting') return; s.codes.push({ code, attempt, limit, at: Date.now() }); update(s, { attemptsUsed: attempt, attemptsLimit: limit }); }
function updateCode(slotId, code) { const s = get(slotId); if (!s) return; const attempt = (s.attemptsUsed || 0) + 1; s.codes.push({ code, attempt, limit: 3, at: Date.now() }); update(s, { attemptsUsed: attempt }); }
function setPaired(botId, botNum) { const s = getByBotId(botId); if (!s) return; update(s, { status: 'paired', botNum: botNum || null, qr: null }); }
function markPaired(slotId, botNum) { const s = get(slotId); if (!s) return setPaired(slotId, botNum); update(s, { status: 'paired', botNum: botNum || null, qr: null }); }
function setFailed(botId, error) { const s = getByBotId(botId); if (!s || s.status === 'paired') return; update(s, { status: 'failed', error: String(error || 'failed') }); }
function markFailed(slotId, error) { const s = get(slotId); if (!s) return setFailed(slotId, error); update(s, { status: 'failed', error: String(error || 'failed') }); }

function sweep() {
    const now = Date.now();
    const expiredWaiting = [];
    for (const slot of slots.values()) {
        if (slot.status === 'waiting' && now > slot.expiresAt) { update(slot, { status: 'expired', qr: null }); expiredWaiting.push(slot); }
        const retire = (slot.status === 'paired' && now > (slot.expiresAt + PAIRED_RETENTION_MS)) || ((slot.status === 'expired' || slot.status === 'failed') && now > (slot.expiresAt + PAIRED_RETENTION_MS));
        if (retire) { if (slot.botId) byBotId.delete(slot.botId); slots.delete(slot.slotId); }
    }
    return expiredWaiting;
}

function forceExpire(slotId) { const s = slots.get(slotId); if (!s) return null; if (s.status === 'waiting') update(s, { status: 'expired', qr: null }); return s; }
function discard(slotId) { const s = slots.get(slotId); if (!s) return null; if (s.botId) byBotId.delete(String(s.botId)); slots.delete(slotId); emit({ type: 'slot_removed', slotId, botId: s.botId || null }); return s; }
function stats() { const all = list(); return { total: all.length, waiting: all.filter(s=>s.status==='waiting').length, paired: all.filter(s=>s.status==='paired').length, expired: all.filter(s=>s.status==='expired').length, failed: all.filter(s=>s.status==='failed').length, ttlMinutes: SLOT_TTL_MS/60000 }; }

module.exports = { SLOT_TTL_MS, subscribe, create, bindBot, get, getByBotId, list, publicView, setQR, updateQr, setCode, updateCode, setPaired, markPaired, setFailed, markFailed, sweep, forceExpire, discard, stats };
