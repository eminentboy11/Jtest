/**
 * June X Platform — DEVELOPER routes (/dev control room).
 *
 * Completely separated from the public gateway: separate router, separate
 * auth, no shared endpoints. Token auth is ALWAYS enforced at the app layer
 * (ported from Dashboard Edition: ADMIN_PASSWORD -> timing-safe compare ->
 * 8h bearer token) — network-level /dev blocking is defense-in-depth on top,
 * never a replacement.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');

const logStore = require('./logStore');
const slots = require('./slots');
const registry = require('./registry');
const ratelimit = require('./ratelimit');
const sessions = require('./sessions');
const sessionService = require('./sessionService');
const { clientIp } = require('./clientIp');

const router = Router();
router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// ── Token store (Dashboard Edition pattern) ───────────────────────────────────
const tokens = new Map(); // token -> expiry epoch ms
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function issueToken() {
    const now = Date.now();
    for (const [token, expiry] of tokens) if (expiry <= now) tokens.delete(token);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, now + TOKEN_TTL_MS);
    return token;
}

function tokenExpiry(token) {
    if (!token) return null;
    const expiry = tokens.get(token);
    if (!expiry || Date.now() >= expiry) {
        if (token) tokens.delete(token);
        return null;
    }
    return expiry;
}

function checkToken(token) {
    return Boolean(tokenExpiry(token));
}

function extractToken(req) {
    return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function requireDev(req, res, next) {
    if (checkToken(extractToken(req))) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Page + auth ───────────────────────────────────────────────────────────────
router.get('/dev', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dev.html')));
router.get('/dev/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dev.html')));

router.post('/dev/api/login', (req, res) => {
    const configured = process.env.ADMIN_PASSWORD;
    if (!configured) {
        return res.status(503).json({ error: 'ADMIN_PASSWORD is not set — the dev panel is disabled until you set it in .env.' });
    }

    const ipHash = registry.ipHash(clientIp(req));
    const allowed = ratelimit.loginStatus(ipHash);
    if (!allowed.ok) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))));
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const supplied = String(req.body?.password || '');
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(String(configured)).digest();
    if (!crypto.timingSafeEqual(a, b)) {
        const afterFailure = ratelimit.recordLoginFailure(ipHash);
        if (!afterFailure.ok) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(afterFailure.retryAfterMs / 1000))));
            return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
        }
        return res.status(401).json({ error: 'Incorrect password.' });
    }

    ratelimit.clearLoginFailures(ipHash);
    res.json({ ok: true, token: issueToken() });
});

router.get('/dev/api/me', requireDev, (_req, res) => res.json({ ok: true }));
router.post('/dev/api/logout', requireDev, (req, res) => {
    tokens.delete(extractToken(req));
    res.json({ ok: true });
});

// ── Overview ──────────────────────────────────────────────────────────────────
router.get('/dev/api/overview', requireDev, async (_req, res) => {
    try {
        const snapshot = sessionService.snapshot();
        const mem = process.memoryUsage();
        res.json({
            sessions: {
                total: snapshot.length,
                connected: snapshot.filter((s) => s.state === 'connected').length,
                connecting: snapshot.filter((s) => s.state === 'connecting').length,
                needsLogin: snapshot.filter((s) => s.state === 'needs-login').length,
                disconnected: snapshot.filter((s) => s.state === 'disconnected').length,
            },
            slots: slots.stats(),
            gc: sessions.getGcStats(),
            limits: ratelimit.stats(),
            registry: await registry.status(),
            process: {
                uptime: Math.floor(process.uptime()),
                memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
                nodeVersion: process.version,
                pid: process.pid,
                platform: process.platform,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
router.get('/dev/api/sessions', requireDev, async (_req, res) => {
    try {
        const tracked = new Map((await registry.listActive()).map((r) => [r.botId, r]));
        const list = sessionService.list().map((bot) => {
            const rec = tracked.get(bot.id);
            return {
                ...bot.status,
                phone: bot.phone ? `${bot.phone.slice(0, 4)}****${bot.phone.slice(-2)}` : null,
                webManaged: Boolean(rec),
                mode: rec?.mode || null,
                trackedCreatedAt: rec?.createdAt || null,
                trackedPairedAt: rec?.pairedAt || null,
            };
        });
        res.json({ sessions: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Permanent fleet wipe. The explicit phrase prevents accidental API/UI clicks.
router.delete('/dev/api/sessions', requireDev, async (req, res) => {
    if (String(req.body?.confirmation || '') !== 'DELETE ALL') {
        return res.status(400).json({ error: 'Confirmation phrase DELETE ALL is required.' });
    }

    try {
        const result = await sessionService.removeAll({ reason: 'developer-delete-all' });
        const registryFailures = [];
        for (const deleted of result.deleted) {
            try {
                await registry.markRemoved(deleted.id);
                for (const slot of slots.list()) {
                    if (String(slot.botId || '') === deleted.id) slots.discard(slot.slotId);
                }
            } catch (error) {
                registryFailures.push({ id: deleted.id, reason: error.message });
            }
        }

        const failed = [...result.failed, ...registryFailures];
        console.log(`[ DEV ] Delete-all completed — deleted=${result.deleted.length}, failed=${failed.length}`);
        res.status(failed.length ? 207 : 200).json({
            ok: failed.length === 0,
            total: result.total,
            deleted: result.deleted.map(item => item.id),
            failed,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/dev/api/sessions/:id/reconnect', requireDev, async (req, res) => {
    const id = String(req.params.id);
    const bot = sessionService.get(id);
    if (!bot) return res.status(404).json({ error: 'Unknown session.' });
    try {
        console.log(`[ DEV ] Reconnect requested for session "${id}"`);
        const result = await sessionService.reconnect(id, { repair: bot.botState === 'needs-login' });
        if (!result?.ok) return res.status(400).json({ error: result?.error || result?.reason || 'Reconnect failed.' });
        res.json({ ok: true, message: result.connected === false ? 'Reconnect started; session is still connecting.' : 'Session reconnected.', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/dev/api/sessions/:id/stop', requireDev, async (req, res) => {
    const id = String(req.params.id);
    try {
        console.log(`[ DEV ] Stop requested for session "${id}"`);
        const result = await sessionService.stop(id);
        if (!result?.ok) return res.status(404).json({ error: 'Unknown session.' });
        res.json({ ok: true, message: 'Session stopped (authentication preserved).', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/dev/api/sessions/:id', requireDev, async (req, res) => {
    const id = String(req.params.id);
    try {
        console.log(`[ DEV ] DELETE requested for session "${id}"`);
        const result = await sessionService.remove(id, { reason: 'developer-delete' });
        if (!result?.ok) return res.status(400).json({ error: `Remove failed: ${result?.reason || 'unknown'}` });
        await registry.markRemoved(id);
        res.json({ ok: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Slots ─────────────────────────────────────────────────────────────────────
router.get('/dev/api/slots', requireDev, (_req, res) => {
    res.json({
        slots: slots.list().map((s) => ({
            slotId: s.slotId,
            mode: s.mode,
            status: s.status,
            botId: s.botId,
            ipHash: s.ipHash,
            attemptsUsed: s.attemptsUsed,
            attemptsLimit: s.attemptsLimit,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            botNum: s.botNum,
        })),
        stats: slots.stats(),
    });
});

router.delete('/dev/api/slots/:slotId', requireDev, (req, res) => {
    const slot = slots.forceExpire(req.params.slotId);
    if (!slot) return res.status(404).json({ error: 'Unknown slot.' });
    console.log(`[ DEV ] Slot ${req.params.slotId.slice(0, 6)}… force-expired`);
    res.json({ ok: true });
});

// ── Logs / GC / health ────────────────────────────────────────────────────────
router.get('/dev/api/logs', requireDev, (req, res) => {
    const { limit = 200, level = 'all' } = req.query;
    res.json({ logs: logStore.getLogs(limit, level) });
});

router.post('/dev/api/gc/run', requireDev, async (_req, res) => {
    const result = await sessions.runGC('manual');
    res.json({ ok: true, gc: result });
});

module.exports = { router, checkToken, tokenExpiry };
