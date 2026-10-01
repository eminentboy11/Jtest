'use strict';

/**
 * Per-bot uptime that survives a restart.
 *
 * The bug this exists for: Jtest runs every bot in one process, so an
 * `.upgrade` swap — 16 seconds in practice — reset the bot's uptime to zero.
 * From WhatsApp's side that session never ended.
 *
 * The rule these tests pin down: a completed session accumulates, and a session
 * is credited only up to the last moment the bot was actually seen alive. An
 * outage is never silently counted as uptime.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-uptime';
const A = 'bot-alpha';
const B = 'bot-beta';

const MIN = 60_000;

let database, handler, uptime;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  uptime = require(path.join(H.REPO, 'utils/uptime.js'));
});

after(() => {
  uptime.stopHeartbeat();
  H.teardown(handler, database);
});

describe('uptime survives a restart', () => {
  test('a fresh bot starts at zero and is marked online', () => {
    const t0 = 1_000_000_000_000;
    uptime.markOnline(A, t0);

    const snap = uptime.snapshot(A, t0);
    assert.equal(snap.totalMs, 0, 'no completed session to add yet');
    assert.equal(snap.sessionMs, 0);
    assert.equal(snap.online, true);
    assert.equal(snap.firstSeenAt, t0);
  });

  test('the previous session is carried across, and the outage is not', () => {
    const t0 = 1_000_000_000_000;
    // session 1: online for 10 minutes...
    uptime.markOnline(B, t0);
    uptime.heartbeat(B, t0 + 10 * MIN);
    // ...then the process is killed here. The bot is offline for 3 days.
    const restart = t0 + 3 * 24 * 60 * MIN;

    uptime.markOnline(B, restart);          // the loader relaunches it
    const snap = uptime.snapshot(B, restart);

    assert.equal(snap.sessionMs, 0, 'the new session has only just started');
    assert.equal(snap.totalMs, 10 * MIN, 'exactly the 10 minutes it was online');
    assert.ok(snap.totalMs < 3 * 24 * 60 * MIN, 'the 3-day outage must not be credited');
    assert.equal(snap.firstSeenAt, t0, 'first-seen is set once and never moves');
  });

  test('sessions accumulate across several restarts', () => {
    const botId = 'bot-gamma';
    let t = 5_000_000_000_000;

    uptime.markOnline(botId, t);
    uptime.heartbeat(botId, t + 5 * MIN);
    t += 5 * MIN + 1000;                    // killed; 1s restart gap
    uptime.markOnline(botId, t);
    uptime.heartbeat(botId, t + 3 * MIN);
    t += 3 * MIN + 1000;                    // killed again
    uptime.markOnline(botId, t);

    const snap = uptime.snapshot(botId, t);
    assert.equal(snap.totalMs, 8 * MIN, '5 + 3 minutes of real uptime');
    assert.equal(snap.sessions, 3);
  });

  test('a stale heartbeat is not credited up to now', () => {
    const botId = 'bot-delta';
    const t = 6_000_000_000_000;
    uptime.markOnline(botId, t);

    // let the heartbeat go cold (no beat for well past the freshness window)
    const cold = t + uptime.freshnessMs() + 30 * MIN;
    uptime.stopHeartbeat();
    const snap = uptime.snapshot(botId, cold);

    assert.equal(snap.sessionMs, 0, 'nothing proven alive, so nothing credited');
    assert.equal(snap.online, false, 'and it does not claim to be online');
  });

  test('a fresh heartbeat counts the current session up to now', () => {
    const botId = 'bot-epsilon';
    const t = 7_000_000_000_000;
    uptime.markOnline(botId, t);
    const snap = uptime.snapshot(botId, t + 2 * MIN);
    assert.equal(snap.sessionMs, 2 * MIN);
    assert.equal(snap.online, true);
  });

  test('a clock that jumps backwards never produces negative uptime', () => {
    const botId = 'bot-zeta';
    uptime.markOnline(botId, 8_000_000_000_000);
    const snap = uptime.snapshot(botId, 7_000_000_000_000);   // clock went back
    assert.ok(snap.totalMs >= 0);
    assert.ok(snap.sessionMs >= 0);
  });

  test('uptime is per bot — one bot restarting does not touch another', () => {
    const t = 9_000_000_000_000;
    uptime.markOnline('bot-eta', t);
    uptime.heartbeat('bot-eta', t + 20 * MIN);
    uptime.markOnline('bot-theta', t);
    uptime.heartbeat('bot-theta', t + 2 * MIN);

    assert.equal(uptime.snapshot('bot-eta', t + 20 * MIN).totalMs, 20 * MIN);
    assert.equal(uptime.snapshot('bot-theta', t + 2 * MIN).totalMs, 2 * MIN);
  });
});

describe('.up reports it', () => {
  test('the reply shows the bot total and the current session', async () => {
    const botId = 'bot-alpha';
    // Anchored to the real clock: `.up` calls snapshot() with Date.now(), so an
    // invented future timestamp would read as a session that has not started.
    const DAY = 24 * 60 * MIN;
    const t0 = Date.now() - 3 * DAY;

    uptime.markOnline(botId, t0);                 // first ever connection
    uptime.heartbeat(botId, t0 + 2 * DAY);        // online for 2 days...
    uptime.markOnline(botId, Date.now() - MIN);   // ...then an upgrade swap

    await database.runAsBot(botId, async () => {
      const sock = H.makeSock();
      await H.dispatch(database, handler, botId, sock, H.textMsg('.up', { sender: H.OWNER }));
      const text = sock._rec.texts.at(-1) || '';
      assert.match(text, /This bot online for:\*\s*2 days/i, `got: ${text}`);
      assert.match(text, /This session:/, 'the current session is shown separately');
      assert.match(text, /First seen:/, 'and when it was first seen');
      assert.match(text, /Server process up:/, 'the process figure is still labelled as shared');
    });
  });
});
