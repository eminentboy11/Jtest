/**
 * Web Lite — file-only registry, no MongoDB, no env mode switch.
 * Tracks web-provisioned sessions: data/platform-registry.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_PATH = path.join(process.cwd(), 'data', 'platform-registry.json');

let fileCache = null;
let _saveTimer = null;
let _dirty = false;

function ipHash(ip) {
    return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);
}

function fileLoad() {
    if (fileCache) return fileCache;
    try {
        fileCache = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } catch (_) {
        fileCache = { sessions: {} };
    }
    if (!fileCache.sessions) fileCache.sessions = {};
    return fileCache;
}

function flushFileSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (!_dirty || !fileCache) return true;
    const dir = path.dirname(FILE_PATH);
    const tmp = `${FILE_PATH}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(fileCache, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, FILE_PATH);
        _dirty = false;
        return true;
    } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        console.error('[ REGISTRY ] Save failed:', err.message);
        return false;
    }
}

function fileSave() {
    _dirty = true;
    // WDP-style: immediate save, not debounce — Pterodactyl can kill in 5s, 250ms debounce loses registry
    flushFileSave();
}

async function init() {
    fileLoad();
    console.log(`[ PLATFORM ] Registry: file (${FILE_PATH})`);
    return 'file';
}

async function trackSession(botId, data = {}) {
    const doc = {
        botId: String(botId),
        mode: data.mode || 'code',
        phone: data.phone ? String(data.phone).replace(/\D/g, '') : null,
        ipHash: data.ipHash || null,
        createdAt: data.createdAt || Date.now(),
        pairedAt: null,
        removedAt: null,
        webManaged: true,
    };
    fileLoad().sessions[doc.botId] = doc;
    fileSave();
    return doc;
}

async function markPaired(botId, accountNumber = null) {
    const s = fileLoad().sessions[String(botId)];
    if (s) { s.pairedAt = Date.now(); s.accountNumber = accountNumber || s.accountNumber; fileSave(); }
}

async function markRemoved(botId) {
    const s = fileLoad().sessions[String(botId)];
    if (s) { s.removedAt = Date.now(); fileSave(); }
}

async function getSession(botId) {
    return fileLoad().sessions[String(botId)] || null;
}

async function listActive() {
    return Object.values(fileLoad().sessions).filter(s => !s.removedAt);
}

async function isWebManaged(botId) {
    const s = await getSession(botId);
    return Boolean(s && s.webManaged && !s.removedAt);
}

async function status() {
    const active = await listActive().catch(() => []);
    return { backend: 'file', trackedActive: active.length, trackedPaired: active.filter(s => s.pairedAt).length };
}

async function close() { flushFileSave(); }

process.once('exit', () => { flushFileSave(); });
process.on('SIGINT', () => { flushFileSave(); });
process.on('SIGTERM', () => { flushFileSave(); });

module.exports = { init, ipHash, trackSession, markPaired, markRemoved, getSession, listActive, isWebManaged, status, flush: flushFileSave, close };
