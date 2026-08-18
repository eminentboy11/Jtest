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

function safeString(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function pushLog(level, args) {
    try {
        const msg = args.map(safeString).join(' ').replace(ANSI_RE, '').slice(0, 2000);
        if (!msg.trim()) return;
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

module.exports = { subscribe, pushLog, getLogs };
