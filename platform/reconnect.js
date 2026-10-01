'use strict';

/**
 * Reconnect policy — how long to wait after a socket closes, and when to
 * intervene in a bot that has stopped trying.
 *
 * Two defects lived in the old inline table, both of which read from the
 * outside as "the bot keeps dying":
 *
 * 1. 428 WAS TREATED AS A CONFLICT. 428 is `connectionClosed` — the server
 *    ended the stream. It is transient and the answer is to come back promptly.
 *    It was grouped with 440 (`connectionReplaced`) and 409, which genuinely
 *    mean "another socket holds this session" and do deserve a hard backoff so
 *    the duplicate can time out first. The result was that every ordinary
 *    server-side close cost 15-120 seconds of uptime for nothing.
 *
 * 2. THE 10TH FAILURE PARKED THE BOT FOREVER. After 10 consecutive closes the
 *    bot was set to state 'waiting' and `return`ed — no timer, no retry, and
 *    nothing anywhere reads 'waiting' for a paired bot, so it stayed dark until
 *    someone restarted the container. That is the "bot goes off after about a
 *    day" report: a bad patch of network or a few 428s, ten attempts, then
 *    silence.
 *
 * The fix keeps the intent (never hammer WhatsApp) without the dead end: past
 * the fast attempts the bot moves to a SLOW LANE — five minute intervals,
 * indefinitely. It always keeps trying.
 */

/** Consecutive closes before backing off to the slow lane. */
const SLOW_LANE_AFTER = 10;
/** Slow-lane interval. Slow enough to be polite, frequent enough to recover. */
const SLOW_LANE_MS = 5 * 60_000;

/** Short, jittered retry for a transient close. */
const FAST_MIN_MS = 2_000;
const FAST_JITTER_MS = 4_000;

/** A bot that is down and not trying gets revived after this long. */
const WATCHDOG_STALE_MS = 3 * 60_000;

/**
 * @param {number|undefined} statusCode  Baileys DisconnectReason from the close
 * @param {object} counters  the bot's err503/err408/errConflict tallies (mutated)
 * @param {number} attempt   1-based consecutive close count
 * @param {() => number} [random]  injectable, so tests are deterministic
 * @returns {{waitMs:number, lane:'fast'|'slow', reason:'conflict'|'unavailable'|'timeout'|'server'|'transient'}}
 */
function nextDelay(statusCode, counters = {}, attempt = 1, random = Math.random) {
  let waitMs;
  let reason;

  if (statusCode === 440 || statusCode === 409) {
    // Another socket genuinely holds this session — back off so it dies first.
    counters.errConflict = (counters.errConflict || 0) + 1;
    waitMs = Math.min(15_000 * counters.errConflict, 120_000);
    reason = 'conflict';
  } else if (statusCode === 503) {
    // WhatsApp's edge dropped the stream; linear steps, room to recover.
    counters.err503 = (counters.err503 || 0) + 1;
    waitMs = Math.min(30_000 * counters.err503, 300_000);
    reason = 'unavailable';
  } else if (statusCode === 408) {
    counters.err408 = (counters.err408 || 0) + 1;
    waitMs = Math.min(5_000 * 2 ** Math.min(counters.err408, 3), 60_000);
    reason = 'timeout';
  } else if (statusCode === 500) {
    waitMs = 10_000;
    reason = 'server';
  } else {
    // 428 and anything unlabelled: transient. Come back quickly, with jitter so
    // bots dropped by the same hiccup do not return in lockstep.
    waitMs = FAST_MIN_MS + Math.floor(random() * FAST_JITTER_MS);
    reason = 'transient';
  }

  if (attempt > SLOW_LANE_AFTER) {
    return { waitMs: Math.max(waitMs, SLOW_LANE_MS), lane: 'slow', reason };
  }
  return { waitMs, lane: 'fast', reason };
}

/**
 * Should the watchdog force this bot back online?
 *
 * Only for a bot that is PAIRED and simply not connected: a bot still waiting
 * for its first pairing must never be rebooted out from under a QR code, and a
 * bot with a reconnect already in flight is already being handled.
 *
 * @param {object} bot
 * @param {number} [now]
 */
function shouldRevive(bot, now = Date.now()) {
  if (!bot) return false;
  if (!bot.pairingDone) return false;          // never interrupt pairing
  if (bot._reconnecting) return false;         // already handled
  if (bot.state === 'connected') return false;
  if (bot.state === 'stopped') return false;   // deliberate: the shape .restart needs
  const since = bot.stateAt || bot.connectedAt || 0;
  if (!since) return true;                     // never settled — revive
  return now - since > WATCHDOG_STALE_MS;
}

module.exports = {
  SLOW_LANE_AFTER,
  SLOW_LANE_MS,
  FAST_MIN_MS,
  FAST_JITTER_MS,
  WATCHDOG_STALE_MS,
  nextDelay,
  shouldRevive,
};
