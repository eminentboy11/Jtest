/** Pure helpers for web/internal session registry and quota operations. */

'use strict';

const DEFAULT_MAX_SESSIONS = 10;
const WHATSAPP_DEVICE_CAP = 4;
const DEFAULT_STABILIZE_MS = 3000;

const digitsOnly = value => String(value || '').replace(/\D/g, '');

function parseMaxSessions(raw) {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_SESSIONS;
}

function parseStabilizeMs(raw) {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STABILIZE_MS;
}

function countSessionsForPhone(entries, phone) {
    const target = digitsOnly(phone);
    if (!target) return 0;
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => digitsOnly(entry?.phone) === target).length;
}

function checkAddQuota({ registry = [], runningPhones = [], phone, max }) {
    const limit = parseMaxSessions(max);
    const total = Math.max(
        Array.isArray(registry) ? registry.length : 0,
        Array.isArray(runningPhones) ? runningPhones.length : 0
    );
    if (total >= limit) return { ok: false, reason: 'quota', limit, total };

    const samePhone = Math.max(
        countSessionsForPhone(registry, phone),
        (runningPhones || []).filter(value => digitsOnly(value) === digitsOnly(phone)).length
    );
    if (samePhone >= WHATSAPP_DEVICE_CAP) {
        return { ok: false, reason: 'device-limit', limit: WHATSAPP_DEVICE_CAP, samePhone };
    }
    return { ok: true, limit };
}

function findRegistryEntryIndex(registry, identifier) {
    const list = Array.isArray(registry) ? registry : [];
    const raw = String(identifier || '').trim();
    const needle = /^\d+$/.test(raw) ? raw : '';
    const phoneOccurrences = new Map();

    for (let index = 0; index < list.length; index += 1) {
        const entry = list[index] || {};
        const phone = digitsOnly(entry.phone);
        let derivedId = String(entry.id || '').trim();
        if (!derivedId && phone) {
            const ordinal = (phoneOccurrences.get(phone) || 0) + 1;
            phoneOccurrences.set(phone, ordinal);
            derivedId = ordinal === 1 ? phone : `${phone}-${ordinal}`;
        }
        if (derivedId === raw || String(entry.id || '') === raw) return index;
        if (needle && phone === needle) return index;
    }
    return -1;
}

function removeRegistryEntry(registry, identifier) {
    const list = Array.isArray(registry) ? [...registry] : [];
    const index = findRegistryEntryIndex(list, identifier);
    if (index < 0) return { ok: false, reason: 'unknown', registry: list };
    const [removed] = list.splice(index, 1);
    return { ok: true, registry: list, removed };
}

// Retained for backward-compatible paused registry entries. The web platform's
// current Stop action is runtime-only and does not call this helper.
function setRegistryPaused(registry, identifier, paused) {
    const list = (Array.isArray(registry) ? registry : []).map(entry => ({ ...entry }));
    const index = findRegistryEntryIndex(list, identifier);
    if (index < 0) return { ok: false, reason: 'unknown', registry: list };

    const current = list[index]?.paused === true;
    const next = paused === true;
    if (current === next) {
        return {
            ok: false,
            reason: next ? 'already-paused' : 'already-active',
            registry: list,
            entry: list[index],
        };
    }
    if (next) list[index].paused = true;
    else delete list[index].paused;
    return { ok: true, registry: list, entry: list[index], paused: next };
}

module.exports = {
    DEFAULT_MAX_SESSIONS,
    WHATSAPP_DEVICE_CAP,
    DEFAULT_STABILIZE_MS,
    digitsOnly,
    parseMaxSessions,
    parseStabilizeMs,
    countSessionsForPhone,
    checkAddQuota,
    findRegistryEntryIndex,
    removeRegistryEntry,
    setRegistryPaused,
};
