'use strict';

/**
 * Scheduled website pinger — backend for the .pinger owner command.
 *
 * Targets persist in bot_settings under 'pinger.targets' and survive
 * restarts. One master interval pings every target in parallel; the owner
 * is DM'd only on status TRANSITIONS (up→down / down→up), never on every
 * cycle. The first cycle after boot establishes the baseline silently so a
 * restart cannot generate false alarms.
 *
 * Keep-alive friendly: any HTTP response below 500 counts as 'up' (free
 * hosts stay awake on 404s too); 5xx, timeouts and network errors count as
 * 'down'.
 */

const path = require('path');

const SETTINGS_KEY = 'pinger.targets';
const DEFAULT_INTERVAL_MS = 4 * 60 * 1000; // matches the keep-alive self-ping cadence
const PING_TIMEOUT_MS = 10 * 1000;
const MAX_TARGETS = 10;
const MAX_URL_LENGTH = 200;

const state = {
    sock: null,        // current WhatsApp socket (for owner DMs), refreshed per connect
    db: null,          // injectable database module (tests); falls back to __CORE__
    timer: null,       // master interval handle
    statuses: new Map(), // url -> { status: 'up'|'down', httpStatus, latencyMs, error, checkedAt }
};

function intervalMs() {
    const override = Number(process.env.JUNE_PINGER_INTERVAL_MS);
    return Number.isSafeInteger(override) && override >= 250 ? override : DEFAULT_INTERVAL_MS;
}

function getDb() {
    if (state.db) return state.db;
    return require(path.join(global.__CORE__ || process.cwd(), 'database'));
}

// ─── URL validation ──────────────────────────────────────────────────────────

const PRIVATE_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[?::1\]?$/,
    /^\[?fe80:/i,
    /^\[?fc00:/i,
    /^\[?fd/i,
];

function isPrivateHost(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '');
    if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) return true;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0 – 172.31.255.255
    }
    return false;
}

function validateTargetUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, error: 'No URL given.' };
    if (raw.length > MAX_URL_LENGTH) return { ok: false, error: `URL is too long (max ${MAX_URL_LENGTH} characters).` };
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        return { ok: false, error: 'That is not a valid URL (include https:// — e.g. https://example.com).' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'Only http:// and https:// URLs are supported.' };
    }
    if (!url.hostname) return { ok: false, error: 'The URL has no hostname.' };
    if (isPrivateHost(url.hostname)) {
        return { ok: false, error: 'Private, loopback and link-local addresses cannot be pinged.' };
    }
    url.hash = '';
    return { ok: true, url: url.toString() };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function listTargets() {
    const stored = getDb().getBotSetting(SETTINGS_KEY);
    return Array.isArray(stored) ? stored.filter((t) => t && typeof t.url === 'string') : [];
}

function saveTargets(targets) {
    getDb().setBotSetting(SETTINGS_KEY, targets);
}

function addTarget(url, addedAt = Date.now()) {
    const targets = listTargets();
    if (targets.some((t) => t.url === url)) return { added: false, reason: 'already-listed' };
    if (targets.length >= MAX_TARGETS) return { added: false, reason: 'limit' };
    targets.push({ url, addedAt });
    saveTargets(targets);
    ensureTimer();
    return { added: true };
}

function removeTarget(url) {
    const targets = listTargets();
    const next = targets.filter((t) => t.url !== url);
    if (next.length === targets.length) return { removed: false };
    saveTargets(next);
    state.statuses.delete(url);
    if (!next.length) stopTimer();
    return { removed: true };
}

function clearTargets() {
    const had = listTargets().length > 0;
    saveTargets([]);
    state.statuses.clear();
    stopTimer();
    return { cleared: had };
}

// ─── Pinging ─────────────────────────────────────────────────────────────────

async function pingOnce(url) {
    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(PING_TIMEOUT_MS),
            headers: { 'User-Agent': 'JuneX-Ultra-Pinger/3.0 (+keep-alive)' },
        });
        try { res.body?.cancel?.(); } catch (_) { /* body may already be closed */ }
        const latencyMs = Date.now() - startedAt;
        // Any response below 500 proves the service is alive (and awake).
        return { ok: res.status < 500, status: res.status < 500 ? 'up' : 'down', httpStatus: res.status, latencyMs, error: null };
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const reason = error?.name === 'TimeoutError' ? 'timeout' : (error?.cause?.code || error?.code || error?.message || 'network error');
        return { ok: false, status: 'down', httpStatus: null, latencyMs, error: String(reason) };
    }
}

// ─── Owner notifications ─────────────────────────────────────────────────────

function ownerJids() {
    try {
        return (getDb().getOwners() || [])
            .map((o) => String(o || '').trim())
            .filter(Boolean)
            .map((o) => (o.includes('@') ? o : `${o.replace(/\D/g, '')}@s.whatsapp.net`))
            .filter((j) => j.startsWith('@') === false && j.includes('@s.whatsapp.net'));
    } catch (_) {
        return [];
    }
}

async function notifyOwners(text) {
    if (!state.sock) return;
    for (const jid of ownerJids()) {
        try {
            await state.sock.sendMessage(jid, { text });
        } catch (_) { /* never let a failed DM break the scheduler */ }
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

async function runCycle() {
    const targets = listTargets();
    if (!targets.length) { stopTimer(); return; }
    const results = await Promise.allSettled(targets.map((t) => pingOnce(t.url)));
    results.forEach((r, i) => {
        const url = targets[i].url;
        const result = r.status === 'fulfilled' ? r.value
            : { ok: false, status: 'down', httpStatus: null, latencyMs: null, error: String(r.reason) };
        const previous = state.statuses.get(url);
        state.statuses.set(url, { ...result, checkedAt: Date.now() });
        // Transition notifications only — the first observed state after boot
        // is the baseline and is never reported.
        if (previous && previous.status !== result.status) {
            if (result.status === 'down') {
                void notifyOwners(`🔴 *Pinger: site down*\n\n${url}\n\nReason: ${result.error || `HTTP ${result.httpStatus}`}\nChecked: ${new Date().toLocaleString()}`);
            } else {
                void notifyOwners(`🟢 *Pinger: site recovered*\n\n${url}\n\nHTTP ${result.httpStatus} · ${result.latencyMs} ms\nChecked: ${new Date().toLocaleString()}`);
            }
        }
    });
}

function ensureTimer() {
    if (state.timer) return;
    state.timer = setInterval(() => { void runCycle().catch(() => {}); }, intervalMs());
    if (global._activeIntervals) global._activeIntervals.push(state.timer);
}

function stopTimer() {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
}

/**
 * Called from index.js on every connection open. Idempotent: refreshes the
 * socket reference and (re)starts the scheduler if targets exist. Timers
 * registered in global._activeIntervals are cleared by the bot's own
 * reconnect/logout lifecycle; this call brings the scheduler back.
 */
function onBotConnected(sock, databaseOverride) {
    if (sock) state.sock = sock;
    if (databaseOverride) state.db = databaseOverride;
    if (listTargets().length) {
        ensureTimer();
        // Baseline cycle shortly after connect so the list shows fresh status.
        setTimeout(() => { void runCycle().catch(() => {}); }, 3 * 1000);
    }
    return true;
}

function getStatusMap() {
    return state.statuses;
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    MAX_TARGETS,
    SETTINGS_KEY,
    intervalMs,
    validateTargetUrl,
    listTargets,
    addTarget,
    removeTarget,
    clearTargets,
    pingOnce,
    onBotConnected,
    runCycle,
    getStatusMap,
    __test: { state, getDb: () => getDb(), setDatabase: (db) => { state.db = db; }, reset: () => { stopTimer(); state.sock = null; state.db = null; state.statuses.clear(); } },
};
