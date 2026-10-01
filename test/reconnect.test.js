'use strict';

/**
 * Reconnect policy — the two defects that read from the outside as "the bot
 * keeps dying".
 *
 *  1. 428 (`connectionClosed`) was grouped with 440/409 (a real duplicate
 *     session) and cost 15-120s of uptime per ordinary server-side close.
 *  2. Ten consecutive closes parked the bot in 'waiting' — terminal, because
 *     nothing reads that state for a paired bot — so it stayed dark until the
 *     container was restarted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const policy = require(path.resolve(__dirname, '..', 'platform/reconnect'));

/** Deterministic jitter. */
const noJitter = () => 0;

describe('transient closes come back fast', () => {
  test('428 is a short jittered retry, not a conflict backoff', () => {
    const counters = {};
    const r = policy.nextDelay(428, counters, 1, noJitter);
    assert.equal(r.reason, 'transient', '428 is connectionClosed, not a duplicate session');
    assert.equal(r.waitMs, policy.FAST_MIN_MS);
    assert.ok(r.waitMs < 15_000, 'must not sit offline for the old conflict delay');
    assert.equal(counters.errConflict, undefined, 'and must not feed the conflict counter');
  });

  test('the jitter spreads bots out instead of returning in lockstep', () => {
    const a = policy.nextDelay(428, {}, 1, () => 0).waitMs;
    const b = policy.nextDelay(428, {}, 1, () => 0.999).waitMs;
    assert.ok(b > a, `expected jitter, got ${a} and ${b}`);
    assert.ok(b <= policy.FAST_MIN_MS + policy.FAST_JITTER_MS);
  });

  test('an unlabelled close gets the same fast retry', () => {
    assert.equal(policy.nextDelay(undefined, {}, 1, noJitter).waitMs, policy.FAST_MIN_MS);
  });
});

describe('a genuine duplicate session still backs off', () => {
  test('440 and 409 escalate, so the other socket can die first', () => {
    const counters = {};
    const first = policy.nextDelay(440, counters, 1, noJitter);
    const second = policy.nextDelay(409, counters, 2, noJitter);
    assert.equal(first.reason, 'conflict');
    assert.equal(first.waitMs, 15_000);
    assert.equal(second.waitMs, 30_000, 'escalates while the duplicate persists');
    assert.equal(counters.errConflict, 2);
  });

  test('the conflict delay is capped', () => {
    const counters = {};
    let r;
    // up to the slow-lane threshold only: past it the lane takes over on purpose
    for (let attempt = 1; attempt <= policy.SLOW_LANE_AFTER; attempt++) {
      r = policy.nextDelay(440, counters, attempt, noJitter);
    }
    assert.equal(r.waitMs, 120_000);
    assert.equal(r.lane, 'fast');
  });
});

describe('the other codes keep their intent', () => {
  test('503 gives the edge room, capped at 5 minutes', () => {
    const counters = {};
    assert.equal(policy.nextDelay(503, counters, 1, noJitter).waitMs, 30_000);
    let r;
    for (let i = 0; i < 20; i++) r = policy.nextDelay(503, counters, i + 1, noJitter);
    assert.equal(r.waitMs, 300_000);
  });

  test('408 backs off exponentially and then plateaus', () => {
    const counters = {};
    const d1 = policy.nextDelay(408, counters, 1, noJitter).waitMs;
    const d3 = policy.nextDelay(408, counters, 3, noJitter).waitMs;
    assert.ok(d3 > d1, `expected growth, got ${d1} then ${d3}`);
    // 5000 * 2^min(n,3) tops out at 40s — under the 60s ceiling, and it stops
    // growing rather than climbing into the slow lane's territory
    let r;
    for (let attempt = 1; attempt <= policy.SLOW_LANE_AFTER; attempt++) {
      r = policy.nextDelay(408, counters, attempt, noJitter);
    }
    assert.equal(r.waitMs, 40_000);
    assert.ok(r.waitMs <= 60_000);
  });

  test('500 is a flat 10s', () => {
    assert.equal(policy.nextDelay(500, {}, 1, noJitter).waitMs, 10_000);
    assert.equal(policy.nextDelay(500, {}, 7, noJitter).waitMs, 10_000);
  });
});

describe('it never gives up', () => {
  test('past ten closes it moves to the slow lane instead of stopping', () => {
    const plan = policy.nextDelay(428, {}, policy.SLOW_LANE_AFTER + 1, noJitter);
    assert.equal(plan.lane, 'slow');
    assert.equal(plan.waitMs, policy.SLOW_LANE_MS);
  });

  test('the slow lane applies to every code, including a clean 428 streak', () => {
    for (const code of [428, 440, 409, 500, 503, 408, undefined]) {
      const plan = policy.nextDelay(code, {}, 50, noJitter);
      assert.equal(plan.lane, 'slow', `status ${code} must still retry`);
      assert.ok(plan.waitMs >= policy.SLOW_LANE_MS);
    }
  });

  test('a slow lane delay is never shorter than the fast one it replaced', () => {
    const counters = {};
    for (let attempt = 11; attempt < 25; attempt++) {
      const plan = policy.nextDelay(503, counters, attempt, noJitter);
      assert.ok(plan.waitMs >= policy.SLOW_LANE_MS);
    }
  });
});

describe('watchdog', () => {
  const NOW = 1_700_000_000_000;
  const stale = (over = {}) => ({
    pairingDone: true, state: 'connecting', _reconnecting: false,
    stateAt: NOW - policy.WATCHDOG_STALE_MS - 1, ...over,
  });

  test('revives a paired bot that is down and not retrying', () => {
    assert.equal(policy.shouldRevive(stale(), NOW), true);
  });

  test('leaves a connected bot alone', () => {
    assert.equal(policy.shouldRevive(stale({ state: 'connected' }), NOW), false);
  });

  test('never interrupts pairing', () => {
    assert.equal(policy.shouldRevive(stale({ pairingDone: false }), NOW), false,
      'a bot awaiting its first QR or code must not be rebooted');
  });

  test('does not cut in front of a reconnect already in flight', () => {
    assert.equal(policy.shouldRevive(stale({ _reconnecting: true }), NOW), false);
  });

  test('respects a deliberate stop', () => {
    assert.equal(policy.shouldRevive(stale({ state: 'stopped' }), NOW), false);
  });

  test('gives a freshly-changed state time before intervening', () => {
    assert.equal(policy.shouldRevive(stale({ stateAt: NOW - 1000 }), NOW), false);
  });

  test('a bot that never settled is revived', () => {
    assert.equal(policy.shouldRevive({ pairingDone: true, state: 'connecting' }, NOW), true);
  });

  test('no bot at all is not revived', () => {
    assert.equal(policy.shouldRevive(null, NOW), false);
  });
});
