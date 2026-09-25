'use strict';

/**
 * Per-bot JSON data store.
 *
 *   one file per bot  ->  data/bots/<botId>.json
 *
 * WHY THIS REPLACED SQLITE
 *   The old design gave every bot its own SQLite file by clearing the require
 *   cache and re-requiring this module per bot. That never actually worked:
 *   ~180 files capture `require('../database')` at module load, which happens
 *   before any bot exists, so they all kept pointing at the first instance.
 *   Every bot silently shared one database, and index.js mutated require.cache
 *   on every incoming message to paper over it — a cross-bot race.
 *
 *   Here there is exactly ONE module instance. Which bot a call belongs to is
 *   resolved at CALL time from an AsyncLocalStorage context that index.js opens
 *   around each bot's work. So the same `database.getBotSetting('prefix')`
 *   returns the right bot's value regardless of who calls it or how many bots
 *   are live.
 *
 *   AsyncLocalStorage rather than global.__BOT_ID__ because it propagates
 *   correctly across await points: two bots handling messages concurrently
 *   cannot overwrite each other's context.
 *
 * DURABILITY
 *   Writes are debounced and atomic (temp file + rename), so a crash mid-write
 *   cannot leave a truncated JSON file. `flush()` is synchronous and is called
 *   from index.js's shutdown handler.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { resolveTimeZone } = require('./utils/tzResolver');

const DATA_DIR = path.resolve(process.env.JUNE_DATA_DIR || path.join(__dirname, 'data', 'bots'));
const SCHEMA_VERSION = 1;

// Bots default to this id when a call happens outside any bot context
// (boot-time reads, the platform's own web requests, timers).
const DEFAULT_BOT_ID = 'main';

const FLUSH_DEBOUNCE_MS = Math.max(25, Number(process.env.JUNE_DB_FLUSH_MS) || 250);

// ── Bot context ───────────────────────────────────────────────────────────
const als = new AsyncLocalStorage();

/** Run `fn` (sync or async) with every database call attributed to `botId`. */
function runAsBot(botId, fn) {
  return als.run({ botId: String(botId || DEFAULT_BOT_ID) }, fn);
}

/** The bot the current call belongs to. Falls back to DEFAULT_BOT_ID. */
function currentBotId() {
  return als.getStore()?.botId || DEFAULT_BOT_ID;
}

// ── Static application constants ──────────────────────────────────────────
const VERSION = require('./package.json').version;
const SESSION_NAME = '';

const MESSAGES = {
  wait: '⏳ Please wait...',
  success: '✅ Success!',
  error: '❌ Error occurred!',
  ownerOnly: '👑 This command is only for bot owner!',
  adminOnly: '🛡️ This command is only for group admins!',
  groupOnly: '👥 This command can only be used in groups!',
  privateOnly: '💬 This command can only be used in private chat!',
  botAdminNeeded: '🚫 Bot needs to be admin to execute this command!',
  invalidCommand: '❓ Invalid command! Type .menu for help',
};

const SOCIAL = {
  github: 'https://github.com/Vinpink2/June-Ultra',
  instagram: 'https://instagram.com/activator_negative',
  youtube: 'http://youtube.com/@suprem_e_lord',
};

const API_KEYS = { openai: '', deepai: '', remove_bg: '' };

const ANTICALL_PRESETS = [
  { id: 1, emoji: '📵', message: "Sorry, I don't accept WhatsApp calls. Please send a message." },
  { id: 2, emoji: '💬', message: "I'm currently unavailable. Kindly text me instead." },
  { id: 3, emoji: '🚫', message: 'Calls are disabled. Please chat with me here.' },
  { id: 4, emoji: '🤖', message: "This account doesn't accept calls. Send a message to continue." },
  { id: 5, emoji: '🌙', message: "Do Not Disturb. I'll reply when available." },
];

const BOT_SETTINGS_DEFAULTS = {
  // Empty by design. A fresh install has no owner: whoever pairs the bot is
  // recognised through msg.key.fromMe and can claim it with .setownernumber.
  owners: [],
  // 'auto' when claimed from the paired account at connection.open,
  // 'command' when set with .setownernumber. An auto-claimed owner may be
  // refreshed on re-pair; a command-set one must never be replaced silently.
  ownerSource: null,
  ownerName: [],

  botName: 'June-X Ultra',
  prefix: '.',
  autoRead: true,
  autoReact: false,
  mode: 'public',
  loginMethod: null,
  selfMode: false,

  fontStyle: 'normal',
  timezone: 'Africa/Nairobi',
  maxWarnings: 3,
  packname: 'June-X Ultra',
  author: 'June-X Ultra',
  stickerAuthor: 'June-X Ultra',

  alwaysOnline: false,
  readReceipts: 'off',
  autoReadMode: 'off',
  autoBio: false,
  autoSticker: false,
  autoTyping: false,
  autoRecording: false,
  autoRecordType: false,
  newsletterJid: '',

  autoReactSource: 'bot',      // bot | all
  autoReactTarget: 'both',     // dms | groups | both
  autoReactFixedEmoji: '💙',
  autoReactRandomMode: false,
  autoReactMode: 'bot',

  autoStatusView: false,
  autoStatusReact: false,
  autoStatusEmoji: '💙',
  autoStatusEmojiPool: [],
  autoStatusRandomEmoji: false,
  autoDownloadStatus: {},

  // Read per incoming call by handler.js; .anticall / .anticallmsg change them.
  // They are bot-wide, but getDefaultGroupSettings() merges them back over the
  // group template so existing group-settings readers keep working.
  anticall: false,
  anticallAction: 'decline',
  anticallMessage: null,
  anticallNotify: true,

  // Menu presentation.
  menuStyle: '2',
  menuShowMemory: true,
  menuShowUptime: true,
  menuShowPluginCount: true,
  menuShowProgressBar: true,
  menuImageCustom: false,
  menuImageData: null,
};

const DEFAULT_GROUP_SETTINGS = {
  antilink: false, antilinkAction: 'delete',
  antitag: false, antitagAction: 'delete',
  antiviewonce: false,
  antibot: false,
  anticall: false, anticallAction: 'decline', anticallMessage: null, anticallNotify: true,
  antigroupmention: false, antigroupmentionAction: 'delete',
  antigroupstatus: false, antigroupstatusAction: 'delete',
  welcome: false,
  welcomeMessage: ' 𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @user 👋\n Member count: #memberCount\n 𝚃𝙸𝙼𝙴: time⏰\n\n\n*@user* Welcome to *@group*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\ngroupDesc\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ botName*',
  welcomeNoPP: false,
  goodbye: false,
  goodbyeMessage: 'Goodbye @user 👋 We will never miss you!',
  stickerActions: {},
  antitagadmins: false, antitagadminsAction: 'warn',
  antiall: false,
  antiforward: false, antiforwardLimit: 3,
  antiSpam: false, antiSpamLimit: 5, antiSpamWindow: 5, antiSpamAction: 'delete',
  nsfw: false,
  detect: false,
  chatbot: false,
  autosticker: false,
  antiimage: false, antiimageAction: 'delete',
  antisticker: false, antistickerAction: 'delete',
  antiaudio: false, antiaudioAction: 'delete',
  antibadword: false, antibadwordAction: 'warn', badwords: [],
  anticontact: false, anticontactAction: 'delete',
  antigif: false, antigifAction: 'delete',
};

const ANTICALL_KEYS = ['anticall', 'anticallAction', 'anticallMessage', 'anticallNotify'];

const VALID_BOT_MODES = ['public', 'private', 'group', 'pm'];
const BOT_MODE_ALIASES = Object.freeze({
  public: 'public', private: 'private', group: 'group', pm: 'pm',
  silent: 'private', restricted: 'private', groups: 'group', grp: 'group',
  dms: 'pm', dm: 'pm', inbox: 'pm', priv: 'private', pub: 'public',
});

// ── Storage ───────────────────────────────────────────────────────────────

function emptyStore() {
  return {
    version: SCHEMA_VERSION,
    settings: {},        // bot-wide key/value
    groups: {},          // groupId -> settings patch
    users: {},           // userId  -> free-form data
    warnings: {},        // groupId -> userId -> { count, entries[] }
    moderators: [],      // userIds (sudo)
    muted: {},           // groupId -> [userIds]
    groupStats: {},      // groupId -> YYYY-MM-DD -> { total, users, hours }
    lidMap: { lidToPn: {}, pnToLid: {} },
    kv: {},              // namespace -> key -> value
  };
}

const stores = new Map();   // botId -> data
const dirty = new Set();    // botIds awaiting a write
const timers = new Map();   // botId -> Timeout
let shuttingDown = false;

function filePath(botId) {
  // botId comes from the registry / auth folder name. Keep it filesystem-safe.
  const safe = String(botId).replace(/[^A-Za-z0-9._-]/g, '_') || DEFAULT_BOT_ID;
  return path.join(DATA_DIR, `${safe}.json`);
}

function load(botId) {
  const existing = stores.get(botId);
  if (existing) return existing;

  let data = emptyStore();
  const file = filePath(botId);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        // Merge over the empty shape so a file from an older/newer version,
        // or one hand-edited down to a single section, still loads.
        data = { ...emptyStore(), ...parsed };
        data.lidMap = { ...emptyStore().lidMap, ...(parsed.lidMap || {}) };
      }
    }
  } catch (error) {
    // Never lose the bot over a corrupt file: quarantine it and start clean.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      console.error(`[DB] ${botId}: unreadable JSON quarantined, starting fresh (${error.message})`);
    } catch (_) {
      console.error(`[DB] ${botId}: unreadable JSON, starting fresh (${error.message})`);
    }
    data = emptyStore();
  }

  stores.set(botId, data);
  return data;
}

/** Data for the bot the current call belongs to. */
function store() {
  return load(currentBotId());
}

function writeNow(botId) {
  const data = stores.get(botId);
  if (!data) return false;
  const file = filePath(botId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);   // atomic on POSIX
    dirty.delete(botId);
    return true;
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    console.error(`[DB] ${botId}: write failed (${error.message})`);
    return false;
  }
}

function markDirty(botId = currentBotId()) {
  dirty.add(botId);
  if (shuttingDown) { writeNow(botId); return; }
  if (timers.has(botId)) return;
  const t = setTimeout(() => {
    timers.delete(botId);
    writeNow(botId);
  }, FLUSH_DEBOUNCE_MS);
  t.unref?.();
  timers.set(botId, t);
}

/** Persist everything immediately. Synchronous; safe to call on shutdown. */
function flush() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const botId of [...dirty]) writeNow(botId);
  return dirty.size === 0;
}

const clone = (v) => (v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// ── Bot settings ──────────────────────────────────────────────────────────

const getBotSetting = (key) => {
  const s = store().settings;
  return clone(Object.prototype.hasOwnProperty.call(s, key) ? s[key] : BOT_SETTINGS_DEFAULTS[key]);
};

const setBotSetting = (key, value) => {
  store().settings[String(key)] = value;
  markDirty();
  return true;
};

const updateBotSettings = (updates = {}) => {
  const s = store().settings;
  for (const [key, value] of Object.entries(updates)) s[key] = value;
  markDirty();
  return true;
};

/** Only the keys explicitly written for this bot (no defaults merged in). */
const getStoredBotSettings = () => clone(store().settings);

/** Defaults merged with stored values. */
const getAllBotSettings = () => ({ ...clone(BOT_SETTINGS_DEFAULTS), ...clone(store().settings) });

// Nothing is memoised across calls any more — the store is already in memory —
// but the name is kept because callers use it after bulk edits.
const clearBotSettingsCache = () => true;

// ── Owners ────────────────────────────────────────────────────────────────

const normaliseOwner = (value) => String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');

const getOwners = () => {
  const stored = getBotSetting('owners');
  return Array.isArray(stored) ? stored.map(normaliseOwner).filter(Boolean) : [];
};

// Replaces the whole list. `source` records how it was established.
const setOwners = (owners, source = 'command') => {
  const list = (Array.isArray(owners) ? owners : [owners]).map(normaliseOwner).filter(Boolean);
  setBotSetting('owners', [...new Set(list)]);
  setBotSetting('ownerSource', source === 'auto' ? 'auto' : 'command');
  return true;
};

const getOwnerSource = () => getBotSetting('ownerSource');

let runtimeOwnerName = null;
const setRuntimeOwnerName = (name) => {
  const v = typeof name === 'string' ? name.trim() : '';
  runtimeOwnerName = v || null;
  return runtimeOwnerName;
};

const getOwnerNames = () => {
  const stored = getBotSetting('ownerName');
  const list = (Array.isArray(stored) ? stored : [stored])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (list.length) return list;
  if (runtimeOwnerName) return [runtimeOwnerName];
  const owners = getOwners();
  return owners.length ? owners : ['Bot Owner'];
};

const setOwnerNames = (value) => {
  setBotSetting('ownerName', Array.isArray(value) ? value : [value]);
  return true;
};

// ── Bot mode ──────────────────────────────────────────────────────────────

const normalizeBotMode = (mode) => BOT_MODE_ALIASES[String(mode || '').trim().toLowerCase()] || null;
const getBotMode = () => normalizeBotMode(getBotSetting('mode')) || 'public';
const setBotMode = (mode) => {
  const normalized = normalizeBotMode(mode);
  if (!normalized) throw new Error(`Invalid mode: ${mode}`);
  setBotSetting('mode', normalized);
  return normalized;
};

// ── Timezone ──────────────────────────────────────────────────────────────
// Priority: stored value ('auto' = detect) -> TIMEZONE env -> detected from a
// phone number (owner first, then the paired account) -> shipped default.
const _tzPayload = () => ({
  storedTz: getBotSetting('timezone'),
  envTz: process.env.TIMEZONE,
  ownerNumber: getOwners()[0] || '',
  botNumber: [
    (() => { try { return global.currentSock?.user?.id ? String(global.currentSock.user.id).split('@')[0].split(':')[0] : null; } catch (_) { return null; } })(),
    (() => { try { return global.phoneNumber ? String(global.phoneNumber).replace(/\D/g, '') : null; } catch (_) { return null; } })(),
  ].filter(Boolean),
  defaultTz: BOT_SETTINGS_DEFAULTS.timezone,
});
const getTimeZone = () => resolveTimeZone(_tzPayload()).tz;
const getTimeZoneSource = () => resolveTimeZone(_tzPayload()).source;

// ── Group settings ────────────────────────────────────────────────────────

const getDefaultGroupSettings = () => {
  // Deep copy: callers mutate nested values (stickerActions[x] = ...), and a
  // shallow spread would share those objects with the template.
  const merged = JSON.parse(JSON.stringify(DEFAULT_GROUP_SETTINGS));
  for (const key of ANTICALL_KEYS) merged[key] = getBotSetting(key);
  return merged;
};

const getStoredGroupSettings = (groupId) => clone(store().groups[String(groupId)] || {});

const getGroupSettings = (groupId) => ({
  ...getDefaultGroupSettings(),
  ...getStoredGroupSettings(groupId),
});

// Callers submit a small patch (e.g. `{ antilink: true }`); merge it with the
// stored document so one feature command cannot erase another's settings.
const updateGroupSettings = (groupId, updates = {}) => {
  const key = String(groupId);
  const patch = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
  store().groups[key] = { ...(store().groups[key] || {}), ...clone(patch) };
  markDirty();
  return getGroupSettings(key);
};

const isAntiAllEnabled = (groupId) => getGroupSettings(groupId).antiall === true;
const setAntiAllEnabled = (groupId, enabled) => {
  const value = enabled === true;
  updateGroupSettings(groupId, { antiall: value });
  return value;
};

// ── Users ─────────────────────────────────────────────────────────────────

const getUser = (userId) => clone(store().users[String(userId)] || {});
const updateUser = (userId, data = {}) => {
  store().users[String(userId)] = clone(data);
  markDirty();
  return true;
};

// ── Warnings ──────────────────────────────────────────────────────────────

const getWarnings = (groupId, userId) => {
  const rec = store().warnings[String(groupId)]?.[String(userId)];
  return rec ? { count: rec.count || 0, entries: clone(rec.entries || []) } : { count: 0, entries: [] };
};

const addWarning = (groupId, userId, reason = '') => {
  const g = String(groupId), u = String(userId);
  const data = store().warnings;
  data[g] = data[g] || {};
  const current = data[g][u] || { count: 0, entries: [] };
  const entries = [...(current.entries || []), { reason, timestamp: Date.now() }];
  data[g][u] = { count: (current.count || 0) + 1, entries };
  markDirty();
  return data[g][u].count;   // returns the new count, as before
};

const removeWarning = (groupId, userId) => {
  const g = String(groupId), u = String(userId);
  const rec = store().warnings[g]?.[u];
  if (!rec || rec.count <= 0) return 0;
  rec.count -= 1;
  markDirty();
  return rec.count;
};

const clearWarnings = (groupId, userId) => {
  const g = String(groupId);
  const data = store().warnings;
  if (!data[g]) return true;
  if (userId) delete data[g][String(userId)];
  else delete data[g];
  markDirty();
  return true;
};

// ── Moderators (sudo) ─────────────────────────────────────────────────────

const getModerators = () => clone(store().moderators);
const addModerator = (userId) => {
  const id = String(userId);
  if (!store().moderators.includes(id)) { store().moderators.push(id); markDirty(); }
  return true;
};
const removeModerator = (userId) => {
  const id = String(userId);
  store().moderators = store().moderators.filter((m) => m !== id);
  markDirty();
  return true;
};
const isModerator = (userId) => store().moderators.includes(String(userId));

// ── Mutes ─────────────────────────────────────────────────────────────────

const getMutedUsers = (groupId) => clone(store().muted[String(groupId)] || []);
const muteUser = (groupId, userId) => {
  const g = String(groupId), u = String(userId);
  store().muted[g] = store().muted[g] || [];
  if (!store().muted[g].includes(u)) store().muted[g].push(u);
  markDirty();
  return true;
};
const unmuteUser = (groupId, userId) => {
  const g = String(groupId), u = String(userId);
  store().muted[g] = (store().muted[g] || []).filter((x) => x !== u);
  if (store().muted[g].length === 0) delete store().muted[g];
  markDirty();
  return true;
};
const isUserMuted = (groupId, userId) => (store().muted[String(groupId)] || []).includes(String(userId));

// ── Group activity stats ──────────────────────────────────────────────────

const getGroupStat = (groupId, date) => {
  const rec = store().groupStats[String(groupId)]?.[String(date)];
  return rec ? clone(rec) : null;
};

const saveGroupStat = (groupId, date, data) => {
  const g = String(groupId), d = String(date);
  store().groupStats[g] = store().groupStats[g] || {};
  store().groupStats[g][d] = clone(data || {});
  markDirty();
  return true;
};

const getAllGroupStats = (groupId) => {
  const days = store().groupStats[String(groupId)] || {};
  return Object.entries(days).map(([date, data]) => ({ date, data: clone(data) }));
};

// ── LID <-> phone number mapping (WhatsApp rc13) ──────────────────────────

const saveLidMap = (direction, user, value, updatedAt = Date.now()) => {
  const dir = direction === 'pnToLid' ? 'pnToLid' : 'lidToPn';
  store().lidMap[dir][String(user)] = { value: String(value), updatedAt: Number(updatedAt) };
  markDirty();
  return true;
};

const getLidMap = (direction, user) => {
  const dir = direction === 'pnToLid' ? 'pnToLid' : 'lidToPn';
  return store().lidMap[dir]?.[String(user)]?.value || null;
};

const getLidMaps = () => {
  const out = [];
  for (const [direction, entries] of Object.entries(store().lidMap)) {
    for (const [user, rec] of Object.entries(entries || {})) {
      out.push({ direction, user, value: rec.value, updatedAt: rec.updatedAt });
    }
  }
  return out;
};

// ── Generic key/value (escape hatch for future commands) ──────────────────

const getKV = (namespace, key) => clone(store().kv[String(namespace)]?.[String(key)] ?? null);
const setKV = (namespace, key, value) => {
  const ns = String(namespace);
  store().kv[ns] = store().kv[ns] || {};
  store().kv[ns][String(key)] = value;
  markDirty();
  return true;
};
const delKV = (namespace, key) => {
  const ns = store().kv[String(namespace)];
  if (!ns) return false;
  delete ns[String(key)];
  if (Object.keys(ns).length === 0) delete store().kv[String(namespace)];
  markDirty();
  return true;
};
const getAllKV = (namespace) => clone(store().kv[String(namespace)] || {});

// ── Lifecycle ─────────────────────────────────────────────────────────────

let _ready = null;
function initialize() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return true;
}
const ready = Promise.resolve().then(() => {
  _ready = initialize();
  console.log(`[DB] JSON store ready — ${DATA_DIR}`);
  return _ready;
}).catch((error) => {
  console.error(`[DB] Startup failed: ${error.message}`);
  throw error;
});

/** Every bot id that has a file on disk (used to restore/inspect). */
function listBotIds() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json') && !f.includes('.tmp-'))
      .map((f) => f.slice(0, -5));
  } catch (_) { return []; }
}

/** Wipe one bot's data (or the current bot when called with no argument). */
function resetBotData(botId = currentBotId()) {
  const id = String(botId);
  stores.set(id, emptyStore());
  writeNow(id);
  return true;
}

function getDataDir() { return DATA_DIR; }

function shutdownDatabase() {
  shuttingDown = true;
  flush();
  return true;
}

// Last-resort persistence for a direct process.exit(). Writes are debounced, so
// anything dirty in the final 250 ms would otherwise be lost. Registered with
// 'exit' (not SIGINT/SIGTERM) so it also covers exits triggered elsewhere;
// utils/groupstats.js prepends its own exit listener, which means the group
// counters reach the store before this handler writes it out.
process.on('exit', () => {
  shuttingDown = true;
  try { flush(); } catch (_) {}
});

module.exports = {
  ready,

  // bot context
  runAsBot, currentBotId, DEFAULT_BOT_ID, listBotIds, getDataDir,
  botDataFile: filePath,

  // settings
  getBotSetting, setBotSetting, updateBotSettings, getAllBotSettings,
  getStoredBotSettings, clearBotSettingsCache, BOT_SETTINGS_DEFAULTS,

  // owners
  getOwners, setOwners, getOwnerNames, setOwnerNames, getOwnerSource,
  setRuntimeOwnerName,

  // mode + timezone
  getBotMode, setBotMode, VALID_BOT_MODES, getTimeZone, getTimeZoneSource,

  // groups
  getGroupSettings, updateGroupSettings, getStoredGroupSettings,
  getDefaultGroupSettings, DEFAULT_GROUP_SETTINGS,
  isAntiAllEnabled, setAntiAllEnabled,

  // users / warnings / moderators / mutes
  getUser, updateUser,
  getWarnings, addWarning, removeWarning, clearWarnings,
  getModerators, addModerator, removeModerator, isModerator,
  muteUser, unmuteUser, isUserMuted, getMutedUsers,

  // activity
  getGroupStat, saveGroupStat, getAllGroupStats,

  // lid mapping
  saveLidMap, getLidMap, getLidMaps,

  // generic kv
  getKV, setKV, delKV, getAllKV,

  // constants
  MESSAGES, SOCIAL, API_KEYS, ANTICALL_PRESETS, VERSION, SESSION_NAME,

  // lifecycle
  flush, resetBotData, shutdownDatabase,
};
