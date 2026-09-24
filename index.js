/**
 * JTEST WEB LITE — Fully web-based, no JUNE_SESSIONS, no JUNE_PLATFORM toggle, no dev dashboard.
 * Pairing logic taken from velvet-sparrow-sessions/routes/pair.js (your main session server)
 * - File auth, 100+ bots, no double code bug
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

// Pterodactyl / Courtney auto-detect
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

// ── Bot registry (lite) ────────────────────────────────────────────────────────
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
    try {
        const m = msg.message;
        if (!m) return;
        // Support conversation, extendedText, image caption, video caption
        const text = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
        if (!text) return;
        const lower = text.toLowerCase();
        const jid = msg.key.remoteJid;
        const isFromMe = !!msg.key.fromMe;
        // For lite, allow .ping from anyone including self (Message yourself) — old code blocked fromMe
        // Also log for debugging
        if (lower === '.ping' || lower === 'ping' || lower === '.alive' || lower.startsWith('.ping ')) {
            console.log(`[ ${bot.id} ] CMD ping from ${jid} fromMe=${isFromMe} text=${text.slice(0,30)}`);
            await sock.sendMessage(jid, { text: `🔸 pong! ${bot.id} • lite • ${new Date().toLocaleTimeString()} • uptime ${Math.floor(process.uptime())}s` });
        } else if (lower.startsWith('.') || lower.startsWith('!')) {
            // Minimal help for any other command in lite
            console.log(`[ ${bot.id} ] Unknown cmd ${text.slice(0,20)} from ${jid}`);
            if (lower === '.help' || lower === '.menu') {
                await sock.sendMessage(jid, { text: `JTEST WEB LITE — ${bot.id}
• .ping → pong
• .help → this
• Connected as ${bot.accountNumber}
• Mode: velvet-sparrow pairing
• RAM ~15-25MB per bot` });
            }
        }
    } catch (e) {
        console.log(`[ ${bot.id} ] handleMessage error: ${e.message}`);
    }
}

// ── Socket boot — velvet-sparrow style ───────────────────────────────────────
async function bootBot(botId, opts = {}) {
    const bot = bots.get(String(botId));
    if (!bot) throw new Error(`Unknown bot ${botId}`);
    if (bot.sock && bot.state === 'connected' && !opts.force) return bot;

    bot.state = 'connecting';
    bot.lastError = null;
    bot.reconnectCount = bot.reconnectCount || 0;
    bot.pairingDone = false;

    if (!bot.pairing) bot.pairing = { active: false, attempts: 0, exhausted: false, phone: bot.phone || '', lastCode: null, gen: 0, _requested: false };

    const { state, saveCreds } = await loadAuth(bot.id);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    // velvet-sparrow uses Browsers.macOS("Safari") — most trusted by WhatsApp
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
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

    // Attach ALL listeners FIRST — velvet-sparrow style (avoids missing close events)
    sock.ev.on('creds.update', saveCreds);

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
            // Startup message — like wdp welcome (lite version)
            try {
                const selfJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
                if (selfJid) {
                    await sock.sendMessage(selfJid, { text: `✅ JTEST WEB LITE Connected\n\n• Bot: ${bot.id}\n• Number: +${bot.accountNumber}\n• Mode: velvet-sparrow\n• RAM: ~15-25MB per bot\n• Uptime: ${Math.floor(process.uptime())}s\n\n• .ping → pong\n• .help → menu\n\nPaired via ${'apps.courtneytech.xyz:'+PORT}/` });
                    console.log(`[ ${bot.id} ] Startup message sent to ${selfJid}`);
                }
            } catch (e) {
                console.log(`[ ${bot.id} ] Startup message failed: ${e.message}`);
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.message || 'unknown';
            const reasonLower = String(reason).toLowerCase();
            const isConflict401 = statusCode === 401 && reasonLower.includes('conflict');

            // velvet-sparrow: don't reconnect if pairingDone or 401 or max reconnects
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
                if (bot.slotId) slots.markFailed(bot.slotId, reason);
                }
                return;
            }

            // WhatsApp sends 515 (restart required) after pairing code entry — must reconnect (velvet-sparrow logic)
            bot.reconnectCount++;
            console.log(`[ ${bot.id} ] Reconnect #${bot.reconnectCount} in 5s (status ${statusCode}) ${reason} — 515 restart expected after code entry`);
            bot.state = 'connecting';
            await delay(5000);
            bootBot(bot.id, { force: true }).catch(() => {});
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            // Lite: process ALL messages including fromMe (Message yourself) for .ping
            // Old code had if (msg.key.fromMe) continue which broke self-ping
            await handleMessage(bot, sock, msg);
        }
    });

    // Request pairing code AFTER listeners are attached — velvet-sparrow style
    // Only if not already registered
    if (!state.creds.registered) {
        if (bot.mode === 'code' && bot.phone) {
            if (bot.pairing._requested) {
                console.log(`[ ${bot.id} ] Pairing already requested, skipping`);
            } else if (bot.pairing.lastCode) {
                console.log(`[ ${bot.id} ] Code already exists ${bot.pairing.lastCode}, skipping auto — use Get another code button`);
            } else {
                bot.pairing._requested = true;
                bot.pairing.active = true;
                bot.pairing.gen += 1;
                await delay(2000); // brief wait for WS to establish (velvet-sparrow)
                const cleanPhone = String(bot.phone).replace(/\D/g, '');
                console.log(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
                try {
                    const rawCode = await sock.requestPairingCode(cleanPhone);
                    const formatted = rawCode?.length === 8 ? `${rawCode.slice(0,4)}-${rawCode.slice(4)}` : rawCode;
                    bot.pairing.lastCode = rawCode;
                    bot.pairing.attempts += 1;
                    if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
                    console.log(`[ ${bot.id} ] 🔑 Pairing code: ${rawCode} (formatted: ${formatted}) for ${cleanPhone}`);
                    platformBridge.emitPairingCode(bot, rawCode, { attempt: bot.pairing.attempts, gen: bot.pairing.gen, formatted });
                    try { slots.setCode(bot.id, rawCode, bot.pairing.attempts, 3); } catch (_) {}
                    if (bot.slotId) slots.updateCode(bot.slotId, rawCode);
                    // KEEP requested=true to prevent double — only explicit button resets it
                } catch (e) {
                    console.log(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
                    bot.lastError = e.message;
                    bot.pairing._requested = false;
                    try { slots.setFailed(bot.id, e.message); } catch (_) {}
                    if (bot.slotId) {
                        const s = slots.get(bot.slotId);
                        if (s) s.error = e.message;
                    }
                }
            }
        }
    } else {
        console.log(`[ ${bot.id} ] Creds already registered — awaiting open`);
    }

    return bot;
}

// ── SessionService adapter ───────────────────────────────────────────────────
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
        console.log(`[ BOTS ] ${bots.size}/${MAX_BOTS} active | Mode: velvet-sparrow pairing logic, no double codes`);
        console.log(`[ RAM ] ~15-25MB per bot (file auth, no store) → 100 bots ≈ 1.5-2.5GB`);
        console.log('='.repeat(60) + '\n');
    });
}).catch(err => { console.error('[ BOOT ] Platform attach failed:', err); process.exit(1); });

app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/health/details', (_, res) => {
    res.json({ ok: true, lite: true, pairing: 'velvet-sparrow', bots: [...bots.values()].map(botStatus), maxBots: MAX_BOTS, uptime: process.uptime(), memory: process.memoryUsage() });
});
app.get('/status', (_, res) => {
    const list = [...bots.values()].map(b => `<li>${b.id} — ${b.state} — ${b.accountNumber || b.phone || 'no phone'}</li>`).join('');
    res.send(`<html><head><title>JTEST Lite</title></head><body style="font-family:monospace;background:#03060c;color:#e2f0ff;padding:2rem"><h1>JTEST WEB LITE — velvet-sparrow pairing</h1><p>${bots.size}/${MAX_BOTS} bots</p><ul>${list || '<li>no bots — pair at /</li>'}</ul><p><a href="/" style="color:#00ffe0">Go to pairing gateway /</a></p></body></html>`);
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
