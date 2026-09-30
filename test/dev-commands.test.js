'use strict';

/**
 * The dev-only process commands: `.upgrade`, `.shutdown`, `.restart`.
 *
 * These three are the only commands that can end or replace a process, and
 * Jtest runs up to 100 bots in that one process, so the contracts here are the
 * ones that keep one tenant from taking the rest down:
 *
 *   1. SILENCE. A sender who is not allowed gets no reply, no reaction, no
 *      "owner only" message. Zero sends. (That is why none of them sets
 *      `ownerOnly` — the handler replies to that flag on its own.)
 *
 *   2. SCOPE. `.upgrade` and `.shutdown` are dev-only and act on the whole
 *      process. `.restart` is per bot: it may only ever touch the bot that
 *      received the message, and it must never call process.exit().
 *
 * Everything runs through the real handler.handleMessage(), so a stray reply
 * from the handler itself (permissions, gating, disabled commands) fails these
 * tests too.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-devcommands';
const A = 'bot-alpha';
const B = 'bot-beta';

const DEV1 = '2348154853640';
const DEV2 = '2348062642047';
const RANDO = '2348033333333';
/** One digit longer than DEV1 — the classic prefix-match bug. */
const NEAR_MISS = '23481548536401';

let database, handler, loader, sessionService, table;

before(async () => {
  // the delays go to 0 so the exit timers fire during the test
  ({ database, handler } = await H.boot({
    dataDir: DATA,
    env: { JUNE_UPGRADE_DELAY_MS: '0', JUNE_SHUTDOWN_DELAY_MS: '0' },
  }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  loader = require(path.join(H.REPO, 'platform/loader.js'));
  sessionService = require(path.join(H.REPO, 'platform/sessionService.js'));
  // the handler exposes no name lookup, so registration is asserted against the
  // loader's own table — the same one getCommandCount() reads
  table = require(path.join(H.REPO, 'utils/commandLoader.js')).loadCommands();
});

after(() => {
  H.teardown(handler, database);
  try { sessionService.resetForTests(); } catch (_) {}
  process.chdir(H.REPO);
});

const run = (sock, m) => H.dispatch(database, handler, A, sock, m);

/** Everything the socket was asked to send, in one number. */
const sendCount = (sock) =>
  sock._rec.sent.length + sock._rec.relayed.length +
  sock._rec.reacts.length + sock._rec.texts.length;

/**
 * Dispatch with process.exit captured instead of performed, so the runner
 * survives the command's own exit. Returns the codes seen.
 */
async function dispatchCapturingExit(sock, m, env = {}) {
  const codes = [];
  const realExit = process.exit;
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.exit = (code) => { codes.push(code); };
  try {
    await run(sock, m);
    await H.sleep(60);          // let the exit timer fire
  } finally {
    process.exit = realExit;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return codes;
}

/**
 * A session-service stand-in that records what it was asked to do.
 *
 * configure() validates the whole adapter surface, so this has to carry all
 * nine methods even though the commands only reach for get/list/stop/reconnect.
 */
function fakeEngine(botIds = [A]) {
  const log = { stops: [], reconnects: [], gets: [] };
  sessionService.configure({
    get(id) { log.gets.push(id); return botIds.includes(id) ? { id } : null; },
    list() { return botIds.map((id) => ({ id })); },
    stop(id) { log.stops.push(id); return { ok: true, id }; },
    reconnect(id) { log.reconnects.push(id); return { ok: true, id }; },
    provision() { return { ok: true }; },
    restorePersisted() { return { ok: true, restored: [] }; },
    remove(id) { return { ok: true, id }; },
    reconcile() { return { ok: true }; },
    snapshot() { return botIds.map((id) => ({ id })); },
  });
  return log;
}

describe('dev commands: registration', () => {
  test('all three are registered with their aliases', () => {
    for (const [name, aliases] of [['upgrade', ['resync', 'sync']],
                                   ['shutdown', ['stop', 'off', 'kill']],
                                   ['restart', ['reboot']]]) {
      const t = table.get(name);
      assert.ok(t, `.${name} must be in the table`);
      assert.equal(t.category, 'owner');
      for (const alias of aliases) {
        assert.equal(table.get(alias)?.name, name, `.${alias} -> .${name}`);
      }
    }
  });

  test('none carries ownerOnly/adminOnly — those make the handler reply', () => {
    for (const name of ['upgrade', 'shutdown', 'restart']) {
      const t = table.get(name);
      assert.equal(t.ownerOnly, undefined, `.${name} must gate inside execute()`);
      assert.equal(t.adminOnly, undefined);
      assert.equal(t.groupOnly, undefined);
    }
  });
});

describe('loader protocol', () => {
  test('44 = quick restart, 45 = stay down, and they are distinct', () => {
    assert.equal(loader.QUICK_RESTART, 44);
    assert.equal(loader.STAY_DOWN, 45);
    assert.notEqual(loader.QUICK_RESTART, loader.STAY_DOWN);
  });

  test('.upgrade exits with the quick-restart code, .shutdown with stay-down', async () => {
    const up = require(path.join(H.REPO, 'commands/owner/upgrade.js'));
    const down = require(path.join(H.REPO, 'commands/owner/shutdown.js'));
    void up; void down;
    // driven end to end below; this pins the constants the commands use
    assert.equal(loader.QUICK_RESTART, 44);
    assert.equal(loader.STAY_DOWN, 45);
  });
});

describe('silence for non-devs', () => {
  for (const cmd of ['upgrade', 'shutdown', 'restart']) {
    test(`.${cmd} — a stranger in a group gets nothing at all`, async () => {
      const sock = H.makeSock();
      await dispatchCapturingExit(sock, H.textMsg(`.${cmd}`, { sender: `${RANDO}@s.whatsapp.net` }),
        { JUNE_LOADER: '1' });
      assert.equal(sendCount(sock), 0, 'no reply, no reaction, no relayed message');
    });

    test(`.${cmd} — a stranger in a DM gets nothing at all`, async () => {
      const sock = H.makeDmSock();
      await dispatchCapturingExit(sock, H.textMsg(`.${cmd}`, { dm: true, remoteJid: `${RANDO}@s.whatsapp.net` }),
        { JUNE_LOADER: '1' });
      assert.equal(sendCount(sock), 0);
    });
  }

  test('a near-miss number is not prefix-matched into the allowlist', async () => {
    const sock = H.makeDmSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { dm: true, remoteJid: `${NEAR_MISS}@s.whatsapp.net` }),
      { JUNE_LOADER: '1' });
    assert.equal(sendCount(sock), 0);
  });

  test('the group owner is still a stranger to the dev commands', async () => {
    const sock = H.makeSock();
    await dispatchCapturingExit(sock, H.textMsg('.shutdown', { sender: H.OWNER }), { JUNE_LOADER: '1' });
    assert.equal(sendCount(sock), 0, 'being an owner is not being a dev');
  });

  test('a non-owner cannot restart a bot — and is not told why', async () => {
    fakeEngine([A]);
    const sock = H.makeSock();
    const codes = await dispatchCapturingExit(sock, H.textMsg('.restart', { sender: `${RANDO}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0);
    assert.deepEqual(codes, [], 'and certainly does not take the process down');
  });
});

describe('.upgrade', () => {
  test('dev #1 in a DM: one confirmation, then exit 44', async () => {
    const sock = H.makeDmSock();
    const codes = await dispatchCapturingExit(
      sock,
      H.textMsg('.upgrade', { dm: true, remoteJid: `${DEV1}@s.whatsapp.net` }),
      { JUNE_LOADER: '1' },
    );
    assert.deepEqual(codes, [loader.QUICK_RESTART]);
    assert.equal(sock._rec.texts.length, 1, 'exactly one confirmation');
    assert.match(sock._rec.texts[0], /Upgrading/i);
  });

  test('dev #2 in a group: exit 44 too', async () => {
    const sock = H.makeSock();
    const codes = await dispatchCapturingExit(
      sock, H.textMsg('.upgrade', { sender: `${DEV2}@s.whatsapp.net` }), { JUNE_LOADER: '1' });
    assert.deepEqual(codes, [loader.QUICK_RESTART]);
    assert.equal(sock._rec.texts.length, 1);
  });

  test('a dev behind an @lid jid is matched through participantAlt', async () => {
    const sock = H.makeSock();
    const m = H.textMsg('.upgrade', {
      sender: '15551234567890@lid',
      key: { participantAlt: `${DEV1}@s.whatsapp.net` },
    });
    const codes = await dispatchCapturingExit(sock, m, { JUNE_LOADER: '1' });
    assert.deepEqual(codes, [loader.QUICK_RESTART]);
  });

  test('no loader detected: refuses, explains, and does not exit', async () => {
    const sock = H.makeDmSock();
    const codes = await dispatchCapturingExit(
      sock,
      H.textMsg('.upgrade', { dm: true, remoteJid: `${DEV1}@s.whatsapp.net` }),
      { JUNE_LOADER: undefined, JUNE_LOADER_ASSUME: undefined },
    );
    assert.deepEqual(codes, [], 'a bare 44 here would take the bot down for good');
    assert.equal(sock._rec.texts.length, 1);
    assert.match(sock._rec.texts[0], /No auto-sync loader detected/);
  });

  test('detection: env flag wins, and node_platform in cwd counts', () => {
    const { loaderDetected } = require(path.join(H.REPO, 'commands/owner/upgrade.js'))._internals;
    const saved = process.env.JUNE_LOADER;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-detect-'));

    assert.equal(loaderDetected(), false, 'plain repo cwd has no loader');

    process.env.JUNE_LOADER = '1';
    assert.equal(loaderDetected(), true);
    delete process.env.JUNE_LOADER;

    // the loader extracts into <loader>/node_platform/lib_signals/<repo>/
    const nested = path.join(tmp, 'node_platform', 'lib_signals', 'Jtest-main');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    assert.equal(loaderDetected(), true);
    process.chdir(H.REPO);
    fs.rmSync(tmp, { recursive: true, force: true });

    if (saved !== undefined) process.env.JUNE_LOADER = saved;
  });
});

describe('.shutdown', () => {
  test('a dev gets a confirmation then exit 45 (stay down)', async () => {
    const log = fakeEngine([A]);
    const sock = H.makeDmSock();
    const codes = await dispatchCapturingExit(
      sock,
      H.textMsg('.shutdown', { dm: true, remoteJid: `${DEV2}@s.whatsapp.net` }),
    );
    assert.deepEqual(codes, [loader.STAY_DOWN]);
    assert.notEqual(codes[0], loader.QUICK_RESTART, 'must not re-sync+relaunch');
    assert.equal(sock._rec.texts.length, 1);
    assert.match(sock._rec.texts[0], /Shutting down/i);
    assert.deepEqual(log.stops, [A], 'the socket is closed before the exit');
  });

  test('closes every bot, not just one', async () => {
    const log = fakeEngine([A, B]);
    const sock = H.makeDmSock();
    await dispatchCapturingExit(
      sock, H.textMsg('.shutdown', { dm: true, remoteJid: `${DEV1}@s.whatsapp.net` }));
    assert.deepEqual(log.stops, [A, B]);
  });
});

describe('.restart acts on one bot only', () => {
  test('the owner restarts their own bot and nothing else happens', async () => {
    const log = fakeEngine([A, B]);
    const codes = await dispatchCapturingExit(
      H.makeSock(), H.textMsg('.restart', { sender: H.OWNER }));

    assert.deepEqual(codes, [], 'never exits the process');
    assert.deepEqual(log.reconnects, [A], 'reconnects only the bot the message arrived on');
    assert.ok(!log.reconnects.includes(B), 'the sibling is untouched');
    assert.deepEqual(log.stops, [], 'nothing is stopped');
  });

  test('is silent when the message carries no bot scope to act on', async () => {
    // direct call, outside a dispatch — index.js always sets this, but guessing
    // an id would restart the wrong tenant
    const cmd = require(path.join(H.REPO, 'commands/owner/restart.js'));
    const sent = [];
    const sock = H.makeSock();
    const saved = global.__BOT_ID__;
    delete global.__BOT_ID__;
    try {
      await cmd.execute(sock, H.textMsg('.restart', { sender: H.OWNER }), [], {
        isOwner: true,
        reply: async (t) => { sent.push(t); },
      });
    } finally {
      global.__BOT_ID__ = saved;
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], /which bot/i);
  });

  test('an unknown bot in the session service is reported, not guessed at', async () => {
    fakeEngine([]);   // the engine does not know bot-alpha
    const sock = H.makeSock();
    const codes = await dispatchCapturingExit(sock, H.textMsg('.restart', { sender: H.OWNER }));
    assert.deepEqual(codes, []);
    assert.equal(sock._rec.texts.length, 1);
    assert.match(sock._rec.texts[0], /not managed by the session service/i);
  });
});
