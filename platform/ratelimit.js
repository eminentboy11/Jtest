/**
 * June X Platform — abuse limits.
 *
 * Per-IP slot-creation limiter (sliding window) + global active-session cap.
 * In-memory: single-process platform, matching the approved Phase 1 scope.
 */

'use strict';

const { MAX_BOTS, positiveInt } = require('./limits');

const WINDOW_MS = 60 * 60_000; // 1 hour
const PER_IP = positiveInt(process.env.PLATFORM_CREATES_PER_HOUR, 4);
const LOGIN_WINDOW_MS = positiveInt(process.env.PLATFORM_LOGIN_WINDOW_MIN, 15) * 60_000;
const LOGIN_BLOCK_MS = positiveInt(process.env.PLATFORM_LOGIN_BLOCK_MIN, 15) * 60_000;
const LOGIN_ATTEMPTS = positiveInt(process.env.PLATFORM_LOGIN_ATTEMPTS, 5);

const hits = new Map(); // ipHash -> [timestamps]
const loginFailures = new Map(); // ipHash -> { attempts:[timestamps], blockedUntil }

function prune(arr, now) {
    while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
    return arr;
}

/** Check + consume one creation attempt for this ipHash. */
function allowCreate(ipHash) {
    const now = Date.now();
    const arr = prune(hits.get(ipHash) || [], now);
    if (arr.length >= PER_IP) {
        hits.set(ipHash, arr);
        const retryInMs = WINDOW_MS - (now - arr[0]);
        return { ok: false, reason: 'ip-limit', retryInMin: Math.ceil(retryInMs / 60000) };
    }
    arr.push(now);
    hits.set(ipHash, arr);
    return { ok: true };
}

function underGlobalCap(activeSessionCount) {
    return activeSessionCount < MAX_BOTS;
}

function loginStatus(ipHash) {
    const now = Date.now();
    const record = loginFailures.get(ipHash) || { attempts: [], blockedUntil: 0 };
    record.attempts = record.attempts.filter(timestamp => now - timestamp <= LOGIN_WINDOW_MS);
    if (record.blockedUntil > now) {
        loginFailures.set(ipHash, record);
        return { ok: false, retryAfterMs: record.blockedUntil - now };
    }
    if (record.blockedUntil) record.blockedUntil = 0;
    loginFailures.set(ipHash, record);
    return { ok: true, remaining: Math.max(0, LOGIN_ATTEMPTS - record.attempts.length) };
}

function recordLoginFailure(ipHash) {
    const now = Date.now();
    const record = loginFailures.get(ipHash) || { attempts: [], blockedUntil: 0 };
    record.attempts = record.attempts.filter(timestamp => now - timestamp <= LOGIN_WINDOW_MS);
    record.attempts.push(now);
    if (record.attempts.length >= LOGIN_ATTEMPTS) record.blockedUntil = now + LOGIN_BLOCK_MS;
    loginFailures.set(ipHash, record);
    return loginStatus(ipHash);
}

function clearLoginFailures(ipHash) {
    loginFailures.delete(ipHash);
}

function sweep() {
    const now = Date.now();
    for (const [key, arr] of hits) {
        prune(arr, now);
        if (arr.length === 0) hits.delete(key);
    }
    for (const [key, record] of loginFailures) {
        record.attempts = record.attempts.filter(timestamp => now - timestamp <= LOGIN_WINDOW_MS);
        if (record.attempts.length === 0 && record.blockedUntil <= now) loginFailures.delete(key);
    }
}

function stats() {
    sweep();
    return {
        perIpPerHour: PER_IP,
        maxBots: MAX_BOTS,
        trackedIps: hits.size,
        loginProtection: {
            attempts: LOGIN_ATTEMPTS,
            windowMinutes: LOGIN_WINDOW_MS / 60000,
            blockMinutes: LOGIN_BLOCK_MS / 60000,
            trackedIps: loginFailures.size,
        },
        topIps: [...hits.entries()]
            .map(([ip, arr]) => ({ ipHash: ip, creates: arr.length }))
            .sort((a, b) => b.creates - a.creates)
            .slice(0, 10),
    };
}

module.exports = {
    allowCreate,
    underGlobalCap,
    loginStatus,
    recordLoginFailure,
    clearLoginFailures,
    sweep,
    stats,
    MAX_BOTS,
};
