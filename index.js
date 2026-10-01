/**
 * June X Web Edition — WDP full bot + Web Pairing Gateway
 * Uses WDP's full handler, database, commands, but with web UI for pairing
 * Fixes restart persistence (immediate registry save + auth scan)
 */
'use strict';
require('dotenv').config();
// libsignal (bundled with Baileys) logs session churn straight to console.*,
// bypassing the pino logger, and the SessionEntry dumps flood hosted consoles.
// Must run before any socket is created; JUNE_LIBSIGNAL_LOG=1 disables it.
require('./utils/silenceLibsignal').install();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pino = require('pino');
const chalk = require('chalk');

// WDP core
const database = require('./database');
const { applyFont } = require('./utils/fontConverter')
const detectPlatform = require('./utils/platform');
const { buildStartupCard, resolveStartupFields } = require('./utils/startupCard');
// Platform (from lite) — web gateway
const platformBridge = require('./platform/bridge');
const { attachPlatform } = require('./platform');
const registry = require('./platform/registry');
const sessionService = require('./platform/sessionService');
const slots = require('./platform/slots');
const { purgeBot } = require('./platform/purge');
const coldArchive = require('./utils/coldArchive');
const uptime = require('./utils/uptime');

const RAW_PORT = process.env.SERVER_PORT || process.env.PTERODACTYL_PORT || process.env.PORT || '3000';
const PORT = Number(RAW_PORT) || 3000;
const MAX_BOTS = 100; // Web edition multi-session — WDP full per bot, 100+ bots capable

global.__CORE__ = __dirname;
global.__ROOT__ = __dirname;

const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_ROOT = path.join(process.cwd(), 'auth');

// DEBUG=true in env unlocks the per-bot lifecycle chatter (event dumps,
// close reasons, pairing attempts, purge traces). Without it the console
// keeps only the lines you act on: connected, pairing code delivered,
// reconnects, failures, boot summary.
const DEBUG_LOG = ['true', '1', 'yes', 'on'].includes(String(process.env.DEBUG || '').trim().toLowerCase());
const debugLog = (...args) => { if (DEBUG_LOG) console.log(...args); };
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

const logger = pino({ level: 'fatal' }).child({ level: 'fatal' });

// One platform answer per process, shared by the startup card and the menu.
global.platform = detectPlatform();

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

// WDP handler — per-bot DB + shared commands (multi-session)
// handler.js owns the single command Map and loads it exactly once. Asking the
// loader for a second copy here would double the dispatch table and start a
// second file watcher, so counts are read back from the handler instead.
let globalHandler = null;
const commandCount = () => globalHandler?.getCommandCount?.() ?? 0;
const aliasCount = () => globalHandler?.getAliasCount?.() ?? 0;

function getWdpHandler() {
    if (!globalHandler) {
        try {
            globalHandler = require('./handler');
            debugLog(`[ WDP ] Handler loaded — ${commandCount()} commands + ${aliasCount()} aliases (shared across ${MAX_BOTS} bots)`);
        } catch (e) {
            console.log('[ WDP ] Handler load failed:', e.message, e.stack?.slice(0,300));
        }
    }
    return { handler: globalHandler };
}

// Per-bot data lives in a single JSON file: data/bots/<botId>.json
//
// database.js resolves which bot a call belongs to through AsyncLocalStorage,
// so there is nothing to install here and no module cache to mutate. Wrapping
// the dispatch in database.runAsBot(bot.id, ...) is enough — the binding follows
// the whole async chain, which is what makes two bots handling messages at the
// same moment stay isolated.

async function handleMessage(bot, sock, msg) {
    const { handler } = getWdpHandler();
    if (!handler) {
        console.log(`[ WDP ] No handler for ${bot.id}`);
        return;
    }
    // WDP handler exports { handleMessage, ... } not a function
    const fn = handler.handleMessage || handler;
    if (typeof fn !== 'function') {
        console.log(`[ WDP ] handler type ${typeof handler} keys ${Object.keys(handler).slice(0,5)}`);
        return;
    }
    try {
        coldArchive.touch(bot.id);
        await database.runAsBot(bot.id, async () => {
            global.currentSock = sock;
            global.botState = bot.state;
            global.__BOT_ID__ = bot.id;
            await fn(sock, msg);
        });
    } catch (e) {
        console.log(`[ WDP ] handleMessage error for ${bot.id}: ${e.message} ${e.stack?.slice(0,200)}`);
    }
}

// Lite-style bootBot but with WDP database and handler
async function bootBot(botId, opts = {}) {
    const bot = bots.get(String(botId));
    if (!bot) throw new Error(`Unknown bot ${botId}`);
    if (bot.sock && bot.state === 'connected' && !opts.force) return bot;

    // Boot generations: every in-flight flow (pairing timer, reconnect delay,
    // socket callbacks) belongs to the generation that started it. A purge or a
    // newer boot bumps the generation / drops the map entry, and stale flows
    // must fall silent instead of talking on a dead socket — that is how a
    // purged bot kept requesting pairing codes after its own funeral.
    bot.bootGen = (bot.bootGen || 0) + 1;
    const gen = bot.bootGen;
    const stale = () => bots.get(bot.id) !== bot || bot.bootGen !== gen;

    // One live socket per session, always. A half-dead old socket sharing the
    // session is exactly what WhatsApp terminates with 428 Connection
    // Terminated — which from the outside reads as "the bot keeps restarting".
    if (bot.sock) {
        const oldSock = bot.sock;
        bot.sock = null;
        try { oldSock.ev?.removeAllListeners?.(); } catch (_) {}
        try { oldSock.end?.(new Error('replaced by new boot')); } catch (_) {}
    }

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
    // Per-bot data file: data/bots/<botId>.json (created on first write)
    debugLog(`[ DB ] ${bot.id} → ${database.botDataFile(bot.id)}`);
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
        markOnlineOnConnect: !require('./utils/botMode').isStealth(),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async () => undefined,
    });

    // Stealth merge: mute presence/read receipts on the live socket while
    // bot mode is 'stealth' (wrappers re-check on every call — instant toggle).
    require('./utils/botMode').applyToSocket(sock);

    bot.sock = sock;
    bot.auth = { state, saveCreds };
    sock.ev.on('creds.update', saveCreds);

    const attemptPairingCode = async () => {
        if (stale()) return;
        if (bot.pairing._requested) return;
        if (bot.pairing.lastCode) return;
        if (!bot.phone || bot.mode !== 'code') return;
        if (bot.state === 'connected') return;
        bot.pairing._requested = true;
        try {
            if (!bot.pairing.active) { bot.pairing.active = true; bot.pairing.gen += 1; }
            const cleanPhone = String(bot.phone).replace(/\D/g, '');
            if (cleanPhone.length < 7 || cleanPhone.length > 15) {
                console.log(`[ ${bot.id} ] Stored phone "${cleanPhone || '(empty)'}" is not a valid number — skipping pairing code`);
                return;
            }
            debugLog(`[ ${bot.id} ] Waiting 3s for socket to stabilize...`);
            await delay(3000);
            if (stale()) return;
            if (bot.state === 'connected') return;
            debugLog(`[ ${bot.id} ] Requesting pairing code for ${cleanPhone} (attempt ${bot.pairing.attempts+1}/3)`);
            const rawCode = await sock.requestPairingCode(cleanPhone);
            const formatted = rawCode?.length === 8 ? `${rawCode.slice(0,4)}-${rawCode.slice(4)}` : rawCode;
            bot.pairing.lastCode = rawCode;
            bot.pairing.attempts += 1;
            if (bot.pairing.attempts >= 3) bot.pairing.exhausted = true;
            console.log(`[ ${bot.id} ] 🔑 Pairing code: ${rawCode} (${formatted}) for ${cleanPhone}`);
            platformBridge.emitPairingCode(bot, rawCode, { attempt: bot.pairing.attempts, gen: bot.pairing.gen, formatted });
            try { slots.setCode(bot.id, rawCode, bot.pairing.attempts, 3); } catch (_) {}
        } catch (e) {
            debugLog(`[ ${bot.id} ] Pairing code failed: ${e.message}`);
            bot.lastError = e.message;
            bot.pairing._requested = false;
        }
    }; 
    sock.ev.on('connection.update', async (update) => {
        try {
            const { connection, lastDisconnect, qr } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            debugLog(`[ ${bot.id} ] event: ${Object.keys(update).join(',')} conn=${connection} status=${statusCode}`);
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
                // Persist the session start: an upgrade swap must not reset this
                // bot's uptime to zero. Also closes the previous session, which
                // is how a killed process's uptime survives at all.
                try { await uptime.markOnline(bot.id); } catch (_) {}
                bot.accountNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || bot.accountNumber || null;
                bot.lastError = null;
                bot.pairing.active = false;
                bot.pairing.exhausted = false;
                bot.pairing._requested = false;
                bot.reconnectCount = 0;
                bot._reconnecting = false;
                bot.err503 = 0; bot.err408 = 0; bot.errConflict = 0;
                try { coldArchive.touch(bot.id); } catch (_) {}
                console.log(`[ ${bot.id} ] ✅ Connected as ${bot.accountNumber || sock.user?.id}`);
                await registry.markPaired(bot.id, bot.accountNumber).catch(() => {});
                try { slots.setPaired(bot.id, bot.accountNumber); } catch (_) {}
                // Send startup message via WDP style
                try {
                    const selfJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
                    // Resolved inside this bot's own database context, so the
                    // prefix and owner shown are THIS bot's, not the default's.
                    const fields = await resolveStartupFields({
                      database, sock, bot, commandCount: commandCount(),
                    });
                    if (selfJid) {
                      await sock.sendMessage(selfJid, { text: buildStartupCard(fields) });
                    }
                } catch (e) { console.log(`[ ${bot.id} ] Startup msg failed: ${e.message}`); }
            }

            if (connection === 'close') {
                if (stale()) return;   // purged or rebooted elsewhere; this socket is history
                if (bot._reconnecting) return;   // duplicate close events: one reconnect in flight per bot
                const reason = lastDisconnect?.error?.message || 'unknown';
                debugLog(`[ ${bot.id} ] Close: status=${statusCode} reason=${reason} pairingDone=${bot.pairingDone}`);

                if (statusCode === 401) {
                    // WDP's rule (their index.js ~1300): a 401 whose message says
                    // "conflict" is a device takeover — recoverable, and erasing a
                    // verified session there destroys a healthy bot. Every other 401
                    // is a genuine logout: the credentials are dead, so purge
                    // everything about this botId (memory, auth dir, data file,
                    // slot, registry) instead of parking a zombie that the next
                    // restart trips over.
                    const dmsg = String(
                        lastDisconnect?.error?.message ||
                        lastDisconnect?.error?.output?.payload?.message || ''
                    ).toLowerCase();
                    if (dmsg.includes('conflict')) {
                        console.log(`[ ${bot.id} ] 401 conflict — another client took over; session kept, reconnect in 15s`);
                        bot.state = 'connecting';
                        bot.lastError = '401 conflict (takeover)';
                        bot._reconnecting = true;
                        await delay(15000);
                        if (stale()) return;
                        bootBot(bot.id, { force: true })
                            .then(() => { bot._reconnecting = false; })
                            .catch(e => { console.log(`[ ${bot.id} ] Conflict reconnect failed: ${e.message}`); bot._reconnecting = false; });
                        return;
                    }
                    debugLog(`[ ${bot.id} ] 401 logged out — purging everything for this botId`);
                    await purgeBot(bot.id, { reason: 'whatsapp-logout-401', bots, authRoot: AUTH_ROOT });
                    try { coldArchive.deleteRemote(bot.id); } catch (_) {}
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

                // Per-status backoff, WDP's table (their index.js ~1350-1400).
                // The flat 5s hammer is what turned transient WhatsApp hiccups
                // into a reconnect loop: 503 means their edge dropped the
                // stream (give it room — linear 30s steps capped at 5 min),
                // 408 gets exponential backoff with jitter, 500 a plain 10s,
                // and 428/440/409 mean another socket holds the session —
                // back off harder so the duplicate can die first.
                let waitMs = 5000;
                if (statusCode === 503) {
                    bot.err503 = (bot.err503 || 0) + 1;
                    waitMs = Math.min(30000 * bot.err503, 300000);
                } else if (statusCode === 408) {
                    bot.err408 = (bot.err408 || 0) + 1;
                    waitMs = Math.min(5000 * Math.pow(2, Math.min(bot.err408, 3)) + Math.floor(Math.random() * 1000), 60000);
                } else if (statusCode === 500) {
                    waitMs = 10000;
                } else if (statusCode === 428 || statusCode === 440 || statusCode === 409) {
                    bot.errConflict = (bot.errConflict || 0) + 1;
                    waitMs = Math.min(15000 * bot.errConflict, 120000);
                }
                console.log(`[ ${bot.id} ] Reconnect #${bot.reconnectCount} in ${Math.round(waitMs / 1000)}s (status ${statusCode}) ${reason}`);
                bot.state = 'connecting';
                bot._reconnecting = true;
                await delay(waitMs);
                if (stale()) return;
                bootBot(bot.id, { force: true })
                    .then(() => { bot._reconnecting = false; })
                    .catch(e => { console.log(`[ ${bot.id} ] Reconnect failed: ${e.message}`); bot._reconnecting = false; });
            }
        } catch (e) { console.log(`[ ${bot.id} ] conn.update error: ${e.message}`); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (process.env.JUNE_ANTIDELETE_DEBUG) {
                const messageKeys = Object.keys(msg?.message || {});
                console.log(
                    `[ANTIDELETE] upsert id=${msg?.key?.id || 'none'} ` +
                    `fromMe=${!!msg?.key?.fromMe} remote=${msg?.key?.remoteJid || 'none'} ` +
                    `message=${messageKeys.length ? messageKeys.join('+') : 'none'}`,
                );
            }
            await handleMessage(bot, sock, msg);
        }
    });

    // Deleted-message detection → anti-delete recovery (.antidelete chat/private).
    // MUST run inside this bot's database context: handleDelete reads the
    // per-bot antidelete mode, and a bare call would see the default bot's
    // settings (mode 'off') and silently do nothing on multi-bot deployments.
    sock.ev.on('messages.update', async (updates) => {
        try { await database.runAsBot(bot.id, () => require('./handler').handleMessagesUpdate(sock, updates)); } catch {}
    });

    // Promote/demote/kick events change admin reality — drop the stale
    // bot-admin verdict for that group immediately (was cached for 2 min,
    // which made freshly promoted bots keep saying "bot needs to be admin"),
    // and give anti-demote/anti-promote their enforcement hook.
    sock.ev.on('group-participants.update', async (update) => {
        try { require('./handler').invalidateBotAdmin(update.id); } catch {}
        // Same context rule: antidemote/antipromote read per-bot group settings.
        try { await database.runAsBot(bot.id, () => require('./handler').handleParticipantsUpdate(sock, update)); } catch {}
    });

    if (bot.mode === 'code' && bot.phone) {
        setTimeout(() => {
            if (stale()) return;
            if (bot.state !== 'connected' && !bot.pairing._requested && !bot.pairing.lastCode) {
                debugLog(`[ ${bot.id} ] QR not received, fallback requesting pairing code...`);
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
        let id = entry.id;
        if (!id) {
            do { id = sessionService.mintId(); }
            while (bots.has(id)
                || fs.existsSync(path.join(AUTH_ROOT, id))
                || fs.existsSync(database.botDataFile(id)));
        }
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
        if (coldArchive.isArchived(id)) {
            if (!coldArchive.restoreBot(id)) return { ok: false, reason: 'cold-restore-failed', id };
        }
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
    getWdpHandler(); // loads handler.js, which owns the single shared command Map
    console.log(`[ BOOT ] Commands ready — ${commandCount()} commands + ${aliasCount()} aliases`);
})();

attachPlatform(app, server).then(async () => {
    try {
        let active = [];
        try { active = await registry.listActive(); } catch(e){ console.log('[ BOOT ] Registry list failed', e.message); }
        // Pass original registry records (with webManaged) to sessionService
        let entries = active;
        let source = 'registry';
        if (entries.length === 0) {
            try {
                if (fs.existsSync(AUTH_ROOT)) {
                    const dirs = fs.readdirSync(AUTH_ROOT).filter(n => {
                        try { return fs.statSync(path.join(AUTH_ROOT, n)).isDirectory(); } catch { return false; }
                    });
                    if (dirs.length) {
                        console.log(`[ BOOT ] Registry empty but found ${dirs.length} auth folder(s) — restoring from auth scan (wdp-style)`);
                        entries = [];
                        for (const dir of dirs) {
                            entries.push({ botId: dir, id: dir, phone: null, mode: 'code', webManaged: true, restoreOnly: true });
                            try { await registry.trackSession(dir, { phone: null, mode: 'code' }); } catch {}
                        }
                        source = 'auth scan';
                    }
                }
            } catch (e) { console.log('[ BOOT ] Auth scan failed:', e.message); }
        }
        if (entries.length) {
            const coldOnes = entries.filter((e) => coldArchive.isArchived(e.id));
            if (coldOnes.length) {
                console.log(`[ BOOT ] ${coldOnes.length} bot(s) cold on GitHub — skipped (wake via panel/reconnect): ${coldOnes.map((e) => e.id).join(', ')}`);
                entries = entries.filter((e) => !coldArchive.isArchived(e.id));
            }
            console.log(`[ BOOT ] Restoring ${entries.length} persisted session(s) from ${source}...`);
            const res = await sessionService.restorePersisted(entries);
            debugLog(`[ BOOT ] Restore result: ${JSON.stringify(res)} — bots now ${bots.size}`);
        } else {
            console.log('[ BOOT ] No persisted sessions — waiting for web pairing at /');
        }
    } catch (e) {
        console.log('[ BOOT ] Restore failed:', e.message, e.stack?.slice(0,300));
    }
    server.listen(PORT, '0.0.0.0', () => {
        // ── Chalked boot banner ──────────────────────────────────────────────
        // Colors degrade automatically when stdout is not a TTY (chalk level 0),
        // so log scrapers and tests still see plain, greppable text:
        // [ JUNE X WEB ], [ LISTEN ], [ GATEWAY ], [ HEALTH ], [ BOTS ], [ DB ].
        const bar   = chalk.cyan('━'.repeat(58));
        const tick  = chalk.magenta('  ▸ ');
        const label = (t) => chalk.bold.cyan(('[ ' + t + ' ]').padEnd(11));
        const dim   = chalk.dim;
        const val   = chalk.white;
        const hot   = chalk.bold.yellow;

        console.log('\n' + bar);
        console.log(
            '  ' + chalk.green('✅') + ' ' + chalk.bold.magenta('[ JUNE X WEB ]') + ' ' +
            chalk.bold.white('Server started') + ' ' + dim('— WDP full + Web Gateway')
        );
        console.log(bar);
        console.log(`${tick}${label('LISTEN')} ${chalk.bold.green(`0.0.0.0:${PORT}`)}`);
        console.log(`${tick}${label('GATEWAY')} ${val('Pairing UI → ')}${chalk.bold.yellow('/')} ${dim(`(at :${PORT}/)`)}`);
        console.log(`${tick}${label('HEALTH')} ${val(`:${PORT}/health`)} ${dim('|')} ${val(`:${PORT}/health/details`)} ${dim('|')} ${val(`:${PORT}/status`)}`);
        console.log(
            `${tick}${label('BOTS')} ${hot(`${bots.size}/${MAX_BOTS}`)} ${dim('active')} ${dim('|')} ` +
            `${val('WDP:')} ${hot(commandCount())} ${dim('commands')} ${dim('+')} ${hot(aliasCount())} ${dim('aliases')}`
        );
        coldArchive.configure({
            isActive: (id) => {
                const b = bots.get(id);
                return Boolean(b && (b.state === 'connected' || b.state === 'connecting'));
            },
        });
        coldArchive.start();
        // Keeps each connected bot's uptime liveness stamp fresh, so an
        // outage is never credited as uptime after a restart.
        uptime.startHeartbeat();
        if (coldArchive.enabled()) {
            console.log(
                `${tick}${label('COLD')} ${val('GitHub warehouse:')} ${chalk.bold.cyan(coldArchive.CFG.repo)} ` +
                dim(`(archive after ${coldArchive.CFG.idleDays}d offline+idle)`)
            );
        }
        console.log(
            `${tick}${label('DB')} ${val('JSON store')} ${dim('— one file per bot:')} ` +
            `${chalk.bold.cyan(`${database.getDataDir()}/<botId>.json`)} ${dim('| Shared commands:')} ${hot(commandCount())}`
        );
        console.log(bar + '\n');
    });
}).catch(err => { console.error('[ BOOT ] Platform attach failed:', err); process.exit(1); });

app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/health/details', (_, res) => {
    res.json({ ok: true, web: true, wdp: true, bots: [...bots.values()].map(botStatus), maxBots: MAX_BOTS, commands: commandCount(), aliases: aliasCount(), uptime: process.uptime(), memory: process.memoryUsage() });
});
app.get('/status', (_, res) => {
    const list = [...bots.values()].map(b => `<li>${b.id} — ${b.state} — ${b.accountNumber || b.phone || 'no phone'}</li>`).join('');
    res.send(`<html><head><title>June X Web</title></head><body style="font-family:monospace;background:#03060c;color:#e2f0ff;padding:2rem"><h1>June X WEB EDITION — WDP full + velvet-sparrow</h1><p>${bots.size}/${MAX_BOTS} bots | WDP commands: ${commandCount()}</p><ul>${list || '<li>no bots — pair at /</li>'}</ul><p><a href="/" style="color:#00ffe0">Go to pairing gateway /</a></p></body></html>`);
});

/**
 * The close routine — everything that must happen before this process dies,
 * and NOTHING about HOW it dies.
 *
 * Split from the exit on purpose. SIGTERM/SIGINT exit 0; `.shutdown` exits 45
 * so the loader keeps the bot down; `.upgrade` exits 44 so the loader re-syncs
 * and relaunches. All three need the same close first — sockets ended properly
 * (WhatsApp sees a clean close, not a dropped connection), group counters
 * flushed, every bot's JSON store written, the HTTP server released, the
 * command watcher closed.
 *
 * Idempotent: a SIGTERM arriving while `.shutdown` is already closing must not
 * run the whole thing twice.
 */
let closeStarted = false;
async function closeEverything() {
    if (closeStarted) return { ok: true, already: true };
    closeStarted = true;
    console.log('\n[ SHUTDOWN ] Stopping...');
    try {
        for (const bot of bots.values()) { try { bot.sock?.ev?.removeAllListeners?.(); bot.sock?.end?.(); } catch (_) {} }
        const { shutdownPlatform } = require('./platform');
        await shutdownPlatform().catch(() => {});
        await registry.close?.().catch(()=>{});
        // Persist pending data before exiting: group counters first (they feed
        // the store), then write every bot's JSON file out synchronously.
        try { global.__JUNE_FLUSH_GROUP_STATS?.(); } catch (_) {}
        try { database.shutdownDatabase(); } catch (_) {}
        // Release the command hot-reload watcher, otherwise the open fs.watch
        // keeps the event loop alive and server.close() never completes.
        try { getWdpHandler().handler?.closeCommandWatcher?.(); } catch (_) {}
    } catch (_) {}
    return { ok: true };
}

async function shutdown() {
    await closeEverything();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Every shutdown path runs the SAME close through this global:
//
//   SIGTERM/SIGINT  → shutdown() above → closeEverything() → exit 0
//   .shutdown       → platform/loader.js gracefulClose() → exit 45
//   .upgrade        → platform/loader.js gracefulClose() → exit 44
//
// utils/shutdown.js used to look for exactly this name and never found it —
// index.js never registered it — so its "graceful close" step logged
// "No graceful routine registered" and exited raw every single time. That is
// the bug this assignment fixes.
global.__JUNE_SHUTDOWN = closeEverything;
