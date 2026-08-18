/**
 * June X Platform — internal session control service.
 *
 * This is the web platform's only session-management dependency. The engine
 * configures it once during startup; HTTP routes, GC and slot orchestration do
 * not call legacy WhatsApp command globals or SessionManager boot internals.
 */

'use strict';

const crypto = require('crypto');

let engine = null;

function configure(adapter) {
    const required = ['provision', 'restorePersisted', 'remove', 'stop', 'reconnect', 'reconcile', 'get', 'list', 'snapshot'];
    for (const method of required) {
        if (typeof adapter?.[method] !== 'function') {
            throw new Error(`SESSION_SERVICE_ADAPTER_MISSING:${method}`);
        }
    }
    engine = Object.freeze({ ...adapter });
    return module.exports;
}

function configured() { return Boolean(engine); }
function resetForTests() { engine = null; }
function requireEngine() {
    if (!engine) throw new Error('SESSION_SERVICE_NOT_CONFIGURED');
    return engine;
}

function qrEntry() {
    const id = `web-${crypto.randomBytes(5).toString('hex')}`;
    return { id, name: `June X ${id.slice(-3)}`, qrLogin: true };
}

/**
 * Provision QR or pairing-code sessions through the SAME engine operation.
 * Optional commit(result) performs platform bookkeeping. If it fails, the
 * freshly-created engine session is permanently rolled back before rethrowing.
 */
async function provision(input = {}, options = {}) {
    const mode = String(input.mode || '');
    if (!['qr', 'code'].includes(mode)) throw new Error('INVALID_PROVISION_MODE');

    const entry = mode === 'qr'
        ? qrEntry()
        : { phone: String(input.phone || '').replace(/\D/g, ''), sessionId: '' };

    let result = null;
    try {
        result = await requireEngine().provision(entry, { source: 'web', mode });
        if (!result?.ok || !result.id) {
            const error = new Error(`PROVISION_FAILED:${result?.reason || 'unknown'}`);
            error.result = result;
            throw error;
        }
        if (typeof options.commit === 'function') await options.commit(result);
        return { ...result, mode };
    } catch (error) {
        if (result?.id) {
            try { await requireEngine().remove(String(result.id), { reason: 'provision-rollback' }); }
            catch (rollbackError) { error.rollbackError = rollbackError; }
        }
        throw error;
    }
}

async function restorePersisted(records = []) {
    const entries = [];
    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.webManaged || record.removedAt || !record.botId) continue;
        const id = String(record.botId);
        if (record.mode === 'qr') {
            entries.push({ id, name: `June X ${id.slice(-3)}`, qrLogin: true, restoreOnly: true });
        } else {
            const phone = String(record.phone || id.replace(/-\d+$/, '')).replace(/\D/g, '');
            entries.push({ id, name: `June X ${phone.slice(-3) || id.slice(-3)}`, phone, restoreOnly: true });
        }
    }
    return requireEngine().restorePersisted(entries);
}

async function stop(botId) {
    const id = String(botId);
    if (!requireEngine().get(id)) return { ok: false, reason: 'unknown', id };
    return requireEngine().stop(id);
}

async function reconnect(botId, options = {}) {
    const id = String(botId);
    if (!requireEngine().get(id)) return { ok: false, reason: 'unknown', id };
    return requireEngine().reconnect(id, options);
}

async function remove(botId, options = {}) {
    const id = String(botId);
    return requireEngine().remove(id, options);
}

/** Permanently remove every currently registered bot, one at a time. */
async function removeAll(options = {}) {
    const ids = list().map(bot => String(bot.id));
    const deleted = [];
    const failed = [];

    // Sequential deletion avoids simultaneous SQLite/Mongo cleanup spikes and
    // guarantees one failure cannot prevent later bots from being attempted.
    for (const id of ids) {
        try {
            const result = await remove(id, { ...options, reason: options.reason || 'developer-delete-all' });
            if (result?.ok) deleted.push({ id, result });
            else failed.push({ id, reason: result?.reason || 'remove-failed' });
        } catch (error) {
            failed.push({ id, reason: error?.message || 'remove-failed' });
        }
    }
    return { ok: failed.length === 0, total: ids.length, deleted, failed };
}

async function reconcile() { return requireEngine().reconcile(); }
function get(botId) { return requireEngine().get(String(botId)); }
function list() { return requireEngine().list(); }
function snapshot() { return requireEngine().snapshot(); }
function activeCount() { return list().length; }

module.exports = {
    configure,
    configured,
    _resetForTests: resetForTests,
    provision,
    restorePersisted,
    stop,
    reconnect,
    remove,
    removeAll,
    reconcile,
    get,
    list,
    snapshot,
    activeCount,
};
