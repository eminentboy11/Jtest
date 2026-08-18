/**
 * Ownership — deployment-level Super Owner foundation.
 *
 * SECURITY MODEL
 * --------------
 * - The deployment Super Owner is established ONCE, during first-time
 *   initialization, from the verified WhatsApp number of the FIRST initial
 *   session that successfully connects (never from public web provisioning,
 *   a WhatsApp command, or hardcoded config).
 * - Once persisted it is LOCKED: it is never recalculated on startup, never
 *   overwritten, and never cleared by disconnects, removals or reordering.
 * - Session-level ownership remains available to retained WhatsApp bot
 *   features. Web provisioning and fleet management use /dev authentication
 *   instead of WhatsApp command authorization.
 *
 * Storage: platform_settings table in the ANCHOR database (june-ultra.db) —
 * deployment-level, independent of the session registry.
 */

'use strict';

const database = require('../../database');

const SUPER_OWNER_KEY = 'superOwner';

const normalizeNumber = (value) =>
    String(value || '').split(':')[0].split('@')[0].replace(/\D/g, '');

function getSuperOwner() {
    try {
        return database.getPlatformSetting(SUPER_OWNER_KEY) || null;
    } catch (_) {
        return null;
    }
}

function hasSuperOwner() {
    return Boolean(getSuperOwner());
}

/**
 * Does this sender match the persisted deployment Super Owner?
 * (false whenever no Super Owner has been established yet)
 */
function isSuperOwner(sender) {
    const superOwner = getSuperOwner();
    if (!superOwner) return false;
    return normalizeNumber(sender) === normalizeNumber(superOwner);
}

/**
 * Atomically establish the deployment Super Owner from a session's verified
 * WhatsApp number. Only eligible initial sessions may claim; the underlying
 * SQLite INSERT ... ON CONFLICT DO NOTHING makes the first writer win and
 * every later claim a no-op — race-safe even when multiple initial sessions
 * connect nearly simultaneously.
 *
 * @param {string|number} number  verified WhatsApp number (sock.user.id)
 * @param {boolean} eligible      true only for initial-startup sessions
 * @returns {{ established: boolean, existing: string|null, superOwner: string|null }}
 */
function claimSuperOwner(number, { eligible = false } = {}) {
    const existing = getSuperOwner();
    if (existing) return { established: false, existing, superOwner: existing };
    if (!eligible) return { established: false, existing: null, superOwner: null };
    const normalized = normalizeNumber(number);
    if (!normalized) return { established: false, existing: null, superOwner: null };

    const result = database.claimPlatformSetting(SUPER_OWNER_KEY, normalized);
    return {
        established: result.established,
        existing: result.existing || null,
        superOwner: result.existing || null,
    };
}

/**
 * Display-only indicator for the connected/welcome message:
 *   '✅' current session IS the Super Owner
 *   '❌' a Super Owner exists and this session is not it
 *   '—' no Super Owner established yet
 * The Super Owner number itself is never returned or printed.
 */
function superOwnerStatusFor(number) {
    const superOwner = getSuperOwner();
    if (!superOwner) return '—';
    return normalizeNumber(number) === normalizeNumber(superOwner) ? '✅' : '❌';
}

module.exports = {
    SUPER_OWNER_KEY,
    normalizeNumber,
    getSuperOwner,
    hasSuperOwner,
    isSuperOwner,
    claimSuperOwner,
    superOwnerStatusFor,
};
