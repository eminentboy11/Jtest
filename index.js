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

// Pterodactyl / Courtney auto-detect: SERVER_PORT is primary allocation, fallback to PORT, then 3000
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // wdp uses Ubuntu Chrome — more trusted by WhatsApp
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        downloadHistory: false,
        connectTimeoutMs: 60000, // wdp: extra breathing room for VPS
        keepAliveIntervalMs: 20000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 3,
    });

    bot.sock = sock;
    bot.auth = { state, saveCreds };

    // Pairing code cycle
    if (!bot.pairing) bot.pairing = { active: false, attempts: 0, exhausted: false, phone: bot.phone || '', lastCode: null, gen: 0 };

    sock.ev.on('creds.update', saveCreds);

    // wdp-style: track if pairing code already requested for this connection (stored on bot to allow explicit retry)
    if (!bot.pairing._requested) bot.pairing._requested = false;

    const attemptPairingCode = async () => {
        if (bot.pairing._requested) {
            console.log(`[ ${bot.id} ] Pairing already requested, skipping duplicate`);
            return;
        }
        if (bot.pairing.lastCode) {
            console.log(`[ ${bot.id} ] Code already exists (${bot.pairing.lastCode}), skipping auto-request — use Get another code button for new code`);
            return;
        }
        if (!bot.phone || bot.mode !== 'code') return;
        if (bot.state === 'connected') return;
        if (bot.pairing.exhausted) {
            console.log(`[ ${bot.id} ] Pairing exhausted (3/3) — create new slot`);
            if (bot.slotId) slots.markFailed(bot.slotId, 'Pairing limit reached — create new slot');
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
            await new Promise(r => setTimeout(r, 3000));
            if (bot.state === 'connected') {
                console.log(`[ ${bot.id} ] Already connected, skipping pairing code`);
                return;
            }
            console.log(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
            const rawCode = await sock.requestPairingCode(cleanPhone);
            const formatted = rawCode?.length === 8 ? `${rawCode.slice(0,4)}-${rawCode.slice(4)}` : (rawCode?.match(/.{1,4}/g)?.join('-') || rawCode);
            bot.pairing.lastCode = rawCode;
            bot.pairing.attempts += 1;
            if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
            console.log(`[ ${bot.id} ] 🔑 Pairing code: ${rawCode} (formatted: ${formatted}) for ${cleanPhone} — enter as ${formatted} in WhatsApp > Linked Devices > Link with phone number instead`);
            console.log(`[ ${bot.id} ] ⚠️ Enter within 30s — code expires fast. If it says Couldn't link, use QR mode or remove a linked device (max 4)`);
            platformBridge.emitPairingCode(bot, rawCode, { attempt: bot.pairing.attempts, gen: bot.pairing.gen, formatted });
            if (bot.slotId) slots.updateCode(bot.slotId, rawCode);
            // KEEP bot.pairing._requested=true to prevent QR from triggering second code and invalidating first
            // It will be reset only on close or explicit retry button
        } catch (e) {
            console.log(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
            bot.lastError = e.message;
            bot.pairing._requested = false; // allow retry on failure
            if (bot.slotId) {
                const s = slots.get(bot.slotId);
                if (s) s.error = e.message;
            }
        }
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        platformBridge.emitConnUpdate(bot, update, sock);

        // wdp-style: when QR arrives and phone is set, intercept and request pairing code — ONCE only
        if (qr) {
            try {
                const dataUrl = await qrcode.toDataURL(qr);
                slots.updateQr(bot.slotId, dataUrl);
            } catch (_) {}
            // If code mode, request pairing code on QR (like wdp does) — only if no code yet
            if (bot.mode === 'code' && bot.phone && !bot.pairing._requested && !bot.pairing.lastCode) {
                await attemptPairingCode();
            }
        }

        if (connection === 'open') {
            bot.state = 'connected';
            bot.connectedAt = Date.now();
            bot.accountNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || bot.accountNumber || null;
            bot.lastError = null;
            bot.pairing.active = false;
            bot.pairing.exhausted = false;
            bot.pairing._requested = false;
            console.log(`[ ${bot.id} ] ✅ Connected as ${bot.accountNumber || sock.user?.id}`);
            await registry.markPaired(bot.id, bot.accountNumber).catch(() => {});
            if (bot.slotId) {
                const s = slots.get(bot.slotId);
                if (s) slots.markPaired(s.slotId, bot.accountNumber);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';
            const reasonLower = String(reason).toLowerCase();
            const isPairingPhase = bot.mode === 'code' && bot.state !== 'connected' && (bot.pairing?.active || !bot.connectedAt);
            const isConflict401 = statusCode === 401 && reasonLower.includes('conflict');
            console.log(`[ ${bot.id} ] ❌ Closed (${statusCode}) ${reason} | pairingPhase=${isPairingPhase} conflict=${isConflict401}`);

            if (statusCode === DisconnectReason.loggedOut && !isConflict401) {
                bot.state = 'needs-login';
                bot.lastError = 'Logged out — pair again via web at /';
                if (bot.slotId) slots.markFailed(bot.slotId, 'logged-out');
            } else if (isConflict401) {
                // 401 conflict is recoverable, don't clear session (wdp-style)
                console.log(`[ ${bot.id} ] ⚠️ 401 conflict — recoverable, retrying in 3s`);
                bot.state = 'connecting';
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 3000);
            } else if (statusCode === 401 && isPairingPhase) {
                bot.state = 'waiting';
                bot.lastError = `Pairing 401: ${reason} — request new code`;
                console.log(`[ ${bot.id} ] ⚠️ 401 during pairing — keeping slot alive, request new code via UI`);
                bot.pairing._requested = false;
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 5000);
            } else if (statusCode === 503 && isPairingPhase) {
                bot.state = 'connecting';
                bot.lastError = `Stream 503: ${reason} — retrying...`;
                console.log(`[ ${bot.id} ] ⚠️ 503 during pairing — retrying in 3s`);
                bot.pairing._requested = false;
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 3000);
            } else if (statusCode === 408) {
                // QR refs attempts ended — wdp-style, this happens when QR expires without pairing
                console.log(`[ ${bot.id} ] ⚠️ 408 QR refs ended — will re-request pairing on next QR`);
                bot.state = 'connecting';
                bot.pairing._requested = false;
                setTimeout(() => bootBot(bot.id, { force: true }).catch(() => {}), 2000);
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
        const attemptPairing = async (retries = 0) => {
            try {
                if (!bot.sock || bot.state === 'connected') return;
                if (bot.pairing.exhausted) {
                    console.log(`[ ${bot.id} ] Pairing exhausted (3 attempts)`);
                    if (bot.slotId) slots.markFailed(bot.slotId, 'Pairing limit reached — create new slot');
                    return;
                }
                if (!bot.pairing.active) {
                    bot.pairing.active = true;
                    bot.pairing.gen += 1;
                    bot.pairing.attempts = 0;
                }
                // Ensure socket is still open
                if (bot.sock?.ws?.readyState !== 1 && bot.sock?.ws?.readyState !== undefined) {
                    console.log(`[ ${bot.id} ] Socket not ready for pairing, retrying...`);
                    if (retries < 3) setTimeout(() => attemptPairing(retries+1), 2000);
                    return;
                }
                const gen = bot.pairing.gen;
                // Clean phone: ensure no + and no leading 0 after country code already present
                const cleanPhone = String(bot.phone).replace(/\D/g, '');
                console.log(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
                const code = await sock.requestPairingCode(cleanPhone);
                if (bot.pairing.gen !== gen) {
                    console.log(`[ ${bot.id} ] Stale pairing gen, ignoring code`);
                    return;
                }
                const formatted = code.length === 8 ? `${code.slice(0,4)}-${code.slice(4)}` : code;
                bot.pairing.lastCode = code;
                bot.pairing.attempts += 1;
                if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
                console.log(`[ ${bot.id} ] 🔑 Pairing code: ${code} (formatted: ${formatted}) for ${cleanPhone} — enter as ${formatted} in WhatsApp: Linked Devices > Link with phone number`);
                console.log(`[ ${bot.id} ] If code says Couldn't link, your VPS IP is flagged by WhatsApp — use QR mode instead at /`);
                platformBridge.emitPairingCode(bot, formatted, { attempt: bot.pairing.attempts, gen, raw: code });
                if (bot.slotId) slots.updateCode(bot.slotId, formatted);
            } catch (e) {
                console.log(`[ ${bot.id} ] Pairing code failed: ${e.message} | stack: ${e.stack?.slice(0,200)}`);
                bot.lastError = e.message;
                // Don't fail slot on first failure, allow retry
                if (retries < 2) {
                    console.log(`[ ${bot.id} ] Retrying pairing code in 3s...`);
                    setTimeout(() => attemptPairing(retries+1), 3000);
                } else {
                    if (bot.slotId) {
                        const s = slots.get(bot.slotId);
                        if (s && s.status === 'waiting') {
                            // keep waiting, don't mark failed yet unless exhausted
                            s.error = e.message;
                        }
                    }
                }
            }
        };
        // Wait longer for socket to stabilize (Baileys needs ~2-3s)
        setTimeout(() => attemptPairing(0), 3500);
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
        console.log(`[ BOTS ] ${bots.size}/${MAX_BOTS} active | Mode: fully web-based, no env sessions, no dev dashboard`);
        console.log(`[ RAM ] ~15-25MB per bot (file auth, no store) → 100 bots ≈ 1.5-2.5GB`);
        console.log('='.repeat(60) + '\n');
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
