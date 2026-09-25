'use strict';

/**
 * Group activity statistics.
 *
 * The public functions stay synchronous for compatibility with handler.js and
 * the commands that read activity reports. Message counts are accumulated in
 * memory and only the dirty group/day records are written out, on a five second
 * timer.
 *
 * Bot isolation
 * -------------
 * The cache is keyed by bot as well as group, and every database call is made
 * inside database.runAsBot(...). That second part is not decorative: the flush
 * timer below fires on its own, outside any message's async context, so
 * database.currentBotId() would resolve to the default bot and pour every bot's
 * activity into one file. Storing the bot id alongside the dirty record and
 * re-entering the context at write time is what keeps them apart.
 */

const database = require('../database');

const FLUSH_INTERVAL_MS = 5_000;
const SEP = '\u0000';

// Map<scope, Map<YYYY-MM-DD, { total, users, hours }>> where scope is `botId\0groupId`.
const cache = new Map();
// Map<scope, Set<YYYY-MM-DD>> — records awaiting the next save.
const dirtyDays = new Map();
// Only needed for the tiny startup window before database.ready resolves.
const preReadyDays = new Map();
const fullyLoadedScopes = new Set();

let databaseReady = false;
let flushInProgress = false;
let lastDatabaseErrorAt = 0;

function todayKey() {
  // Preserve the old utility's UTC date boundary.
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  // Preserve the old utility's server-local hour bucket.
  return new Date().getHours().toString();
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normaliseCounterMap(value) {
  const output = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;

  for (const [key, count] of Object.entries(value)) {
    const safeCount = toCount(count);
    if (safeCount > 0) output[String(key)] = safeCount;
  }

  return output;
}

function normaliseStat(value) {
  const stat = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    total: toCount(stat.total),
    users: normaliseCounterMap(stat.users),
    hours: normaliseCounterMap(stat.hours),
  };
}

function mergeStats(persisted, inMemory) {
  const merged = normaliseStat(persisted);
  const pending = normaliseStat(inMemory);

  merged.total += pending.total;
  for (const [jid, count] of Object.entries(pending.users)) {
    merged.users[jid] = (merged.users[jid] || 0) + count;
  }
  for (const [hour, count] of Object.entries(pending.hours)) {
    merged.hours[hour] = (merged.hours[hour] || 0) + count;
  }

  return merged;
}

function normaliseGroupId(groupId) {
  return String(groupId || '');
}

function normaliseDate(date) {
  return String(date || '');
}

function scopeOf(botId, groupId) {
  return `${botId}${SEP}${normaliseGroupId(groupId)}`;
}

function splitScope(scope) {
  const at = scope.indexOf(SEP);
  return at === -1
    ? [database.DEFAULT_BOT_ID, scope]
    : [scope.slice(0, at), scope.slice(at + 1)];
}

function getScopeDays(scope) {
  let days = cache.get(scope);
  if (!days) {
    days = new Map();
    cache.set(scope, days);
  }
  return days;
}

function markDay(map, scope, date) {
  const day = normaliseDate(date);
  let dates = map.get(scope);
  if (!dates) {
    dates = new Set();
    map.set(scope, dates);
  }
  dates.add(day);
}

function reportDatabaseError(error) {
  // Do not turn one database outage into a console line for every group message.
  const now = Date.now();
  if (now - lastDatabaseErrorAt < 60_000) return;
  lastDatabaseErrorAt = now;
  console.error('[groupStats] database error:', error?.message || error);
}

function loadDay(botId, groupId, date) {
  const scope = scopeOf(botId, groupId);
  const day = normaliseDate(date);
  const days = getScopeDays(scope);

  if (days.has(day)) return days.get(day);
  if (!databaseReady) return null;

  try {
    const stored = database.runAsBot(botId, () => database.getGroupStat(groupId, day));
    if (stored === null) return null;

    const stat = normaliseStat(stored);
    days.set(day, stat);
    return stat;
  } catch (error) {
    reportDatabaseError(error);
    return null;
  }
}

function ensureDay(botId, groupId, date) {
  const scope = scopeOf(botId, groupId);
  const day = normaliseDate(date);
  const existing = loadDay(botId, groupId, day);
  if (existing) return existing;

  const stat = { total: 0, users: {}, hours: {} };
  getScopeDays(scope).set(day, stat);
  if (!databaseReady) markDay(preReadyDays, scope, day);
  return stat;
}

function loadAllGroupDays(botId, groupId) {
  const scope = scopeOf(botId, groupId);
  const days = getScopeDays(scope);

  if (!databaseReady || fullyLoadedScopes.has(scope)) return days;

  try {
    const rows = database.runAsBot(botId, () => database.getAllGroupStats(groupId));
    for (const row of rows) {
      const day = normaliseDate(row.date);
      // Keep a newer in-memory record if messages have arrived since startup.
      if (!days.has(day)) days.set(day, normaliseStat(row.data));
    }
    fullyLoadedScopes.add(scope);
  } catch (error) {
    reportDatabaseError(error);
  }

  return days;
}

function reconcilePreReadyDays() {
  if (!databaseReady || preReadyDays.size === 0) return;

  for (const [scope, dates] of preReadyDays) {
    const [botId, groupId] = splitScope(scope);
    const days = getScopeDays(scope);

    for (const date of dates) {
      const inMemory = days.get(date);
      if (!inMemory) continue;

      try {
        const stored = database.runAsBot(botId, () => database.getGroupStat(groupId, date));
        if (stored !== null) days.set(date, mergeStats(stored, inMemory));
      } catch (error) {
        reportDatabaseError(error);
      }
    }
  }

  preReadyDays.clear();
}

function flushGroupStats() {
  if (!databaseReady || flushInProgress || dirtyDays.size === 0) return 0;

  flushInProgress = true;
  let saved = 0;

  try {
    for (const [scope, dates] of [...dirtyDays.entries()]) {
      const [botId, groupId] = splitScope(scope);
      const days = getScopeDays(scope);

      for (const date of [...dates]) {
        const stat = days.get(date);
        if (!stat) {
          dates.delete(date);
          continue;
        }

        try {
          // Re-enter the owning bot's context: this runs from a timer, so
          // currentBotId() on its own would not know who these counts belong to.
          database.runAsBot(botId, () => database.saveGroupStat(groupId, date, stat));
          dates.delete(date);
          saved += 1;
        } catch (error) {
          // Keep the record dirty; the next scheduled flush retries it.
          reportDatabaseError(error);
        }
      }

      if (dates.size === 0) dirtyDays.delete(scope);
    }
  } finally {
    flushInProgress = false;
  }

  return saved;
}

// ── Public API ────────────────────────────────────────────────────────────────
// Each entry point resolves the bot from the ambient context. Calls made from
// handler.js land inside index.js's database.runAsBot(...) wrapper, so they
// resolve correctly; calls made anywhere else fall back to the default bot.

function addMessage(groupId, senderId) {
  const id = normaliseGroupId(groupId);
  const sender = String(senderId || '');
  if (!id || !sender) return;

  const botId = database.currentBotId();
  const date = todayKey();
  const stat = ensureDay(botId, id, date);

  stat.total += 1;
  stat.users[sender] = (stat.users[sender] || 0) + 1;

  const hour = hourKey();
  stat.hours[hour] = (stat.hours[hour] || 0) + 1;

  markDay(dirtyDays, scopeOf(botId, id), date);
}

function getStats(groupId) {
  return loadDay(database.currentBotId(), groupId, todayKey());
}

function getActiveUsers(groupId, limit = 15) {
  const totals = {};

  for (const stat of loadAllGroupDays(database.currentBotId(), groupId).values()) {
    for (const [jid, count] of Object.entries(stat.users || {})) {
      totals[jid] = (totals[jid] || 0) + toCount(count);
    }
  }

  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  return Object.entries(totals)
    .map(([jid, count]) => ({ jid, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, safeLimit);
}

function getInactiveUsers(groupId, allParticipants) {
  const active = new Set();

  for (const stat of loadAllGroupDays(database.currentBotId(), groupId).values()) {
    for (const jid of Object.keys(stat.users || {})) active.add(jid);
  }

  return Array.isArray(allParticipants)
    ? allParticipants.filter(jid => !active.has(jid))
    : [];
}

setInterval(flushGroupStats, FLUSH_INTERVAL_MS).unref();

// index.js calls this hook during graceful shutdown, before database.flush()
// writes the store out. The prepended exit listener is a fallback for a direct
// process.exit() — being prepended, it runs before database.js's own exit
// handler, so the counts reach the store in time to be written.
global.__JUNE_FLUSH_GROUP_STATS = flushGroupStats;
process.prependListener('exit', flushGroupStats);

database.ready
  .then(() => {
    databaseReady = true;
    reconcilePreReadyDays();
    flushGroupStats();
  })
  .catch(() => {
    // index.js owns startup-failure reporting; keep this utility silent here.
  });

module.exports = {
  addMessage,
  getStats,
  getActiveUsers,
  getInactiveUsers,
  flush: flushGroupStats,
  flushGroupStats,
};
