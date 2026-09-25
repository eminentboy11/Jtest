/**
 * June X Web Edition — WDP full bot + Web Pairing Gateway
 * Uses WDP's full handler, database, commands, but with web UI for pairing
 * Fixes restart persistence (immediate registry save + auth scan)
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pino = require('pino');

// WDP core
const database = require('./database');
const { loadCommands } = require('./utils/commandLoader');

// Platform (from lite) — web gateway
const platformBridge = require('./platform/bridge');
const { attachPlatform } = require('./platform');
const registry = require('./platform/registry');
const sessionService = require('./platform/sessionService');
const slots = require('./platform/slots');

const RAW_PORT = process.env.SERVER_PORT || process.env.PTERODACTYL_PORT || process.env.PORT || '3000';
const PORT = Number(RAW_PORT) || 3000;
const MAX_BOTS = 1; // Web edition single bot for now (wdp single-bot core), but platform supports 100

const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_ROOT = path.join(process.cwd(), 'auth');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

const logger = pino({ level: 'fatal' }).child({ level: 'fatal' });

// For web edition, we reuse lite's bot management but with wdp's full handler
const bots = new Map();

function botStatus(bot) {
    return {
        id: bot.id,
        state: bot.state,
        connected: bot.state === 'connected',
        phone: bot.phone || null,
        account: bot.accountNumber || null,
        connectedAt: bot.connectedAt || null,
    };
}

// WDP handler — load once
let wdpHandler = null;
let wdpCommands = null;
function getWdpHandler() {
    if (!wdpHandler) {
        try {
            wdpHandler = require('./handler');
            wdpCommands = loadCommands();
            console.log(`[ WDP ] Handler loaded — ${wdpCommands.size} commands`);
        } catch (e) {
            console.log('[ WDP ] Handler load failed:', e.message);
        }
    }
    return { handler: wdpHandler, commands: wdpCommands };
}

async function handleMessage(bot, sock, msg) {
    // Use WDP's full handler
    const { handler } = getWdpHandler();
    if (!handler) return;
    try {
        // WDP handler expects global sock etc., set per bot
        global.currentSock = sock;
        global.botState = bot.state;
        await handler(sock, msg);
    } catch (e) {
        console.log(`[ WDP ] handleMessage error: ${e.message}`);
    }
}

// Lite-style bootBot but with WDP database and handler
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

    const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, delay, default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
    const qrcode = require('qrcode');

    const authDir = path.join(AUTH_ROOT, String(bot.id));
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async () => undefined,
    });

    bot.sock = sock;
    bot.auth = { state, saveCreds };
    sock.ev.on('creds.update', saveCreds);

    const attemptPairingCode = async () => {
        if (bot.pairing._requested) return;
        if (bot.pairing.lastCode) return;
        if (!bot.phone || bot.mode !== 'code') return;
        if (bot.state === 'connected') return;
        bot.pairing._requested = true;
        try {
            if (!bot.pairing.active) { bot.pairing.active = true; bot.pairing.gen += 1; }
            const cleanPhone = String(bot.phone).replace(/\D/g, '');
            console.log(`[ ${bot.id} ] Waiting 3s for socket to stabilize...`);
            await delay(3000);
            if (bot.state === 'connected') return;
            console.log(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
            const rawCode = await sock.requestPairingCode(cleanPhone);
            const formatted = rawCode?.length === 8 ? `${rawCode.slice(0,4)}-${rawCode.slice(4)}` : rawCode;
            bot.pairing.lastCode = rawCode;
            bot.pairing.attempts += 1;
            if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
            console.log(`[ ${bot.id} ] 🔑 Pairing code: ${rawCode} (${formatted}) for ${cleanPhone}`);
            platformBridge.emitPairingCode(bot, rawCode, { attempt: bot.pairing.attempts, gen: bot.pairing.gen, formatted });
            try { slots.setCode(bot.id, rawCode, bot.pairing.attempts, 3); } catch (_) {}
        } catch (e) {
            console.log(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
            bot.lastError = e.message;
            bot.pairing._requested = false;
        }
    };

    sock.ev.on('connection.update', async (update) => {
        try {
            const { connection, lastDisconnect, qr } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[ ${bot.id} ] event: ${Object.keys(update).join(',')} conn=${connection} status=${statusCode}`);
            platformBridge.emitConnUpdate(bot, update, sock);

            if (qr) {
                try { const dataUrl = await qrcode.toDataURL(qr); bot._lastQrDataUrl = dataUrl; slots.setQR(bot.id, dataUrl); } catch (_) {}
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
                bot.reconnectCount = 0;
                console.log(`[ ${bot.id} ] ✅ Connected as ${bot.accountNumber || sock.user?.id}`);
                await registry.markPaired(bot.id, bot.accountNumber).catch(() => {});
                try { slots.setPaired(bot.id, bot.accountNumber); } catch (_) {}
                // WDP database ready
                await database.ready.catch(()=>{});
                // Send startup message via WDP style
                try {
                    const selfJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
                    if (selfJid) {
                        await sock.sendMessage(selfJid, { text: `✅ JUNE X WEB EDITION Connected\n\n• Bot: ${bot.id}\n• Number: +${bot.accountNumber}\n• Mode: velvet-sparrow + wdp\n• Commands: ${wdpCommands ? wdpCommands.size : 'loading...'} (full wdp)\n• .ping → pong\n• .help → menu\n\nPaired via :${PORT}/` });
                    }
                } catch (e) { console.log(`[ ${bot.id} ] Startup msg failed: ${e.message}`); }
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.message || 'unknown';
                console.log(`[ ${bot.id} ] Close: status=${statusCode} reason=${reason} pairingDone=${bot.pairingDone}`);

                if (statusCode === 401) {
                    console.log(`[ ${bot.id} ] 401 session invalid — allow new code via UI`);
                    bot.state = 'waiting';
                    bot.lastError = `401: ${reason}`;
                    bot.pairing._requested = false;
                    bot.pairingDone = false;
                    bot.reconnectCount = 0;
                    return;
                }
                if (bot.reconnectCount >= 10) {
                    console.log(`[ ${bot.id} ] Max reconnects 10 — stopping`);
                    bot.state = 'waiting';
                    bot.lastError = reason;
                    try { slots.setFailed(bot.id, reason); } catch (_) {}
                    return;
                }
                bot.reconnectCount++;
                console.log(`[ ${bot.id} ] Reconnect #${bot.reconnectCount} in 5s (status ${statusCode}) ${reason}`);
                bot.state = 'connecting';
                await delay(5000);
                bootBot(bot.id, { force: true }).catch(e => console.log(`[ ${bot.id} ] Reconnect failed: ${e.message}`));
            }
        } catch (e) { console.log(`[ ${bot.id} ] conn.update error: ${e.message}`); }
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

// Session service
sessionService.configure({
    async provision(entry, { source, mode }) {
        const isQr = mode === 'qr' || entry.qrLogin;
        const id = entry.id || `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
        const phone = (entry.phone || '').replace(/\D/g, '') || null;
        if (bots.has(id)) return { ok: false, reason: 'duplicate-id', id };
        if (bots.size >= MAX_BOTS) return { ok: false, reason: 'quota', id };
        const bot = {
            id, phone, mode: isQr ? 'qr' : 'code', state: 'connecting', sock: null,
            accountNumber: null, lastError: null, connectedAt: null, slotId: null,
            reconnectCount: 0, pairingDone: false,
            pairing: { active: false, attempts: 0, exhausted: false, phone: phone || '', lastCode: null, gen: 0, _requested: false },
        };
        bots.set(id, bot);
        try { await bootBot(id); return { ok: true, id, phone, mode: bot.mode }; }
        catch (e) { bots.delete(id); return { ok: false, reason: e.message, id }; }
    },
    async restorePersisted(entries) {
        const restored = [];
        for (const e of entries) {
            const id = String(e.id);
            if (bots.has(id)) continue;
            if (bots.size >= MAX_BOTS) break;
            const bot = {
                id, phone: (e.phone || '').replace(/\D/g, '') || null,
                mode: e.qrLogin ? 'qr' : 'code', state: 'connecting', sock: null,
                accountNumber: null, lastError: null, connectedAt: null, slotId: null,
                reconnectCount: 0, pairingDone: false,
                pairing: { active: false, attempts: 0, exhausted: false, phone: (e.phone || '').replace(/\D/g, ''), lastCode: null, gen: 0, _requested: false },
            };
            bots.set(id, bot);
            bootBot(id).catch(e => console.log(`[ RESTORE ] ${id} boot failed: ${e.message}`));
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
        try { fs.rmSync(path.join(AUTH_ROOT, id), { recursive: true, force: true }); } catch (_) {}
        console.log(`[ ${id} ] 🗑️ Removed (${reason})`);
        return { ok: true, id };
    },
    async stop(botId) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(new Error('stopped')); } catch (_) {}
        bot.state = 'stopped'; bot.sock = null;
        return { ok: true, id };
    },
    async reconnect(botId) {
        const id = String(botId);
        const bot = bots.get(id);
        if (!bot) return { ok: false, reason: 'unknown', id };
        try { await bootBot(id, { force: true }); return { ok: true, id, connected: bot.state === 'connected' }; }
        catch (e) { return { ok: false, reason: e.message, id }; }
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

(async () => {
    await database.ready.catch(e => console.log('[ DB ] Ready failed:', e.message));
    getWdpHandler(); // preload commands
})();

attachPlatform(app, server).then(async () => {
    try {
        let active = [];
        try { active = await registry.listActive(); } catch {}
        let entries = active.map(r => ({ id: r.botId, phone: r.phone, qrLogin: r.mode === 'qr', restoreOnly: true }));
        if (entries.length === 0) {
            try {
                if (fs.existsSync(AUTH_ROOT)) {
                    const dirs = fs.readdirSync(AUTH_ROOT).filter(n => {
                        try { return fs.statSync(path.join(AUTH_ROOT, n)).isDirectory(); } catch { return false; }
                    });
                    if (dirs.length) {
                        console.log(`[ BOOT ] Registry empty but found ${dirs.length} auth folder(s) — restoring from auth scan (wdp-style)`);
                        for (const dir of dirs) {
                            entries.push({ id: dir, phone: null, qrLogin: false, restoreOnly: true });
                            try { await registry.trackSession(dir, { phone: null, mode: 'code' }); } catch {}
                        }
                    }
                }
            } catch (e) { console.log('[ BOOT ] Auth scan failed:', e.message); }
        }
        if (entries.length) {
            console.log(`[ BOOT ] Restoring ${entries.length} persisted session(s) from ${active.length?'registry':'auth scan'}...`);
            const res = await sessionService.restorePersisted(entries);
            console.log(`[ BOOT ] Restore result: ${JSON.stringify(res)} — bots now ${bots.size}`);
        } else {
            console.log('[ BOOT ] No persisted sessions — waiting for web pairing at /');
        }
    } catch (e) {
        console.log('[ BOOT ] Restore failed:', e.message);
    }
    server.listen(PORT, '0.0.0.0', () => {
        console.log('\n' + '='.repeat(60));
        console.log('[ JUNE X WEB ] ✅ Server started — WDP full + Web Gateway');
        console.log('='.repeat(60));
        console.log(`[ LISTEN ] 0.0.0.0:${PORT}`);
        console.log(`[ GATEWAY ] Pairing UI → /  (at :${PORT}/)`);
        console.log(`[ HEALTH ] :${PORT}/health | :${PORT}/health/details | :${PORT}/status`);
        console.log(`[ BOTS ] ${bots.size}/${MAX_BOTS} active | WDP: ${wdpCommands ? wdpCommands.size : 'loading...'} commands`);
        console.log(`[ DB ] SQLite ready — ${database._db ? 'yes' : 'no'} | Dir: ${process.env.JUNE_DB_DIR || 'database'}`);
        console.log('='.repeat(60) + '\n');
    });
}).catch(err => { console.error('[ BOOT ] Platform attach failed:', err); process.exit(1); });

app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/health/details', (_, res) => {
    res.json({ ok: true, web: true, wdp: true, bots: [...bots.values()].map(botStatus), maxBots: MAX_BOTS, commands: wdpCommands ? wdpCommands.size : 0, uptime: process.uptime(), memory: process.memoryUsage() });
});
app.get('/status', (_, res) => {
    const list = [...bots.values()].map(b => `<li>${b.id} — ${b.state} — ${b.accountNumber || b.phone || 'no phone'}</li>`).join('');
    res.send(`<html><head><title>June X Web</title></head><body style="font-family:monospace;background:#03060c;color:#e2f0ff;padding:2rem"><h1>June X WEB EDITION — WDP full + velvet-sparrow</h1><p>${bots.size}/${MAX_BOTS} bots | WDP commands: ${wdpCommands ? wdpCommands.size : 'loading...'}</p><ul>${list || '<li>no bots — pair at /</li>'}</ul><p><a href="/" style="color:#00ffe0">Go to pairing gateway /</a></p></body></html>`);
});

async function shutdown() {
    console.log('\n[ SHUTDOWN ] Stopping...');
    try {
        for (const bot of bots.values()) { try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(); } catch (_) {} }
        const { shutdownPlatform } = require('./platform');
        await shutdownPlatform().catch(() => {});
        await registry.close?.().catch(()=>{});
    } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
