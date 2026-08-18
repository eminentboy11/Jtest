/**
 * June X Platform — metadata registry.
 *
 * Tracks which sessions are WEB-PROVISIONED (created by the public pairing
 * gateway) plus their lifecycle metadata. The ENGINE's own JUNE_SESSIONS
 * registry remains the source of truth for what boots — this store only adds
 * platform bookkeeping (mode, ipHash, pairedAt) used by GC and the dev panel.
 *
 * Backend: MongoDB when MONGODB_URI (or PLATFORM_MONGODB_URI) is set,
 * otherwise a local JSON file (data/platform-registry.json). Both expose the
 * same async API so the platform code never cares which one is active.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_PATH = path.join(process.cwd(), 'data', 'platform-registry.json');
const MONGO_URI = process.env.PLATFORM_MONGODB_URI || process.env.MONGODB_URI || '';

let backend = null; // 'mongo' | 'file'
let mongoCol = null;
let mongoClient = null;
let mongoError = null;
let fileCache = null; // { sessions: { botId: {...} } }

function ipHash(ip) {
    return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);
}

// ── File backend ──────────────────────────────────────────────────────────────
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

let _saveTimer = null;
let _dirty = false;

function flushFileSave() {
    if (_saveTimer) {
        clearTimeout(_saveTimer);
        _saveTimer = null;
    }
    if (!_dirty || !fileCache) return true;

    const directory = path.dirname(FILE_PATH);
    const temporary = `${FILE_PATH}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify(fileCache, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, FILE_PATH);
        _dirty = false;
        return true;
    } catch (err) {
        try { fs.rmSync(temporary, { force: true }); } catch (_) {}
        console.error('[ PLATFORM ] Registry file save failed:', err.message);
        return false;
    }
}

function fileSave() {
    _dirty = true;
    // Debounced atomic write — registry updates can burst during GC sweeps.
    if (_saveTimer) return;
    _saveTimer = setTimeout(flushFileSave, 250);
    _saveTimer.unref?.();
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    if (backend) return backend;
    if (MONGO_URI) {
        try {
            const { MongoClient } = require('mongodb');
            mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 6000 });
            await mongoClient.connect();
            mongoCol = mongoClient.db(process.env.PLATFORM_MONGODB_DB || 'JuneXPlatform').collection('sessions');
            await mongoCol.createIndex({ pairedAt: 1 }).catch(() => {});
            backend = 'mongo';
            console.log('[ PLATFORM ] Registry backend: MongoDB');
            return backend;
        } catch (err) {
            mongoError = err.message;
            console.error('[ PLATFORM ] MongoDB unavailable, falling back to file registry:', err.message);
        }
    }
    backend = 'file';
    fileLoad();
    console.log(`[ PLATFORM ] Registry backend: JSON file (${FILE_PATH})`);
    return backend;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function trackSession(botId, data = {}) {
    const doc = {
        botId: String(botId),
        mode: data.mode || 'code',           // 'qr' | 'code'
        phone: data.phone ? String(data.phone).replace(/\D/g, '') : null,
        ipHash: data.ipHash || null,
        createdAt: data.createdAt || Date.now(),
        pairedAt: null,
        removedAt: null,
        webManaged: true,
    };
    if (backend === 'mongo') {
        await mongoCol.updateOne({ botId: doc.botId }, { $set: doc }, { upsert: true });
    } else {
        fileLoad().sessions[doc.botId] = doc;
        fileSave();
    }
    return doc;
}

async function markPaired(botId, accountNumber = null) {
    const patch = { pairedAt: Date.now(), accountNumber };
    if (backend === 'mongo') {
        await mongoCol.updateOne({ botId: String(botId) }, { $set: patch });
    } else {
        const s = fileLoad().sessions[String(botId)];
        if (s) { Object.assign(s, patch); fileSave(); }
    }
}

async function markRemoved(botId) {
    if (backend === 'mongo') {
        await mongoCol.updateOne({ botId: String(botId) }, { $set: { removedAt: Date.now() } });
    } else {
        const s = fileLoad().sessions[String(botId)];
        if (s) { s.removedAt = Date.now(); fileSave(); }
    }
}

async function getSession(botId) {
    if (backend === 'mongo') return mongoCol.findOne({ botId: String(botId) });
    return fileLoad().sessions[String(botId)] || null;
}

async function listActive() {
    if (backend === 'mongo') return mongoCol.find({ removedAt: null }).toArray();
    return Object.values(fileLoad().sessions).filter((s) => !s.removedAt);
}

async function isWebManaged(botId) {
    const s = await getSession(botId);
    return Boolean(s && s.webManaged && !s.removedAt);
}

async function status() {
    let mongoOk = null;
    if (backend === 'mongo') {
        try { await mongoClient.db('admin').command({ ping: 1 }); mongoOk = true; }
        catch (_) { mongoOk = false; }
    }
    const active = await listActive().catch(() => []);
    return {
        backend,
        mongoConfigured: Boolean(MONGO_URI),
        mongoOk,
        mongoError,
        trackedActive: active.length,
        trackedPaired: active.filter((s) => s.pairedAt).length,
    };
}

async function close() {
    if (backend === 'file') flushFileSave();
    if (mongoClient) {
        try { await mongoClient.close(); } catch (_) {}
        mongoClient = null;
        mongoCol = null;
    }
}

// Last-resort synchronous flush for ordinary process exits. Graceful shutdown
// also calls close(), but pending file metadata must survive unexpected exits.
process.once('exit', () => { if (backend === 'file') flushFileSave(); });

module.exports = {
    init,
    ipHash,
    trackSession,
    markPaired,
    markRemoved,
    getSession,
    listActive,
    isWebManaged,
    status,
    flush: flushFileSave,
    close,
};
