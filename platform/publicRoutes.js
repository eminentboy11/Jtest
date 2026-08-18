/**
 * June X Platform — PUBLIC routes (pairing gateway).
 *
 * The entire public surface. No signup, no login, no claim keys, no user
 * dashboard — a visitor creates a pairing slot, links WhatsApp, done.
 *
 *   GET  /                       pairing page
 *   POST /api/slots              create slot { mode: 'qr'|'code', phoneNumber? }
 *   GET  /api/slots/:slotId      slot status (polling fallback for WS)
 *   POST /api/slots/:slotId/code request one more pairing code (code mode)
 */

'use strict';

const { Router } = require('express');
const path = require('path');

const slots = require('./slots');
const registry = require('./registry');
const ratelimit = require('./ratelimit');
const sessions = require('./sessions');
const { clientIp } = require('./clientIp');

const router = Router();

function noStore(_req, res, next) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
}

router.use(noStore);
router.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));

// ── Create a pairing slot ─────────────────────────────────────────────────────
router.post('/api/slots', async (req, res) => {
    try {
        const { mode, phoneNumber } = req.body || {};
        if (!['qr', 'code'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be "qr" or "code".' });
        }

        let phone = null;
        if (mode === 'code') {
            phone = String(phoneNumber || '').replace(/\D/g, '');
            if (phone.length < 7 || phone.length > 15) {
                return res.status(400).json({ error: 'Invalid phone number — include country code, digits only.' });
            }
        }

        // Abuse limits
        const ipHash = registry.ipHash(clientIp(req));
        const rl = ratelimit.allowCreate(ipHash);
        if (!rl.ok) {
            return res.status(429).json({ error: `Too many bots created from your network. Try again in ~${rl.retryInMin} min.` });
        }
        if (!ratelimit.underGlobalCap(sessions.activeSessionCount())) {
            return res.status(503).json({ error: 'The platform is at capacity right now — please try again later.' });
        }

        const slot = slots.create({ mode, phone, ipHash });
        try {
            await sessions.provisionSlot(slot);
        } catch (err) {
            slot.status = 'failed';
            slot.error = err.message;
            return res.status(400).json({ error: err.message });
        }

        res.json({ ok: true, slot: slots.publicView(slot) });
    } catch (err) {
        console.error('[ PLATFORM ] Slot creation error:', err.message);
        res.status(500).json({ error: 'Something went wrong — try again.' });
    }
});

// ── Slot status (polling fallback) ────────────────────────────────────────────
router.get('/api/slots/:slotId', (req, res) => {
    const slot = slots.get(req.params.slotId);
    if (!slot) return res.status(404).json({ error: 'Unknown or expired slot.' });
    res.json({ ok: true, slot: slots.publicView(slot) });
});

// ── Cancel an in-progress public slot and its temporary engine session ────────
router.delete('/api/slots/:slotId', async (req, res) => {
    try {
        const result = await sessions.cancelSlot(req.params.slotId);
        if (!result.ok) {
            const status = result.reason === 'unknown-slot' ? 404 : 409;
            return res.status(status).json({ error: result.reason });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('[ PLATFORM ] Slot cancellation error:', error.message);
        res.status(500).json({ error: 'Could not cancel this pairing session.' });
    }
});

// ── Request an additional pairing code (code mode) ────────────────────────────
router.post('/api/slots/:slotId/code', async (req, res) => {
    const slot = slots.get(req.params.slotId);
    if (!slot) return res.status(404).json({ error: 'Unknown or expired slot.' });
    if (slot.mode !== 'code') return res.status(400).json({ error: 'This slot uses QR pairing.' });
    if (slot.status !== 'waiting') return res.status(400).json({ error: `Slot is ${slot.status}.` });
    try {
        await sessions.requestAnotherCode(slot);
        res.json({ ok: true, slot: slots.publicView(slot) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = { router };
