/**
 * Web Lite — pure event bridge, no mode, no toggle, always web.
 * Engine -> platform events: conn-update, pairing-code, pairing-exhausted
 */
'use strict';

const listeners = new Map();

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
        } catch (_) {}
    }
}

module.exports = {
    on,
    emitConnUpdate: (bot, update, sock) => emit('conn-update', bot, update, sock),
    emitPairingCode: (bot, code, reservation) => emit('pairing-code', bot, code, reservation),
    emitPairingExhausted: (bot) => emit('pairing-exhausted', bot),
};
