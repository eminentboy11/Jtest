/**
 * JTEST WEB LITE — Fully web-based, no JUNE_SESSIONS, no JUNE_PLATFORM toggle, no dev dashboard.
 * - Sessions are created ONLY via web UI at / (QR / pairing code)
 * - Persisted in data/platform-registry.json + auth/<botId>/
 * - 100+ bots capable: file auth (no SQLite per bot), no heavy deps, no message store, no dev panel
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const platformBridge = require('./platform/bridge');
const { attachPlatform } = require('./platform');
const registry = require('./platform/registry');
const sessionService = require('./platform/sessionService');
const slots = require('./platform/slots');

const PORT = Number(process.env.PORT || 3000);
const MAX_BOTS = Math.max(1, Math.floor(Number(process.env.PLATFORM_MAX_BOTS || 100)));
const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_ROOT = path.join(process.cwd(), 'auth');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// ── Bot registry (lite) ────────────────────────────────────────────────────────
const bots = new Map(); // botId -> { id, phone, sock, state, pairing, auth, accountNumber, lastError, connectedAt }

function botStatus(bot) {
    return {
        id: bot.id,
        state: bot.state,
        connected: bot.state === 'connected',
        phone: bot.phone || null,
        account: bot.accountNumber ? `+${String(bot.accountNumber).slice(0,3)}***${String(bot.accountNumber).slice(-3)}` : null,
        connectedAt: bot.connectedAt || null,
        pairingAttempts: bot.pairing?.attempts || 0,
        pairingExhausted: Boolean(bot.pairing?.exhausted),
        error: bot.lastError || null,
    };
}

function getAuthDir(botId) {
    return path.join(AUTH_ROOT, String(botId));
}

async function loadAuth(botId) {
    const dir = getAuthDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    return useMultiFileAuthState(dir);
}

// ── Minimal message handler (lite) ──────────────────────────────────────────
async function handleMessage(bot, sock, msg) {
    try {
        const m = msg.message;
        if (!m) return;
        const text = (m.conversation || m.extendedTextMessage?.text || '').trim();
        if (!text) return;
        const lower = text.toLowerCase();
        if (lower === '.ping' || lower === 'ping' || lower === '.alive') {
            const jid = msg.key.remoteJid;
            await sock.sendMessage(jid, { text: `🔸 pong! ${bot.id} • ${new Date().toLocaleTimeString()} • lite` });
        }
    } catch (_) {}
}

// ── Socket boot (lite) ───────────────────────────────────────────────────────
async function bootBot(botId, opts = {}) {
    const bot = bots.get(String(botId));
    if (!bot) throw new Error(`Unknown bot ${botId}`);
    if (bot.sock && bot.state === 'connected' && !opts.force) return bot;

    bot.state = 'connecting';
    bot.lastError = null;

    const { state, saveCreds } = await loadAuth(bot.id);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        browser: ['JTEST Lite', 'Chrome', '1.0'],
        // lite: no message store, no history sync flood
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    });

    bot.sock = sock;
    bot.auth = { state, saveCreds };

    // Pairing code cycle
    if (!bot.pairing) bot.pairing = { active: false, attempts: 0, exhausted: false, phone: bot.phone || '', lastCode: null, gen: 0 };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        platformBridge.emitConnUpdate(bot, update, sock);

        if (qr && bot.mode === 'qr') {
            try {
                const dataUrl = await qrcode.toDataURL(qr);
                slots.updateQr(bot.slotId, dataUrl);
            } catch (_) {}
        }

        if (connection === 'open') {
            bot.state = 'connected';
            bot.connectedAt = Date.now();
            bot.accountNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || bot.accountNumber || null;
            bot.lastError = null;
            bot.pairing.active = false;
            bot.pairing.exhausted = false;
            console.log(`[ ${bot.id} ] ✅ Connected as ${bot.accountNumber || sock.user?.id}`);
            await registry.markPaired(bot.id, bot.accountNumber).catch(() => {});
            // clear slot if exists
            if (bot.slotId) {
                const s = slots.get(bot.slotId);
                if (s) slots.markPaired(s.slotId, bot.accountNumber);
            }
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';
            console.log(`[ ${bot.id} ] ❌ Closed (${code}) ${reason}`);

            if (code === DisconnectReason.loggedOut) {
                bot.state = 'needs-login';
                bot.lastError = 'Logged out — pair again via web at /';
                // keep auth dir but mark needs-login; user must re-pair via web
                if (bot.slotId) slots.markFailed(bot.slotId, 'logged-out');
            } else if (code === 408) {
                bot.state = 'connecting';
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 3000);
            } else {
                bot.state = 'connecting';
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 4000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            await handleMessage(bot, sock, msg);
        }
    });

    // If code mode and phone present, request pairing code after socket ready
    if (bot.mode === 'code' && bot.phone) {
        // wait a bit for socket to be ready
        setTimeout(async () => {
            try {
                if (!bot.sock || bot.state === 'connected') return;
                if (!bot.pairing.active) {
                    bot.pairing.active = true;
                    bot.pairing.gen += 1;
                    bot.pairing.attempts = 0;
                }
                if (bot.pairing.exhausted) return;
                const gen = bot.pairing.gen;
                const code = await sock.requestPairingCode(bot.phone);
                if (bot.pairing.gen !== gen) return; // stale
                bot.pairing.lastCode = code;
                bot.pairing.attempts += 1;
                if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
                console.log(`[ ${bot.id} ] 🔑 Pairing code: ${code} for ${bot.phone}`);
                platformBridge.emitPairingCode(bot, code, { attempt: bot.pairing.attempts, gen });
                if (bot.slotId) slots.updateCode(bot.slotId, code);
            } catch (e) {
                console.log(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
                bot.lastError = e.message;
                if (bot.slotId) slots.markFailed(bot.slotId, e.message);
            }
        }, 1500);
    }

    return bot;
}

// ── SessionService adapter (platform -> engine) ──────────────────────────────
sessionService.configure({
    async provision(entry, { source, mode }) {
        // entry: { phone } or qr entry { id, name, qrLogin }
        const isQr = mode === 'qr' || entry.qrLogin;
        const id = entry.id || `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
        const phone = (entry.phone || '').replace(/\D/g, '') || null;

        if (bots.has(id)) return { ok: false, reason: 'duplicate-id', id };
        if (bots.size >= MAX_BOTS) return { ok: false, reason: 'quota', id };

        const bot = {
            id,
            phone,
            mode: isQr ? 'qr' : 'code',
            state: 'connecting',
            sock: null,
            accountNumber: null,
            lastError: null,
            connectedAt: null,
            slotId: null,
            pairing: { active: false, attempts: 0, exhausted: false, phone: phone || '', lastCode: null, gen: 0 },
        };
        bots.set(id, bot);

        // boot
        try {
            await bootBot(id);
            return { ok: true, id, phone, mode: bot.mode };
        } catch (e) {
            bots.delete(id);
            return { ok: false, reason: e.message, id };
        }
    },

    async restorePersisted(entries) {
        // entries from sessionService: [{id, phone, qrLogin, restoreOnly}]
        const restored = [];
        for (const e of entries) {
            const id = String(e.id);
            if (bots.has(id)) continue;
            if (bots.size >= MAX_BOTS) break;
            const bot = {
                id,
                phone: (e.phone || '').replace(/\D/g, '') || null,
                mode: e.qrLogin ? 'qr' : 'code',
                state: 'connecting',
                sock: null,
                accountNumber: null,
                lastError: null,
                connectedAt: null,
                slotId: null,
                pairing: { active: false, attempts: 0, exhausted: false, phone: (e.phone || '').replace(/\D/g, ''), lastCode: null, gen: 0 },
            };
            bots.set(id, bot);
            bootBot(id).catch(() => {});
            restored.push(id);
        }
        return { ok: true, restored };
    },

    async remove(botId, { reason } = {}) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try {
            try { bot.sock?.ev?.removeAllListeners?.(); } catch (_) {}
            try { bot.sock?.end?.(new Error(reason || 'removed')); } catch (_) {}
        } catch (_) {}
        bots.delete(id);
        // delete auth dir
        try { fs.rmSync(getAuthDir(id), { recursive: true, force: true }); } catch (_) {}
        console.log(`[ ${id} ] 🗑️ Removed (${reason})`);
        return { ok: true, id };
    },

    async stop(botId) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try { bot.sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { bot.sock?.end?.(new Error('stopped')); } catch (_) {}
        bot.state = 'stopped';
        bot.sock = null;
        return { ok: true, id };
    },

    async reconnect(botId, { repair } = {}) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try {
            await bootBot(id, { force: true });
            return { ok: true, id, connected: bot.state === 'connected' };
        } catch (e) {
            return { ok: false, reason: e.message, id };
        }
    },

    async reconcile() { return { ok: true }; },

    get(botId) { return bots.get(String(botId)) || null; },
    list() { return [...bots.values()]; },
    snapshot() { return [...bots.values()].map(botStatus); },
});

// ── Wire platform sessions bridge ────────────────────────────────────────────
const sessionsBridge = require('./platform/sessions');
sessionsBridge.wireBridge();

// ── Express + HTTP ───────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Attach platform (public gateway only)
attachPlatform(app, server).then(async () => {
    // Restore persisted web sessions from registry file
    try {
        const active = await registry.listActive();
        const entries = active.map(r => ({
            id: r.botId,
            phone: r.phone,
            qrLogin: r.mode === 'qr',
            restoreOnly: true,
        }));
        if (entries.length) {
            console.log(`[ BOOT ] Restoring ${entries.length} persisted session(s) from registry...`);
            await sessionService.restorePersisted(entries);
        } else {
            console.log('[ BOOT ] No persisted sessions — waiting for web pairing at /');
        }
    } catch (e) {
        console.log('[ BOOT ] Restore failed:', e.message);
    }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n[ WEB LITE ] ✅ Running at http://0.0.0.0:${PORT}/`);
        console.log(`[ WEB LITE ] Bots: ${bots.size}/${MAX_BOTS} | Mode: fully web-based, no env sessions, no dev dashboard`);
        console.log(`[ WEB LITE ] RAM per bot ~15-25MB (file auth, no message store) → 100 bots ≈ 1.5-2.5GB`);
    });
}).catch(err => {
    console.error('[ BOOT ] Platform attach failed:', err);
    process.exit(1);
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/health/details', (_, res) => {
    res.json({
        ok: true,
        lite: true,
        bots: [...bots.values()].map(botStatus),
        maxBots: MAX_BOTS,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});
app.get('/status', (_, res) => {
    const list = [...bots.values()].map(b => `<li>${b.id} — ${b.state} — ${b.accountNumber || b.phone || 'no phone'}</li>`).join('');
    res.send(`<html><head><title>JTEST Lite</title></head><body style="font-family:monospace;background:#03060c;color:#e2f0ff;padding:2rem"><h1>JTEST WEB LITE</h1><p>${bots.size}/${MAX_BOTS} bots</p><ul>${list || '<li>no bots — pair at /</li>'}</ul><p><a href="/" style="color:#00ffe0">Go to pairing gateway /</a></p></body></html>`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
    console.log('\n[ SHUTDOWN ] Stopping...');
    try {
        for (const bot of bots.values()) {
            try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(); } catch (_) {}
        }
        const { shutdownPlatform } = require('./platform');
        await shutdownPlatform().catch(() => {});
    } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
