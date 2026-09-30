'use strict';

/**
 * Session Server client — JUNE-X~ Session IDs only.
 *
 * The Session Server mints handles of the form "JUNE-X~<4-20 letters/digits>"
 * (default 6) and serves the raw session blob at GET /session/<handle>.
 * The bot stores nothing server-side beyond the handle in SESSION_ID; the
 * blob is fetched on demand and restored into local SQLite.
 */

const crypto = require('crypto');
const zlib = require('zlib');

let BufferJSON = null;
try { ({ BufferJSON } = require('@whiskeysockets/baileys/lib/Utils/generics')); } catch (_) {}

const DEFAULT_SESSION_SERVER_URL = 'https://burning-lorena-eminentbo-ede53cc1.koyeb.app';
const DEFAULT_TIMEOUT_MS = 20000;
// Minted by the Session Server: "JUNE-X~" + SESSION_ID_LENGTH (4-20, default 6).
const HANDLE_PATTERN = /^JUNE-X~[A-Za-z0-9]{4,20}$/i;
const HANDLE_BODY_STRIP = /^june-x~/i;
const AUTH_KEY_TYPES = [
  'app-state-sync-version', 'app-state-sync-key', 'sender-key-memory',
  'sender-key', 'identity-key', 'device-list', 'lid-mapping',
  'pre-key', 'session', 'tctoken',
];

// ─── Errors ─────────────────────────────────────────────────────────────────

class SessionServerError extends Error {
  constructor(message, { status = 0, code = 'request_failed' } = {}) {
    super(message);
    this.name = 'SessionServerError';
    this.status = status;
    this.code = code;
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    this.terminal = ['session_revoked', 'session_state_missing'].includes(code);
  }
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function isJuneHandle(value) {
  return HANDLE_PATTERN.test(String(value || '').trim());
}

const handleBody = (value) => String(value || '').trim().replace(HANDLE_BODY_STRIP, '').toLowerCase();

function describeHandleProblem(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'empty';
  if (!/^june-x~/i.test(raw)) return 'missing JUNE-X~ prefix (expected JUNE-X~ + 4-20 letters/digits)';
  const body = raw.slice(7);
  if (body.length < 4 || body.length > 20) return `bad length (${body.length} after ~, expected 4-20)`;
  if (!/^[A-Za-z0-9]+$/.test(body)) return 'bad charset (only letters/digits allowed after JUNE-X~)';
  return 'valid (no problem detected)';
}

function getServerUrl() {
  const override = String(process.env.JUNE_SESSION_SERVER_URL || '').trim().replace(/\/+$/, '');
  return override || DEFAULT_SESSION_SERVER_URL;
}

function getConfiguredToken() {
  const sessionId = String(process.env.SESSION_ID || '').trim();
  return isJuneHandle(sessionId) ? sessionId : '';
}

function isTokenModeActive() {
  if (state.offlineMode) return false;
  return isJuneHandle(getConfiguredToken());
}

function markOfflineMode() {
  state.offlineMode = true;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Stable 12-hex identity suffix derived from the Session ID (bot_id partition).
function handleBotIdSuffix(value) {
  const raw = String(value || '').trim();
  if (!isJuneHandle(raw)) return null;
  return sha256Hex(handleBody(raw)).slice(0, 12);
}

// ─── Module state ───────────────────────────────────────────────────────────

const state = {
  leaseToken: null,
  leaseExpiresAt: 0,
  sessionId: null,
  sessionMeta: null,
  everAuthenticated: false,
  lastDb: null,
  authPromise: null,
  revoked: false,
  offlineMode: false,
};

// ─── Authentication (local lease for the configured handle) ─────────────────

async function authenticate({ db = null } = {}) {
  if (state.revoked) throw new SessionServerError('Session was revoked', { code: 'session_revoked' });
  if (state.authPromise) return state.authPromise;
  if (db) state.lastDb = db;

  const token = getConfiguredToken();
  const serverUrl = getServerUrl();
  if (!isJuneHandle(token)) {
    throw new SessionServerError('No valid JUNE-X~ Session ID configured in SESSION_ID');
  }
  if (!serverUrl) throw new SessionServerError('Session Server URL is not configured');

  state.authPromise = Promise.resolve().then(() => {
    state.leaseToken = token;
    state.leaseExpiresAt = Date.now() + 20 * 60 * 1000;
    state.sessionId = null;
    state.sessionMeta = null;
    state.everAuthenticated = true;
    return { session: null, lease: { token, expiresAt: state.leaseExpiresAt } };
  }).finally(() => { state.authPromise = null; });
  return state.authPromise;
}

function isAuthenticated() {
  return Boolean(state.leaseToken && Date.now() < state.leaseExpiresAt);
}

// ─── Snapshot validation + SQLite restore ───────────────────────────────────

function validateSnapshot(statePayload) {
  if (!statePayload || typeof statePayload !== 'object') return null;
  const creds = Array.isArray(statePayload.sessionCreds) ? statePayload.sessionCreds : null;
  const keys = Array.isArray(statePayload.sessionKeys) ? statePayload.sessionKeys : null;
  const meta = Array.isArray(statePayload.sessionAuthMeta) ? statePayload.sessionAuthMeta : null;
  if (!creds || !keys || !meta) return null;
  if (!creds.some((row) => row?.key === 'creds' && typeof row.value === 'string')) return null;
  if (meta.find((row) => row?.key === 'status')?.value !== 'verified') return null;
  if (!creds.every((row) => typeof row?.key === 'string' && typeof row?.value === 'string')) return null;
  if (!keys.every((row) => typeof row?.type === 'string' && typeof row?.id === 'string' && typeof row?.value === 'string')) return null;
  if (!meta.every((row) => typeof row?.key === 'string' && typeof row?.value === 'string')) return null;
  return { creds, keys, meta };
}

function restoreSnapshotIntoSQLite(db, snapshot) {
  const now = Date.now();
  const insertCred = db.prepare(`
    INSERT INTO session_creds (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const insertKey = db.prepare(`
    INSERT INTO session_keys (type, id, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(type, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const insertMeta = db.prepare(`
    INSERT INTO session_auth_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const restore = db.transaction(() => {
    db.prepare('DELETE FROM session_creds').run();
    db.prepare('DELETE FROM session_keys').run();
    db.prepare('DELETE FROM session_auth_meta').run();
    for (const row of snapshot.creds) insertCred.run(row.key, row.value, Number(row.updated_at || now));
    for (const row of snapshot.keys) insertKey.run(row.type, row.id, row.value, Number(row.updated_at || now));
    for (const row of snapshot.meta) insertMeta.run(row.key, row.value);
  });
  restore();
  return { credentialRows: snapshot.creds.length, keyRows: snapshot.keys.length, metaRows: snapshot.meta.length };
}

// ─── JUNE-X~ handle restore (static blob) ───────────────────────────────────

function parseAuthKeyFilename(name) {
  if (!name.endsWith('.json') || name === 'creds.json') return null;
  const base = name.slice(0, -'.json'.length);
  const type = AUTH_KEY_TYPES.find((candidate) => base.startsWith(`${candidate}-`));
  if (!type) return null;
  const id = base.slice(type.length + 1).replace(/__/g, '/').replace(/-/g, ':');
  return id ? { type, id } : null;
}

function filesToSnapshot(files) {
  const now = Date.now();
  const canonicalAuthJson = (value) => {
    try {
      const revived = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
      return JSON.parse(JSON.stringify(revived, BufferJSON.replacer));
    } catch (_) {
      return value;
    }
  };
  const credsFile = files ? canonicalAuthJson(files['creds.json']) : null;
  if (!credsFile || typeof credsFile !== 'object') return null;
  const sessionCreds = [{ key: 'creds', value: JSON.stringify(credsFile), updated_at: now }];
  const sessionKeys = [];
  for (const [name, value] of Object.entries(files || {})) {
    if (name === 'creds.json') continue;
    const parsed = parseAuthKeyFilename(name);
    if (!parsed || !value || typeof value !== 'object') continue;
    sessionKeys.push({ type: parsed.type, id: parsed.id, value: JSON.stringify(canonicalAuthJson(value)), updated_at: now });
  }
  const sessionAuthMeta = [
    { key: 'status', value: 'verified' },
    { key: 'source', value: 'june-session-server' },
  ];
  return { creds: sessionCreds, keys: sessionKeys, meta: sessionAuthMeta };
}

async function fetchAndRestoreSnapshot(db) {
  const handle = getConfiguredToken();
  if (!isJuneHandle(handle)) {
    throw new SessionServerError('No valid JUNE-X~ Session ID configured in SESSION_ID');
  }
  const serverUrl = getServerUrl();
  let response;
  try {
    response = await fetch(`${serverUrl}/session/${encodeURIComponent(handle)}`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SessionServerError(`Session Server unreachable: ${cause.message}`);
  }
  const text = (await response.text()).trim();
  if (!response.ok) {
    throw new SessionServerError('This Session ID is unknown or was revoked', { code: 'session_revoked', status: response.status });
  }
  // The server returns "<PREFIX><gzip base64 payload>" — drop the prefix.
  let blob = text;
  const tilde = blob.indexOf('~');
  if (tilde >= 0) blob = blob.slice(tilde + 1);
  let creds;
  try {
    creds = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
  } catch (_) {
    throw new SessionServerError('Session Server returned an invalid session blob', { code: 'session_state_missing' });
  }
  const snapshot = filesToSnapshot({ 'creds.json': creds });
  if (!snapshot) {
    throw new SessionServerError('Session Server returned an invalid session blob', { code: 'session_state_missing' });
  }
  state.offlineMode = true;
  state.leaseToken = null;
  state.leaseExpiresAt = 0;
  const restored = restoreSnapshotIntoSQLite(db, snapshot);
  return { ...restored, version: null, sessionId: null };
}

// ─── Revocation (local only — the server has no revoke endpoint) ────────────

async function revokeSession(reason = 'whatsapp-logout') {
  if (state.revoked) return { revoked: false, skipped: 'already-revoked' };
  state.revoked = true;
  state.leaseToken = null;
  state.leaseExpiresAt = 0;
  return { revoked: true, localOnly: true, reason };
}

// ─── Status ─────────────────────────────────────────────────────────────────

function getStatus() {
  return {
    tokenMode: isTokenModeActive(),
    serverConfigured: Boolean(getServerUrl()),
    authenticated: isAuthenticated(),
    sessionId: state.sessionId,
    sessionMeta: state.sessionMeta,
  };
}

module.exports = {
  HANDLE_PATTERN,
  DEFAULT_SESSION_SERVER_URL,
  isJuneHandle,
  describeHandleProblem,
  getServerUrl,
  getConfiguredToken,
  isTokenModeActive,
  markOfflineMode,
  sha256Hex,
  handleBotIdSuffix,
  authenticate,
  isAuthenticated,
  filesToSnapshot,
  restoreSnapshotIntoSQLite,
  validateSnapshot,
  fetchAndRestoreSnapshot,
  SessionServerError,
  revokeSession,
  getStatus,
};
