'use strict';

/**
 * `.upgrade` — the loader-aware re-sync.
 *
 * Two contracts that this file exists to pin down:
 *
 *   1. SILENCE for anyone who is not a dev number. Not a refusal, not a
 *      reaction, not a "this command is owner only" message. Zero sends.
 *      (test/upgrade.test.js already covers the ..wdp port, hence the -command
 *      suffix on this file.)
 *
 *   2. Exit 44, which is the loader's quick-restart signal, so the panel
 *      container stays up. Never a plain exit — and never an exit when there is
 *      no loader to catch the 44.
 *
 * The dispatch path is the real handler.handleMessage(), so a stray reply from
 * the handler itself (permissions, gating, help) would fail these tests too.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-upgradecmd';
const A = 'bot-alpha';

const DEV1 = '2348154853640';
const DEV2 = '2348062642047';
const RANDO = '2348033333333';
/** One digit longer than DEV1 — the classic prefix-match bug. */
const NEAR_MISS = '23481548536401';

let database, handler, command, shutdown, table;

before(async () => {
  // dispatch happens with the delay at 0 so the restart timer fires immediately
  ({ database, handler } = await H.boot({ dataDir: DATA, env: { JUNE_UPGRADE_DELAY_MS: '0' } }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  command = require(path.join(H.REPO, 'commands/owner/upgrade.js'));
  shutdown = require(path.join(H.REPO, 'utils/shutdown.js'));
  // the handler does not expose a name lookup, so registration is asserted
  // against the loader's own table — the same one getCommandCount() reads
  table = require(path.join(H.REPO, 'utils/commandLoader.js')).loadCommands();
});

after(() => {
  H.teardown(handler, database);
  process.chdir(H.REPO);
});

const run = (sock, m) => H.dispatch(database, handler, A, sock, m);

/** Everything the socket was asked to send, in one number. */
const sendCount = (sock) =>
  sock._rec.sent.length + sock._rec.relayed.length +
  sock._rec.reacts.length + sock._rec.texts.length;

/**
 * Dispatch with process.exit captured instead of performed, so the test runner
 * survives the command's own restart request. Returns the exit codes seen.
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
    await H.sleep(60);          // let the restart timer fire
  } finally {
    process.exit = realExit;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return codes;
}

describe('.upgrade registration', () => {
  test('is registered as .upgrade with its aliases and own category', () => {
    const t = table.get('upgrade');
    assert.ok(t, '.upgrade must be in the table');
    assert.equal(t.name, 'upgrade');
    assert.equal(t.category, 'owner');
    for (const alias of ['resync', 'sync']) {
      assert.equal(table.get(alias)?.name, 'upgrade', `alias ${alias}`);
    }
  });

  test('carries no ownerOnly/adminOnly flag — those would make the handler reply', () => {
    const t = table.get('upgrade');
    assert.equal(t.ownerOnly, undefined, 'ownerOnly makes handler.js send a refusal to strangers');
    assert.equal(t.adminOnly, undefined);
    assert.equal(t.groupOnly, undefined);
    // and the module itself must not declare them either
    const mod = require(path.join(H.REPO, 'commands/owner/upgrade.js'));
    assert.ok(!mod.ownerOnly && !mod.adminOnly && !mod.groupOnly);
  });

  test('the 44 it exits with is the same 44 utils/shutdown.js exports', () => {
    assert.equal(command._internals.QUICK_RESTART_EXIT_CODE, 44);
    assert.equal(shutdown.EXIT_CODE, 44);
    assert.equal(command._internals.QUICK_RESTART_EXIT_CODE, shutdown.EXIT_CODE);
  });

  test('the allowlist is exactly the two dev numbers', () => {
    assert.deepEqual([...command._internals.DEV_NUMBERS], [DEV1, DEV2]);
  });
});

describe('.upgrade is silent for non-devs', () => {
  test('a stranger in a group gets nothing at all', async () => {
    const sock = H.makeSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { sender: `${RANDO}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0, 'no reply, no reaction, no relayed message');
    assert.equal(sock._rec.sent.length, 0);
  });

  test('a stranger in a DM gets nothing at all', async () => {
    const sock = H.makeDmSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { dm: true, remoteJid: `${RANDO}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0);
  });

  test('the group owner is still a stranger here — no message', async () => {
    const sock = H.makeSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { sender: H.OWNER }));
    assert.equal(sendCount(sock), 0);
  });

  test('a near-miss number is not prefix-matched into the allowlist', async () => {
    assert.equal(command._internals.isDevNumber({ key: { remoteJid: `${NEAR_MISS}@s.whatsapp.net` } }, {}), false);
    const sock = H.makeDmSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { dm: true, remoteJid: `${NEAR_MISS}@s.whatsapp.net` }));
    assert.equal(sendCount(sock), 0);
  });

  test('an @lid sender whose digits are not the dev number gets nothing', async () => {
    const sock = H.makeSock();
    await dispatchCapturingExit(sock, H.textMsg('.upgrade', { sender: '99999999999999@lid' }));
    assert.equal(sendCount(sock), 0);
  });
});

describe('.upgrade restarts for devs', () => {
  test('dev #1 in a DM: one confirmation, then exit 44', async () => {
    const sock = H.makeDmSock();
    const codes = await dispatchCapturingExit(
      sock,
      H.textMsg('.upgrade', { dm: true, remoteJid: `${DEV1}@s.whatsapp.net` }),
      { JUNE_LOADER: '1' },
    );
    assert.deepEqual(codes, [44], 'must exit with the loader quick-restart code');
    assert.equal(sock._rec.texts.length, 1, 'exactly one confirmation');
    assert.match(sock._rec.texts[0], /Upgrading/i);
  });

  test('dev #2 in a group: exit 44 with the confirmation sent first', async () => {
    const sock = H.makeSock();
    const codes = await dispatchCapturingExit(
      sock,
      H.textMsg('.upgrade', { sender: `${DEV2}@s.whatsapp.net` }),
      { JUNE_LOADER: '1' },
    );
    assert.deepEqual(codes, [44]);
    assert.equal(sock._rec.texts.length, 1);
  });

  test('a dev behind an @lid jid is matched through participantAlt', async () => {
    const sock = H.makeSock();
    const m = H.textMsg('.upgrade', {
      sender: '15551234567890@lid',
      key: { participantAlt: `${DEV1}@s.whatsapp.net` },
    });
    assert.equal(command._internals.isDevNumber(m, {}), true, 'participantAlt carries the phone number');
    const codes = await dispatchCapturingExit(sock, m, { JUNE_LOADER: '1' });
    assert.deepEqual(codes, [44]);
  });
});

describe('.upgrade never exits without a loader to catch the 44', () => {
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
    const { loaderDetected } = command._internals;
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
