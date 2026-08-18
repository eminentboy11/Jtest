/**
 * June X Platform — log events + console interception.
 *
 * Ported from Dashboard Edition's dashboard/events.js: intercepts
 * console.log/warn/error into a 500-entry ring buffer (ANSI stripped) and
 * publishes entries to subscribers (dev WS stream). Session log lines already
 * carry the engine's per-session prefixes ([ SESSION:id ], [ JUNEX ULTRA nnn ]),
 * so the dev panel can filter by session without structured tagging.
 */

'use strict';

const MAX_LOGS = 500;

let logId = 0;
const logBuffer = [];
const subscribers = new Set();

function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

function emit(event) {
    for (const fn of subscribers) {
        try { fn(event); } catch (_) { /* never break logging */ }
    }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Keep the /dev stream consistent with the engine's stdout/stderr filter.
// These are recoverable libsignal ratchet messages commonly emitted briefly
// after restoring/reconnecting a valid WhatsApp session.
const SIGNAL_NOISE_PATTERNS = [
    'closing session: sessionentry',
    'sessionentry {',
    'failed to decrypt message with any known session',
    'session error: error: bad mac',
    'bad mac error: bad mac',
    'decrypted message with closed session',
    'incoming prekey bundle',
    'closing open session in favor of incoming prekey bundle',
];
let suppressSignalStackUntil = 0;

function shouldSuppressSignalNoise(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (SIGNAL_NOISE_PATTERNS.some(pattern => lower.includes(pattern))) {
        suppressSignalStackUntil = Date.now() + 2500;
        return true;
    }

    const signalStackFrame =
        lower.includes('/libsignal/') ||
        lower.includes('session_cipher.js') ||
        lower.includes('queue_job.js') ||
        lower.includes('object.verifymac') ||
        /^\s*at\s/.test(text) ||
        text.trim() === '...';
    return Date.now() < suppressSignalStackUntil && signalStackFrame;
}

function safeString(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function pushLog(level, args) {
    try {
        const msg = args.map(safeString).join(' ').replace(ANSI_RE, '').slice(0, 2000);
        if (!msg.trim() || shouldSuppressSignalNoise(msg)) return;
        const entry = { id: ++logId, ts: Date.now(), level, msg };
        if (logBuffer.length >= MAX_LOGS) logBuffer.shift();
        logBuffer.push(entry);
        emit({ type: 'log', entry });
    } catch (_) { /* logging must never throw */ }
}

// ── Console interception (registered once, on first require) ─────────────────
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

console.log = (...a) => { _log(...a); pushLog('info', a); };
console.warn = (...a) => { _warn(...a); pushLog('warn', a); };
console.error = (...a) => { _error(...a); pushLog('error', a); };

function getLogs(limit = 200, level = 'all') {
    let logs = logBuffer;
    if (level !== 'all') logs = logs.filter((e) => e.level === level);
    return logs.slice(-Number(limit));
}

module.exports = {
    subscribe,
    pushLog,
    getLogs,
    _shouldSuppressSignalNoise: shouldSuppressSignalNoise,
};
