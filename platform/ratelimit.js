/**
 * June X Platform — abuse limits.
 *
 * Per-IP slot-creation limiter (sliding window) + global active-session cap.
 * In-memory: single-process platform, matching the approved Phase 1 scope.
 */

'use strict';

const WINDOW_MS = 60 * 60_000; // 1 hour
const PER_IP = Math.max(1, parseInt(process.env.PLATFORM_CREATES_PER_HOUR || '4', 10));
const MAX_BOTS = Math.max(1, parseInt(process.env.PLATFORM_MAX_BOTS || '30', 10));

const hits = new Map(); // ipHash -> [timestamps]

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

function sweep() {
    const now = Date.now();
    for (const [key, arr] of hits) {
        prune(arr, now);
        if (arr.length === 0) hits.delete(key);
    }
}

function stats() {
    sweep();
    return {
        perIpPerHour: PER_IP,
        maxBots: MAX_BOTS,
        trackedIps: hits.size,
        topIps: [...hits.entries()]
            .map(([ip, arr]) => ({ ipHash: ip, creates: arr.length }))
            .sort((a, b) => b.creates - a.creates)
            .slice(0, 10),
    };
}

module.exports = { allowCreate, underGlobalCap, sweep, stats, MAX_BOTS };
