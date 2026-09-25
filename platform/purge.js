'use strict';

/**
 * purgeBot — clear everything pertaining to one botId.
 *
 * A genuine WhatsApp logout (401 that is NOT a conflict, or a ban) leaves the
 * session credentials dead. Before this existed, index.js parked such a bot in
 * state 'waiting' with its auth dir, data file, slot and registry record all
 * still on disk — a zombie the next restart tripped over. This is the single
 * place that erases a bot completely:
 *
 *   1. memory       — live socket (listeners removed, socket ended) + bots Map entry
 *   2. credentials  — auth/<botId>/  (the Baileys session WhatsApp revoked)
 *   3. settings     — data/bots/<botId>.json via database.purgeBot, which also
 *                     cancels any pending debounced write so the file cannot
 *                     be resurrected a moment later
 *   4. slot         — the pairing slot bound to this bot, if any
 *   5. registry     — the platform registry record marked removed
 *
 * Idempotent: missing targets are skipped, not errors. The report lists what
 * was actually found and cleared.
 *
 * WDP's rule (their index.js ~1300): only call this for a REAL logout/ban.
 * A 401 whose message says "conflict" is a device takeover — recoverable —
 * and erasing a verified session there destroys a healthy bot.
 */

const fs = require('fs');
const path = require('path');
const database = require('../database');
const slots = require('./slots');
const registry = require('./registry');

async function purgeBot(botId, { reason = 'purge', bots, authRoot } = {}) {
    const id = String(botId);
    const cleared = [];

    // 1. in-memory bot + its socket (bots Map is owned by index.js, so it is injected)
    if (bots && typeof bots.has === 'function' && bots.has(id)) {
        const bot = bots.get(id);
        try { bot?.sock?.ev?.removeAllListeners?.(); bot?.sock?.end?.(new Error(reason)); } catch (_) {}
        bots.delete(id);
        cleared.push('memory');
    }

    // 2. session credentials on disk
    try {
        const authDir = path.join(authRoot || path.join(process.cwd(), 'auth'), id);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            cleared.push('credentials');
        }
    } catch (_) {}

    // 3. per-bot settings/data file (debounce-safe — see database.purgeBot)
    try {
        if (fs.existsSync(database.botDataFile(id))) cleared.push('settings');
        database.purgeBot(id);
    } catch (_) {}

    // 4. pairing slot bound to this bot
    try {
        const slot = slots.getByBotId(id);
        if (slot) { slots.discard(slot.slotId); cleared.push('slot'); }
    } catch (_) {}

    // 5. platform registry record
    try {
        const rec = await registry.getSession(id);
        if (rec) { await registry.markRemoved(id); cleared.push('registry'); }
    } catch (_) {}

    console.log(`[ ${id} ] 🧹 Purged (${reason}) — ${cleared.join(', ') || 'nothing to clear'}`);
    return { ok: true, id, reason, cleared };
}

module.exports = { purgeBot };
