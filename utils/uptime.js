'use strict';

/**
 * Per-bot uptime that survives a restart.
 *
 * THE PROBLEM
 * -----------
 * Jtest runs every bot in ONE process, so `process.uptime()` is the same number
 * for all of them and resets whenever the process does. The per-bot figure used
 * to come from `bot.connectedAt`, which lives in memory — so a 16-second
 * `.upgrade` swap made a bot that had been online for three days report
 * "29 seconds". From WhatsApp's side that session never ended; only the process
 * did.
 *
 * THE MODEL
 * ---------
 * A session is "socket open → last known alive". Completed sessions accumulate,
 * so the total is:
 *
 *     total = sum(completed sessions) + (current session)
 *
 * Liveness is a heartbeat, not the clock: a session cannot be credited past the
 * last moment the bot was actually seen alive. That is what makes the number
 * honest across a restart — the loader relaunches in seconds, and those seconds
 * are the only ones lost. A longer outage is not silently counted as uptime.
 *
 * Storage is the bot's own JSON store (KV namespace 'uptime', one key), so it
 * inherits per-bot isolation, atomic writes and the exit flush for free.
 *
 * Only the one write per session start plus a heartbeat, so the cost of keeping
 * uptime is a single small key per bot.
 */

const database = require('../database');

const NS = 'uptime';
const KEY = 'state';

/** How often a live bot's liveness stamp is refreshed. 0 disables it. */
function heartbeatMs() {
  const n = Number(process.env.JUNE_UPTIME_HEARTBEAT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/**
 * A session is "current" while its heartbeat is fresh. Two intervals of slack,
 * so one missed beat (a slow tick, a busy event loop) does not look like an
 * outage.
 */
function freshnessMs() {
  const beat = heartbeatMs();
  return (beat === 0 ? 60_000 : beat) * 2;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The stored record, read inside the bot's own database context. */
function readState(botId) {
  return database.runAsBot(botId, () => database.getKV(NS, KEY)) || null;
}

function writeState(botId, state) {
  return database.runAsBot(botId, () => { database.setKV(NS, KEY, state); return true; });
}

/**
 * A socket just opened: close whatever session was open, then start a new one.
 *
 * This is the ONLY place a session is closed, and it is deliberate — a session
 * is ended by the next boot discovering it, which is exactly the case that has
 * no live code to run a cleanup (a killed process, an upgrade restart).
 * `lastAliveAt` is where it is deemed to have ended, so the downtime is not
 * credited.
 *
 * @param {string} botId
 * @param {number} [now] injectable clock, for tests
 */
function markOnline(botId, now = Date.now()) {
  return database.runAsBot(botId, () => {
    const s = database.getKV(NS, KEY) || {};

    let accumulatedMs = num(s.accumulatedMs);
    const previousStart = num(s.sessionStartedAt);
    if (previousStart > 0) {
      // end the previous session at the last moment it was known alive
      const endedAt = num(s.lastAliveAt) || previousStart;
      accumulatedMs += Math.max(0, endedAt - previousStart);
    }

    database.setKV(NS, KEY, {
      firstSeenAt: num(s.firstSeenAt) || now,
      accumulatedMs,
      sessionStartedAt: now,
      lastAliveAt: now,
      sessions: num(s.sessions) + 1,
    });
    return true;
  });
}

/** Refresh liveness for a bot that is currently connected. */
function heartbeat(botId, now = Date.now()) {
  return database.runAsBot(botId, () => {
    const s = database.getKV(NS, KEY);
    if (!s || num(s.sessionStartedAt) <= 0) return false;
    database.setKV(NS, KEY, { ...s, lastAliveAt: now });
    return true;
  });
}

/**
 * What `.up` displays.
 *
 * @returns {null|{firstSeenAt:number|null, totalMs:number, sessionMs:number,
 *                 online:boolean, sessions:number}}
 */
function snapshot(botId, now = Date.now()) {
  const s = readState(botId);
  if (!s) return null;

  const start = num(s.sessionStartedAt);
  const lastAlive = num(s.lastAliveAt);
  const fresh = lastAlive > 0 && now - lastAlive <= freshnessMs();

  // No session open → nothing to add. Stale heartbeat → credit only up to the
  // last proof of life, never up to "now".
  let sessionMs = 0;
  if (start > 0) {
    const sessionEnd = fresh ? now : (lastAlive || start);
    sessionMs = Math.max(0, sessionEnd - start);
  }

  return {
    firstSeenAt: num(s.firstSeenAt) || null,
    totalMs: num(s.accumulatedMs) + sessionMs,
    sessionMs,
    online: start > 0 && fresh,
    sessions: num(s.sessions),
  };
}

// ── heartbeat loop ─────────────────────────────────────────────────────────

let timer = null;

/**
 * One timer for the whole process, not one per bot. Bots are stamped only while
 * their socket is actually connected, so a bot that is mid-reconnect stops
 * accruing until it is back.
 */
function startHeartbeat({ sessionService = null, intervalMs = heartbeatMs() } = {}) {
  if (timer || intervalMs === 0) return null;
  const engine = sessionService || require('../platform/sessionService');

  const tick = () => {
    let bots = [];
    try { bots = engine.configured() ? engine.list() : []; } catch (_) { return; }
    for (const entry of bots) {
      try {
        if (engine.get(entry.id)?.state !== 'connected') continue;
        heartbeat(entry.id);
      } catch (_) { /* one bot's failure must not stop the others */ }
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();     // never hold the process open
  return { stop: stopHeartbeat };
}

function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  markOnline,
  heartbeat,
  snapshot,
  startHeartbeat,
  stopHeartbeat,
  heartbeatMs,
  freshnessMs,
};
