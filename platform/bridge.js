/**
 * June X Platform — engine bridge.
 *
 * The ONLY module the engine (index.js / sessionManager) talks to. It has zero
 * imports from the rest of the platform so requiring it early in index.js can
 * never create a circular dependency. The platform layer subscribes to these
 * events at attach time.
 *
 * Engine -> platform events:
 *   conn-update      (bot, update, sock)   every Baileys connection.update
 *   pairing-code     (bot, code, reservation)
 *   pairing-exhausted(bot)
 */

'use strict';

// Platform mode is on by default; JUNE_PLATFORM=false restores the plain
// multi-session bot with no public gateway. With platform mode on and no
// registry configured we default to an EMPTY registry so the engine never
// falls into the legacy "no TTY -> process.exit(1)" first-run path.
const platformEnabled = String(process.env.JUNE_PLATFORM ?? 'true').toLowerCase() !== 'false';
if (platformEnabled && !process.env.JUNE_SESSIONS) {
    process.env.JUNE_SESSIONS = '[]';
}

const listeners = new Map(); // event -> Set<fn>

function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
}

function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
        try {
            const out = fn(...args);
            if (out && typeof out.catch === 'function') out.catch(() => {});
        } catch (_) { /* platform errors must never break the engine */ }
    }
}

module.exports = {
    platformEnabled,
    on,
    emitConnUpdate:        (bot, update, sock)      => emit('conn-update', bot, update, sock),
    emitPairingCode:       (bot, code, reservation) => emit('pairing-code', bot, code, reservation),
    emitPairingExhausted:  (bot)                    => emit('pairing-exhausted', bot),
};
