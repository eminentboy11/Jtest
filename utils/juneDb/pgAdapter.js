'use strict';

/**
 * Optional PostgreSQL persistence for June X.
 *
 * SQLite remains the local source used by the bot at runtime. PostgreSQL is a
 * remote mirror/recovery layer that is enabled only when DATABASE_URL exists.
 * Every public operation is safe when PostgreSQL is absent or unavailable.
 */

const fs = require('fs');
const path = require('path');

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_) {
  // The bot can still run on SQLite-only installations that have not installed
  // the optional PostgreSQL dependency yet.
}

const SCHEMA_FILE = path.join(__dirname, 'postgres-schema.sql');
const LEGACY_AUTH_RECORD_KEY = '__june_encrypted_auth_backup_v1__';

function normalizeBotId(value) {
  const raw = String(value || '')
    .trim()
    .split('@')[0]
    .split(':')[0];
  const normalized = raw.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
  return normalized || 'june-x-main';
}

// Remote rows are partitioned by bot_id. Without a per-deployment component
// every bot writing to the same database shares one namespace — including
// session_auth_state, so a second bot would restore the first one's WhatsApp
// session. PN is the documented way for a user to identify their deployment.
//
// The separator must be '-' or '_': normalizeBotId() splits on ':' and '@' to
// turn a JID into a bare number, which would silently discard everything after
// the separator.
const BOT_ID_PRODUCT = 'june-ultra-main';

function buildBotId(pn, product = BOT_ID_PRODUCT) {
  // Strip the JID parts before pulling digits, otherwise a device-scoped id
  // like 2348154853640:12@s.whatsapp.net folds the ":12" into the number.
  const digits = String(pn || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return normalizeBotId(digits ? `${product}-${digits}` : product);
}

let activeBotId = buildBotId(
  process.env.PN ||
  process.env.JUNE_PN ||
  process.env.JUNE_BOT_ID ||
  process.env.BOT_ID ||
  process.env.OWNER_NUMBER
);

let pool = null;
let ready = false;
let initializing = null;
let lastError = null;
let schemaReady = false;

function hasUrl() {
  return Boolean(getUrl());
}

// Heroku provisions DATABASE_URL, while the project documentation and local
// .env template use POSTGRESQL_URL. Accept both so remote persistence is not
// accidentally disabled after a dyno restart.
function getUrl() {
  return String(
    process.env.DATABASE_URL ||
    process.env.POSTGRESQL_URL ||
    process.env.POSTGRES_URL ||
    ''
  ).trim();
}

function getBotId() {
  return activeBotId;
}

function setBotId(value) {
  if (value) activeBotId = normalizeBotId(value);
  return activeBotId;
}

function getStatus() {
  return {
    configured: hasUrl(),
    available: ready,
    schemaReady,
    botId: activeBotId,
    lastError,
  };
}

function readSchema() {
  try {
    return fs.readFileSync(SCHEMA_FILE, 'utf8');
  } catch (error) {
    throw new Error(`PostgreSQL schema file is unavailable: ${error.message}`);
  }
}

// Users paste provider URLs as-is (Neon, Render, Supabase, Heroku, Railway).
// Those often include sslmode=require and channel_binding=require. node-pg
// warns on sslmode=require and does not implement channel_binding, so strip
// both from the string and apply TLS ourselves. Local URLs stay plaintext
// unless sslmode is set; sslmode=disable remains an explicit opt-out.
function normalizePgConfig(connectionString) {
  const raw = String(connectionString || '').trim();
  const fallbackSsl = { rejectUnauthorized: false };

  const stripQueryKeys = (value, keys) => {
    let next = String(value || '');
    for (const key of keys) {
      next = next.replace(new RegExp(`([?&])${key}=[^&]*`, 'gi'), '$1');
    }
    return next.replace(/[?&]+$/g, '').replace(/\?&/g, '?').replace(/&&+/g, '&');
  };

  try {
    const url = new URL(raw);
    const sslmode = String(url.searchParams.get('sslmode') || '').toLowerCase();
    const sslFlag = String(url.searchParams.get('ssl') || '').toLowerCase();
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    url.searchParams.delete('uselibpqcompat');
    if (sslFlag === 'true' || sslFlag === '1' || sslFlag === 'require') {
      url.searchParams.delete('ssl');
    }
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(url.hostname);
    let ssl;
    if (sslmode === 'disable' || sslFlag === 'false' || sslFlag === '0') ssl = false;
    else if (sslmode === 'verify-full') ssl = { rejectUnauthorized: true };
    else if (sslmode || sslFlag === 'true' || sslFlag === '1' || sslFlag === 'require' || !isLocal) ssl = fallbackSsl;
    return { connectionString: url.toString(), ssl };
  } catch {
    const sslmode = /sslmode=([^&]+)/i.exec(raw)?.[1]?.toLowerCase() || '';
    if (sslmode === 'disable') {
      return { connectionString: stripQueryKeys(raw, ['sslmode', 'channel_binding', 'uselibpqcompat']), ssl: false };
    }
    return {
      connectionString: stripQueryKeys(raw, ['sslmode', 'channel_binding', 'uselibpqcompat', 'ssl']),
      ssl: fallbackSsl,
    };
  }
}

async function init() {
  if (ready) return getStatus();
  if (initializing) return initializing;

  initializing = (async () => {
    if (!hasUrl()) {
      return getStatus();
    }

    if (!Pool) {
      lastError = 'The pg package is not installed';
      console.warn(`[PG] Optional PostgreSQL disabled: ${lastError}`);
      return getStatus();
    }

    const connectionString = getUrl();
const pgConfig = normalizePgConfig(connectionString);

const nextPool = new Pool({
  connectionString: pgConfig.connectionString,
  max: Number(process.env.JUNE_PG_POOL_MAX) || 5,
  idleTimeoutMillis: Number(process.env.JUNE_PG_IDLE_TIMEOUT_MS) || 30000,
  connectionTimeoutMillis: Number(process.env.JUNE_PG_CONNECTION_TIMEOUT_MS) || 5000,
  ssl: pgConfig.ssl,
});

nextPool.on('error', (error) => {
  lastError = error.message;
  // A dead database fires this on every failed operation — log it at most
  // once every 5 minutes so the console never floods.
  const now = Date.now();
  if (now - nextPool._lastErrorLog >= 5 * 60 * 1000) {
    nextPool._lastErrorLog = now;
    console.warn(`[PG] Pool error: ${error.message}`);
  }
});

    try {
      await nextPool.query('SELECT 1');
      await nextPool.query(readSchema());
      pool = nextPool;
      ready = true;
      schemaReady = true;
      lastError = null;
      console.log(`[PG] Connected; remote persistence enabled for bot_id=${require('../redact').maskBotId(activeBotId)}`);
    } catch (error) {
      lastError = error.message;
      console.warn(`[PG] Optional PostgreSQL unavailable: ${error.message}`);
      // The driver's own wording says nothing about what to change.
      if (/SSL|TLS/i.test(error.message)) {
        console.warn('[PG] The server requires TLS. Paste the provider URL as-is; June enables TLS for remote hosts automatically.');
      } else if (/password|authentication|role .* does not exist/i.test(error.message)) {
        console.warn('[PG] Check the username and password in DATABASE_URL.');
      } else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(error.message)) {
        console.warn('[PG] Host unreachable — check the hostname, port, and that the database is awake.');
      }
      try { await nextPool.end(); } catch (_) {}
    }

    return getStatus();
  })().finally(() => {
    initializing = null;
  });

  return initializing;
}

function query(text, params = []) {
  if (!ready || !pool) return Promise.resolve(null);
  return pool.query(text, params).catch((error) => {
    lastError = error.message;
    return null;
  });
}

// Mirror helpers return their query promise. Callers may ignore the result for
// normal fast-path writes, while June's durable queue can retry a null result.
function mirrorBotSetting(key, value) {
  return query(
    `INSERT INTO bot_configs (bot_id, key, value)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (bot_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [activeBotId, String(key), JSON.stringify(value)]
  );
}

function mirrorGroupSettings(groupId, settings) {
  return query(
    `INSERT INTO group_features (bot_id, group_id, feature, config, enabled)
     VALUES ($1, $2, $3, $4::jsonb, TRUE)
     ON CONFLICT (bot_id, group_id, feature)
     DO UPDATE SET config = EXCLUDED.config, enabled = TRUE, updated_at = NOW()`,
    [activeBotId, String(groupId), 'group-settings', JSON.stringify(settings || {})]
  );
}

function mirrorGroupStat(groupId, date, data) {
  return query(
    `INSERT INTO group_stats (bot_id, group_id, stat_date, data)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (bot_id, group_id, stat_date)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [activeBotId, String(groupId), String(date), JSON.stringify(data || {})]
  );
}

function mirrorUser(userId, data) {
  return query(
    `INSERT INTO users (bot_id, user_id, data)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (bot_id, user_id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [activeBotId, String(userId), JSON.stringify(data || {})]
  );
}

function mirrorAntideleteMessage(chatId, messageId, payload, storedAt = Date.now()) {
  return query(
    `INSERT INTO antidelete_messages (bot_id, chat_id, message_id, payload, stored_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (bot_id, chat_id, message_id)
     DO UPDATE SET payload = EXCLUDED.payload, stored_at = EXCLUDED.stored_at`,
    [activeBotId, String(chatId), String(messageId), JSON.stringify(payload || {}), new Date(Number(storedAt))]
  );
}

function deleteAntideleteMessage(chatId, messageId) {
  return query(
    `DELETE FROM antidelete_messages
     WHERE bot_id = $1 AND chat_id = $2 AND message_id = $3`,
    [activeBotId, String(chatId), String(messageId)]
  );
}

function mirrorAntideleteStatus(statusId, payload, storedAt = Date.now()) {
  return query(
    `INSERT INTO antidelete_statuses (bot_id, status_id, payload, stored_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (bot_id, status_id)
     DO UPDATE SET payload = EXCLUDED.payload, stored_at = EXCLUDED.stored_at`,
    [activeBotId, String(statusId), JSON.stringify(payload || {}), new Date(Number(storedAt))]
  );
}

function deleteAntideleteStatus(statusId) {
  return query(
    `DELETE FROM antidelete_statuses
     WHERE bot_id = $1 AND status_id = $2`,
    [activeBotId, String(statusId)]
  );
}

function mirrorLidMap(direction, user, value, updatedAt = Date.now()) {
  return query(
    `INSERT INTO lid_map (bot_id, direction, map_user, map_value, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bot_id, direction, map_user)
     DO UPDATE SET map_value = EXCLUDED.map_value, updated_at = EXCLUDED.updated_at`,
    [activeBotId, String(direction), String(user), String(value), new Date(Number(updatedAt))]
  );
}

function mirrorWarning(groupId, userId, warning) {
  return query(
    `INSERT INTO warnings (bot_id, group_id, user_id, count, reasons)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (bot_id, group_id, user_id)
     DO UPDATE SET count = EXCLUDED.count, reasons = EXCLUDED.reasons, updated_at = NOW()`,
    [
      activeBotId,
      String(groupId),
      String(userId),
      Number(warning?.count || 0),
      JSON.stringify(warning?.entries || []),
    ]
  );
}

function mirrorModerator(userId, enabled = true) {
  return enabled
    ? query(
      `INSERT INTO sudoers (bot_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (bot_id, user_id) DO NOTHING`,
      [activeBotId, String(userId)]
    )
    : query(
      'DELETE FROM sudoers WHERE bot_id = $1 AND user_id = $2',
      [activeBotId, String(userId)]
    );
}

function mirrorMutedUser(groupId, userId, muted = true) {
  return muted
    ? query(
      `INSERT INTO muted_users (bot_id, group_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (bot_id, group_id, user_id) DO NOTHING`,
      [activeBotId, String(groupId), String(userId)]
    )
    : query(
      `DELETE FROM muted_users
       WHERE bot_id = $1 AND group_id = $2 AND user_id = $3`,
      [activeBotId, String(groupId), String(userId)]
    );
}

function mirrorKV(namespace, key, value) {
  return query(
    `INSERT INTO kv_store (bot_id, namespace, key, value)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (bot_id, namespace, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [activeBotId, String(namespace), String(key), JSON.stringify(value)]
  );
}

function deleteKV(namespace, key) {
  return query(
    'DELETE FROM kv_store WHERE bot_id = $1 AND namespace = $2 AND key = $3',
    [activeBotId, String(namespace), String(key)]
  );
}

function mirrorProfile(botProfileId, userId, profile) {
  return query(
    `INSERT INTO chatbot_profiles (bot_id, profile_bot_id, user_id, profile)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (bot_id, profile_bot_id, user_id)
     DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
    [activeBotId, String(botProfileId || 'default'), String(userId), JSON.stringify(profile || {})]
  );
}

// Direct auth-state mirror. This user-selected mode stores the verified
// SQLite auth rows in a dedicated remote table and uses no encryption key.
function mirrorAuthState(snapshot) {
  const state = snapshot || {};
  return query(
    `INSERT INTO session_auth_state (bot_id, session_creds, session_keys, session_auth_meta)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
     ON CONFLICT (bot_id)
     DO UPDATE SET
       session_creds = EXCLUDED.session_creds,
       session_keys = EXCLUDED.session_keys,
       session_auth_meta = EXCLUDED.session_auth_meta,
       updated_at = NOW()`,
    [
      activeBotId,
      JSON.stringify(Array.isArray(state.sessionCreds) ? state.sessionCreds : []),
      JSON.stringify(Array.isArray(state.sessionKeys) ? state.sessionKeys : []),
      JSON.stringify(Array.isArray(state.sessionAuthMeta) ? state.sessionAuthMeta : []),
    ]
  ).then((result) => {
    if (!result) return result;
    // Remove the previous implementation's stale auth record only after the
    // direct auth state has been written successfully.
    return deleteLegacyAuthRecord().then(() => result);
  });
}

async function fetchAuthState() {
  const result = await query(
    `SELECT session_creds, session_keys, session_auth_meta, updated_at
     FROM session_auth_state
     WHERE bot_id = $1
     LIMIT 1`,
    [activeBotId]
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  return {
    snapshot: {
      version: 1,
      createdAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
      sessionCreds: row.session_creds,
      sessionKeys: row.session_keys,
      sessionAuthMeta: row.session_auth_meta,
    },
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
    source: 'postgres',
  };
}

function deleteAuthState() {
  return query('DELETE FROM session_auth_state WHERE bot_id = $1', [activeBotId]);
}

// Compatibility cleanup only. This record is never read as auth state by this
// version; it is removed after a successful direct mirror or deliberate clear.
function deleteLegacyAuthRecord() {
  return query(
    'DELETE FROM bot_configs WHERE bot_id = $1 AND key = $2',
    [activeBotId, LEGACY_AUTH_RECORD_KEY]
  );
}

function restoreIntoSQLite(db) {
  if (!ready || !pool || !db) return Promise.resolve({ restored: 0, skipped: 'pg_unavailable' });

  return (async () => {
    let restored = 0;
    const result = await pool.query(
      `SELECT table_name, payload
       FROM june_restore_snapshot($1)`,
      [activeBotId]
    );

    if (!result?.rows) return { restored: 0, skipped: 'no_remote_rows' };

    const restore = db.transaction(() => {
      for (const row of result.rows) {
        const payload = row.payload || {};
        if (row.table_name === 'bot_configs') {
          // A legacy auth record is never restored as an ordinary bot setting.
          if (payload.key === LEGACY_AUTH_RECORD_KEY) continue;
          const exists = db.prepare('SELECT 1 FROM bot_settings WHERE key = ?').get(payload.key);
          if (!exists) {
            db.prepare('INSERT INTO bot_settings (key, value) VALUES (?, ?)')
              .run(payload.key, JSON.stringify(payload.value));
            restored++;
          }
        } else if (row.table_name === 'group_stats') {
          const exists = db.prepare(
            'SELECT 1 FROM group_stats WHERE group_id = ? AND date = ?'
          ).get(payload.group_id, payload.stat_date);
          if (!exists) {
            db.prepare(
              'INSERT INTO group_stats (group_id, date, data) VALUES (?, ?, ?)'
            ).run(payload.group_id, payload.stat_date, JSON.stringify(payload.data || {}));
            restored++;
          }
        } else if (row.table_name === 'group_features' && payload.feature === 'group-settings') {
          const exists = db.prepare('SELECT 1 FROM groups WHERE group_id = ?').get(payload.group_id);
          if (!exists) {
            db.prepare('INSERT INTO groups (group_id, settings) VALUES (?, ?)')
              .run(payload.group_id, JSON.stringify(payload.config || {}));
            restored++;
          }
        } else if (row.table_name === 'warnings') {
          const exists = db.prepare(
            'SELECT 1 FROM warnings WHERE group_id = ? AND user_id = ?'
          ).get(payload.group_id, payload.user_id);
          if (!exists) {
            db.prepare(
              'INSERT INTO warnings (group_id, user_id, count, entries) VALUES (?, ?, ?, ?)'
            ).run(
              payload.group_id,
              payload.user_id,
              Number(payload.count || 0),
              JSON.stringify(payload.reasons || [])
            );
            restored++;
          }
        } else if (row.table_name === 'sudoers') {
          const exists = db.prepare('SELECT 1 FROM moderators WHERE user_id = ?').get(payload.user_id);
          if (!exists) {
            db.prepare('INSERT INTO moderators (user_id) VALUES (?)').run(payload.user_id);
            restored++;
          }
        } else if (row.table_name === 'kv_store') {
          if (payload.namespace === 'runtime_telemetry' && payload.value?.eventType) {
            const event = payload.value;
            const exists = db.prepare(
              'SELECT 1 FROM runtime_telemetry WHERE event_type = ? AND event_key = ?'
            ).get(event.eventType, event.eventKey);
            if (!exists) {
              db.prepare(`
                INSERT INTO runtime_telemetry
                  (event_type, event_key, payload, count, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(
                event.eventType,
                event.eventKey,
                JSON.stringify(event.payload || {}),
                Number(event.count || 1),
                Number(event.firstSeen || Date.now()),
                Number(event.lastSeen || Date.now())
              );
              restored++;
            }
            continue;
          }
          const exists = db.prepare(
            'SELECT 1 FROM kv_store WHERE namespace = ? AND key = ?'
          ).get(payload.namespace, payload.key);
          if (!exists) {
            db.prepare(
              'INSERT INTO kv_store (namespace, key, value) VALUES (?, ?, ?)'
            ).run(payload.namespace, payload.key, JSON.stringify(payload.value));
            restored++;
          }
        } else if (row.table_name === 'chatbot_profiles') {
          const exists = db.prepare(
            'SELECT 1 FROM chat_profiles WHERE bot_id = ? AND user_id = ?'
          ).get(payload.profile_bot_id, payload.user_id);
          if (!exists) {
            db.prepare(
              'INSERT INTO chat_profiles (bot_id, user_id, profile) VALUES (?, ?, ?)'
            ).run(payload.profile_bot_id, payload.user_id, JSON.stringify(payload.profile || {}));
            restored++;
          }
        } else if (row.table_name === 'users') {
          const exists = db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(payload.user_id);
          if (!exists) {
            db.prepare('INSERT INTO users (user_id, data) VALUES (?, ?)')
              .run(payload.user_id, JSON.stringify(payload.data || {}));
            restored++;
          }
        } else if (row.table_name === 'muted_users') {
          const exists = db.prepare(
            'SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?'
          ).get(payload.group_id, payload.user_id);
          if (!exists) {
            db.prepare(
              'INSERT INTO muted_users (group_id, user_id) VALUES (?, ?)'
            ).run(payload.group_id, payload.user_id);
            restored++;
          }
        } else if (row.table_name === 'antidelete_messages') {
          const exists = db.prepare(
            'SELECT 1 FROM antidelete_messages WHERE chat_id = ? AND message_id = ?'
          ).get(payload.chat_id, payload.message_id);
          if (!exists) {
            db.prepare(
              'INSERT INTO antidelete_messages (chat_id, message_id, payload, stored_at) VALUES (?, ?, ?, ?)'
            ).run(
              payload.chat_id,
              payload.message_id,
              JSON.stringify(payload.payload || {}),
              Number(payload.stored_at || Date.now())
            );
            restored++;
          }
        } else if (row.table_name === 'antidelete_statuses') {
          const exists = db.prepare(
            'SELECT 1 FROM antidelete_statuses WHERE status_id = ?'
          ).get(payload.status_id);
          if (!exists) {
            db.prepare(
              'INSERT INTO antidelete_statuses (status_id, payload, stored_at) VALUES (?, ?, ?)'
            ).run(
              payload.status_id,
              JSON.stringify(payload.payload || {}),
              Number(payload.stored_at || Date.now())
            );
            restored++;
          }
        } else if (row.table_name === 'lid_map') {
          const exists = db.prepare(
            'SELECT 1 FROM lid_map WHERE direction = ? AND user = ?'
          ).get(payload.direction, payload.user);
          if (!exists) {
            db.prepare(
              'INSERT INTO lid_map (direction, user, value, updated_at) VALUES (?, ?, ?, ?)'
            ).run(
              payload.direction,
              payload.user,
              payload.value,
              Number(payload.updated_at || Date.now())
            );
            restored++;
          }
        }
      }
    });

    restore();
    return { restored, botId: activeBotId };
  })().catch((error) => {
    lastError = error.message;
    console.warn(`[PG] Restore skipped: ${error.message}`);
    return { restored: 0, error: error.message };
  });
}

async function close() {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  ready = false;
  schemaReady = false;
  try { await activePool.end(); } catch (_) {}
}

const KIND_TABLE = {
  'bot-setting':        { table: 'bot_configs',        where: 'bot_id = $1 AND key != $2', extra: [LEGACY_AUTH_RECORD_KEY] },
  'group-settings':     { table: 'group_features',      where: "bot_id = $1 AND feature = 'group-settings'", extra: [] },
  'group-stat':         { table: 'group_stats',         where: 'bot_id = $1', extra: [] },
  'user':               { table: 'users',               where: 'bot_id = $1', extra: [] },
  'warning':            { table: 'warnings',            where: 'bot_id = $1', extra: [] },
  'moderator':          { table: 'sudoers',             where: 'bot_id = $1', extra: [] },
  'muted-user':         { table: 'muted_users',         where: 'bot_id = $1', extra: [] },
  'kv':                 { table: 'kv_store',            where: 'bot_id = $1', extra: [] },
  'antidelete-message': { table: 'antidelete_messages', where: 'bot_id = $1', extra: [] },
  'antidelete-status':  { table: 'antidelete_statuses', where: 'bot_id = $1', extra: [] },
  'chat-profile':       { table: 'chatbot_profiles',    where: 'bot_id = $1', extra: [] },
  'lid-map':            { table: 'lid_map',             where: 'bot_id = $1', extra: [] },
};

// Bulk-delete every remote record of a given kind for the active bot.
// Used by the database reset so the remote mirror does not re-seed local data
// on the next restart (remote restore only fills "missing" local rows).
async function clearKind(kind) {
  if (!ready || !pool) return { ok: false, reason: 'unavailable' };
  const spec = KIND_TABLE[kind];
  if (!spec) return { ok: false, reason: 'unknown-kind' };
  try {
    const params = [activeBotId, ...(spec.extra || [])];
    const res = await query(`DELETE FROM ${spec.table} WHERE ${spec.where}`, params);
    return { ok: true, deleted: res?.rowCount || 0 };
  } catch (error) {
    lastError = error?.message || String(error);
    return { ok: false, reason: lastError };
  }
}

module.exports = {
  init,
  query,
  close,
  getBotId,
  setBotId,
  buildBotId,
  getStatus,
  mirrorBotSetting,
  mirrorGroupSettings,
  mirrorGroupStat,
  mirrorUser,
  mirrorAntideleteMessage,
  deleteAntideleteMessage,
  mirrorAntideleteStatus,
  deleteAntideleteStatus,
  mirrorLidMap,
  mirrorWarning,
  mirrorModerator,
  mirrorMutedUser,
  mirrorKV,
  deleteKV,
  mirrorProfile,
  mirrorAuthState,
  fetchAuthState,
  deleteAuthState,
  deleteLegacyAuthRecord,
  restoreIntoSQLite,
  clearKind,
};
