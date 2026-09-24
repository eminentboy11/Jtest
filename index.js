/**
 * JTEST WEB LITE — Fully web-based, no JUNE_SESSIONS, no JUNE_PLATFORM toggle, no dev dashboard.
 * Pairing logic from velvet-sparrow-sessions/routes/pair.js
 * Mini handler: local commands/ + remote URL commands (data/remote-commands.json or REMOTE_COMMANDS_URL)
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const platformBridge = require('./platform/bridge');
const { attachPlatform } = require('./platform');
const registry = require('./platform/registry');
const sessionService = require('./platform/sessionService');
const slots = require('./platform/slots');
const handlerLite = require('./utils/handlerLite');

const RAW_PORT = process.env.SERVER_PORT || process.env.PTERODACTYL_PORT || process.env.PORT || '3000';
const PORT = Number(RAW_PORT) || 3000;
const DETECTED_ENV = {
    SERVER_PORT: process.env.SERVER_PORT || null,
    PTERODACTYL_PORT: process.env.PTERODACTYL_PORT || null,
    PORT: process.env.PORT || null,
    RAW: RAW_PORT,
    FINAL: PORT,
};
const MAX_BOTS = Math.max(1, Math.floor(Number(process.env.PLATFORM_MAX_BOTS || 100)));
const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_ROOT = path.join(process.cwd(), 'auth');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

const logger = pino({ level: 'fatal' }).child({ level: 'fatal' });

const bots = new Map();

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

function getAuthDir(botId) { return path.join(AUTH_ROOT, String(botId)); }
async function loadAuth(botId) {
    const dir = getAuthDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    return useMultiFileAuthState(dir);
}

async function handleMessage(bot, sock, msg) {
    return handlerLite.handleMessage(sock, msg, { bot });
}

async function bootBot(botId, opts = {}) {
    const bot = bots.get(String(botId));
    if (!bot) throw new Error(`Unknown bot ${botId}`);
    if (bot.sock && bot.state === 'connected' && !opts.force) return bot;

    bot.state = 'connecting';
    bot.lastError = null;
    bot.reconnectCount = bot.reconnectCount || 0;
    bot.pairingDone = false;

    if (!bot.pairing) bot.pairing = { active: false, attempts: 0, exhausted: false, phone: bot.phone || '', lastCode: null, gen: 0, _requested: false };
    if (!bot.pairing._requested) bot.pairing._requested = false;

    const { state, saveCreds } = await loadAuth(bot.id);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
        getMessage: async () => undefined,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    bot.sock = sock;
    bot.auth = { state, saveCreds };

    sock.ev.on('creds.update', saveCreds);

    const attemptPairingCode = async () => {
        if (bot.pairing._requested) {
            console.log(`[ ${bot.id} ] Pairing already requested, skipping duplicate`);
            return;
        }
        if (bot.pairing.lastCode) {
            console.log(`[ ${bot.id} ] Code already exists (${bot.pairing.lastCode}), skipping auto — use Get another code button`);
            return;
        }
        if (!bot.phone || bot.mode !== 'code') return;
        if (bot.state === 'connected') return;
        if (bot.pairing.exhausted) {
            console.log(`[ ${bot.id} ] Pairing exhausted (3/3) — create new slot`);
            if (bot.slotId) try { slots.setFailed(bot.id, 'Pairing limit reached — create new slot'); } catch (_) {}
            return;
        }
        bot.pairing._requested = true;
        try {
            if (!bot.pairing.active) {
                bot.pairing.active = true;
                bot.pairing.gen += 1;
            }
            const cleanPhone = String(bot.phone).replace(/\D/g, '');
            console.log(`[ ${bot.id} ] Waiting 3s for socket to stabilize before pairing...`);
            await delay(3000);
            if (bot.state === 'connected') {
                console.log(`[ ${bot.id} ] Already connected, skipping pairing code`);
                return;
            }
            console.log(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
            const rawCode = await sock.requestPairingCode(cleanPhone);
            const formatted = rawCode?.length === 8 ? `${rawCode.slice(0,4)}-${rawCode.slice(4)}` : rawCode;
            bot.pairing.lastCode = rawCode;
            bot.pairing.attempts += 1;
            if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
            console.log(`[ ${bot.id} ] 🔑 Pairing code: ${rawCode} (formatted: ${formatted}) for ${cleanPhone}`);
            platformBridge.emitPairingCode(bot, rawCode, { attempt: bot.pairing.attempts, gen: bot.pairing.gen, formatted });
            try { slots.setCode(bot.id, rawCode, bot.pairing.attempts, 3); } catch (_) {}
            bot._lastQrDataUrl = null;
        } catch (e) {
            console.log(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
            bot.lastError = e.message;
            bot.pairing._requested = false;
            if (bot.slotId) try { slots.setFailed(bot.id, e.message); } catch (_) {}
        }
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[ ${bot.id} ] event: ${Object.keys(update).join(',')} conn=${connection} status=${statusCode}`);

        platformBridge.emitConnUpdate(bot, update, sock);

        if (qr) {
            try {
                const dataUrl = await qrcode.toDataURL(qr);
                bot._lastQrDataUrl = dataUrl;
                slots.setQR(bot.id, dataUrl);
            } catch (_) {}
            if (bot.mode === 'code' && bot.phone && !bot.pairing._requested && !bot.pairing.lastCode) {
                await attemptPairingCode();
            }
        }

        if (connection === 'open') {
            bot.pairingDone = true;
            bot.state = 'connected';
            bot.connectedAt = Date.now();
            bot.accountNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || bot.accountNumber || null;
            bot.lastError = null;
            bot.pairing.active = false;
            bot.pairing.exhausted = false;
            bot.pairing._requested = false;
            console.log(`[ ${bot.id} ] ✅ Connected as ${bot.accountNumber || sock.user?.id}`);
            await registry.markPaired(bot.id, bot.accountNumber).catch(() => {});
            try { slots.setPaired(bot.id, bot.accountNumber); } catch (_) {}
            if (bot.slotId) {
                const s = slots.get(bot.slotId);
                if (s) slots.markPaired(s.slotId, bot.accountNumber);
            }
            try {
                const selfJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
                if (selfJid) {
                    await sock.sendMessage(selfJid, { text: `✅ JTEST WEB LITE Connected\n\n• Bot: ${bot.id}\n• Number: +${bot.accountNumber}\n• Mode: velvet-sparrow\n• Commands: ${handlerLite.getUniqueCommands().size} loaded (local + URL)\n• .ping → pong\n• .help → menu\n\nPaired via :${PORT}/` });
                }
            } catch (e) {
                console.log(`[ ${bot.id} ] Startup message failed: ${e.message}`);
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.message || 'unknown';
            const reasonLower = String(reason).toLowerCase();
            const isConflict401 = statusCode === 401 && reasonLower.includes('conflict');

            if (bot.pairingDone || statusCode === 401 || bot.reconnectCount >= 10) {
                if (statusCode === 401 && !bot.pairingDone) {
                    console.log(`[ ${bot.id} ] 401 not reconnecting (will allow new code via UI)`);
                    bot.state = 'waiting';
                    bot.lastError = `401: ${reason} — request new code`;
                    bot.pairing._requested = false;
                } else if (!bot.pairingDone) {
                    console.log(`[ ${bot.id} ] Closed (${statusCode}) ${reason} — not reconnecting (done=${bot.pairingDone})`);
                    bot.state = 'waiting';
                    bot.lastError = `${reason} — create new slot`;
                    try { slots.setFailed(bot.id, reason); } catch (_) {}
                    if (bot.slotId) try { slots.markFailed(bot.slotId, reason); } catch (_) {}
                }
                return;
            }

            bot.reconnectCount++;
            console.log(`[ ${bot.id} ] Reconnect #${bot.reconnectCount} in 5s (status ${statusCode}) ${reason} — 515 restart expected after code entry`);
            bot.state = 'connecting';
            await delay(5000);
            bootBot(bot.id, { force: true }).catch(() => {});
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            await handleMessage(bot, sock, msg);
        }
    });

    if (bot.mode === 'code' && bot.phone) {
        setTimeout(() => {
            if (bot.state !== 'connected' && !bot.pairing._requested && !bot.pairing.lastCode) {
                console.log(`[ ${bot.id} ] QR not received, fallback requesting pairing code...`);
                attemptPairingCode();
            }
        }, 6000);
    }

    return bot;
}

sessionService.configure({
    async provision(entry, { source, mode }) {
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
            reconnectCount: 0,
            pairingDone: false,
            pairing: { active: false, attempts: 0, exhausted: false, phone: phone || '', lastCode: null, gen: 0, _requested: false },
        };
        bots.set(id, bot);
        try {
            await bootBot(id);
            return { ok: true, id, phone, mode: bot.mode };
        } catch (e) {
            bots.delete(id);
            return { ok: false, reason: e.message, id };
        }
    },
    async restorePersisted(entries) {
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
                reconnectCount: 0,
                pairingDone: false,
                pairing: { active: false, attempts: 0, exhausted: false, phone: (e.phone || '').replace(/\D/g, ''), lastCode: null, gen: 0, _requested: false },
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
        try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(new Error(reason || 'removed')); } catch (_) {}
        bots.delete(id);
        try { fs.rmSync(getAuthDir(id), { recursive: true, force: true }); } catch (_) {}
        console.log(`[ ${id} ] 🗑️ Removed (${reason})`);
        return { ok: true, id };
    },
    async stop(botId) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(new Error('stopped')); } catch (_) {}
        bot.state = 'stopped';
        bot.sock = null;
        return { ok: true, id };
    },
    async reconnect(botId) {
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

const sessionsBridge = require('./platform/sessions');
sessionsBridge.wireBridge();

let handlerReady = false;
handlerLite.init().then(() => {
    handlerReady = true;
    console.log('[ HANDLER ] Mini handler ready — local + URL commands');
}).catch(e => console.log('[ HANDLER ] Init failed:', e.message));

const app = express();
const server = http.createServer(app);

attachPlatform(app, server).then(async () => {
    try {
        const active = await registry.listActive();
        const entries = active.map(r => ({ id: r.botId, phone: r.phone, qrLogin: r.mode === 'qr', restoreOnly: true }));
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
        console.log('\n' + '='.repeat(60));
        console.log('[ WEB LITE ] ✅ Server started — Pterodactyl/Courtney compatible');
        console.log('='.repeat(60));
        console.log(`[ ENV ] SERVER_PORT=${DETECTED_ENV.SERVER_PORT} | PTERODACTYL_PORT=${DETECTED_ENV.PTERODACTYL_PORT} | PORT=${DETECTED_ENV.PORT} | RAW=${DETECTED_ENV.RAW} → FINAL=${DETECTED_ENV.FINAL}`);
        console.log(`[ LISTEN ] 0.0.0.0:${PORT}  (bound to 0.0.0.0)`);
        console.log(`[ GATEWAY ] Pairing UI → /  (at :${PORT}/)`);
        console.log(`[ HEALTH ] Health check → :${PORT}/health`);
        console.log(`[ HEALTH ] Details → :${PORT}/health/details`);
        console.log(`[ STATUS ] Simple status → :${PORT}/status`);
        console.log(`[ COURTNEY ] Pterodactyl detected — open your allocation IP:PORT from Network tab`);
        console.log(`[ COURTNEY ] Your public URL is apps.courtneytech.xyz:${PORT} — try / and /status`);
        console.log(`[ BOTS ] ${bots.size}/${MAX_BOTS} active | Mini handler: local + URL commands`);
        console.log(`[ RAM ] ~15-25MB per bot (file auth, no store) → 100 bots ≈ 1.5-2.5GB`);
        console.log('='.repeat(60) + '\n');
    });
}).catch(err => { console.error('[ BOOT ] Platform attach failed:', err); process.exit(1); });

app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/health/details', (_, res) => {
    res.json({ ok: true, lite: true, pairing: 'velvet-sparrow', handler: handlerReady ? 'ready' : 'loading', commands: [...handlerLite.getUniqueCommands().keys()], bots: [...bots.values()].map(botStatus), maxBots: MAX_BOTS, uptime: process.uptime(), memory: process.memoryUsage() });
});
app.get('/status', (_, res) => {
    const list = [...bots.values()].map(b => `<li>${b.id} — ${b.state} — ${b.accountNumber || b.phone || 'no phone'}</li>`).join('');
    const cmds = [...handlerLite.getUniqueCommands().keys()].join(', ') || 'loading...';
    res.send(`<html><head><title>JTEST Lite</title></head><body style="font-family:monospace;background:#03060c;color:#e2f0ff;padding:2rem"><h1>JTEST WEB LITE — velvet-sparrow + mini handler</h1><p>${bots.size}/${MAX_BOTS} bots | Commands: ${cmds}</p><ul>${list || '<li>no bots — pair at /</li>'}</ul><p><a href="/" style="color:#00ffe0">Go to pairing gateway /</a></p></body></html>`);
});

async function shutdown() {
    console.log('\n[ SHUTDOWN ] Stopping...');
    try {
        for (const bot of bots.values()) { try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(); } catch (_) {} }
        const { shutdownPlatform } = require('./platform');
        await shutdownPlatform().catch(() => {});
    } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
