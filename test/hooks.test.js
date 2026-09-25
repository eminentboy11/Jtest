'use strict';

/**
 * The five retained group-moderation hooks.
 *
 * handler.js reaches these through optional chaining on the command table:
 *
 *   antispam?.handleAntispam(sock, msg, groupMetadata)
 *   antiviewonce?.handleAntiviewonce(sock, msg)
 *   antibot?.handleMessage(sock, msg, groupMetadata)
 *   antiforward?.handleAntiforward(sock, msg, groupMetadata)
 *   antitagadmins?.handleMessage(sock, msg, groupMetadata, sender, from, isOwner(sender))
 *
 * With no command file present the chain short-circuits to Promise.resolve(),
 * so "wired up" has to be proven rather than assumed. Everything here goes
 * through the real handler.handleMessage() inside database.runAsBot(), the way
 * index.js dispatches, and asserts both directions: the hook acts when its group
 * setting is on, and does nothing when it is off.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-hooks';
const A = 'bot-alpha';
const B = 'bot-beta';

let database, handler;

before(async () => {
  // Must happen before handler.js loads the commands: antiviewonce
  // destructures downloadContentFromMessage at require time.
  ({ database, handler } = await H.boot({
    dataDir: DATA,
    stubMedia: true,
    owners: [H.OWNER],
  }));
});

after(() => H.teardown(handler, database));

const setGS = (patch) => database.runAsBot(A, () => database.updateGroupSettings(H.GROUP, patch));
const getGS = (botId = A) => database.runAsBot(botId, () => database.getGroupSettings(H.GROUP));
const run = (sock, m, botId = A) => H.dispatch(database, handler, botId, sock, m);
/** All five commands are adminOnly + groupOnly, so config comes from the admin. */
const runCmd = (sock, text, botId = A) =>
  run(sock, H.textMsg(text, { sender: H.ADMIN }), botId);

const forwarded = () => H.makeMsg({
  extendedTextMessage: { text: 'fwd', contextInfo: { isForwarded: true, forwardingScore: 1 } },
});
const viewOnceImage = (caption = 'secret') => H.makeMsg({
  viewOnceMessageV2: { message: { imageMessage: { mediaKey: {}, url: 'u', directPath: 'd', caption } } },
});
const taggingAdmin = () => H.makeMsg({
  extendedTextMessage: { text: 'hey', contextInfo: { mentionedJid: [H.ADMIN] } },
});

describe('registration', () => {
  test('all five commands load alongside ping and uptime', () => {
    assert.equal(handler.getCommandCount(), 31);  // the shipped set, see loader.test.js
  });

  test('each exposes the hook handler.js calls', () => {
    const { loadCommands } = require(path.join(H.REPO, 'utils/commandLoader.js'));
    const table = loadCommands();
    for (const [name, hook] of [
      ['antispam', 'handleAntispam'],
      ['antiviewonce', 'handleAntiviewonce'],
      ['antibot', 'handleMessage'],
      ['antiforward', 'handleAntiforward'],
      ['antitagadmins', 'handleMessage'],
    ]) {
      assert.equal(typeof table.get(name)?.[hook], 'function', `${name}.${hook}`);
    }
  });
});

describe('dormant by default', () => {
  test('nothing fires on ordinary group traffic', async () => {
    const s = H.makeSock();
    for (let i = 0; i < 6; i++) await run(s, H.textMsg(`hello ${i}`));
    await run(s, forwarded());
    await run(s, taggingAdmin());
    await run(s, H.textMsg('agent here', { sender: H.BOT_ACCOUNT }));
    await run(s, viewOnceImage());
    await H.sleep(300);

    assert.equal(s._rec.deletes.length, 0, 'nothing should be deleted');
    assert.equal(s._rec.kicks.length, 0, 'nobody should be removed');
    assert.equal(s._rec.images.length, 0, 'no view-once media should be re-sent');
    assert.ok(!s._rec.texts.some((t) => /Anti-Spam|AntiForward|AntiBot|AntiTagAdmins|View-once/i.test(t)),
      `unexpected notice: ${s._rec.texts.find((t) => /Anti|View-once/i.test(t))}`);
  });
});

describe('configuration round-trip', () => {
  test('each command flips its own group setting', async () => {
    const s = H.makeSock();
    await runCmd(s, '.antispam on');
    await runCmd(s, '.antiviewonce on');
    await runCmd(s, '.antibot on');
    await runCmd(s, '.antiforward on');
    await runCmd(s, '.antitagadmins on kick');
    await H.sleep(300);

    const gs = getGS();
    assert.equal(gs.antiSpam, true);
    assert.equal(gs.antiviewonce, true);
    assert.equal(gs.antibot, true);
    assert.equal(gs.antiforward, true);
    assert.equal(gs.antitagadmins, true);
    assert.equal(database.runAsBot(A, () => database.getAntiTagAdminsSettings(H.GROUP)).action, 'kick');
  });

  test('antiforward defaults its action to delete', () => {
    assert.equal(getGS().antiforwardAction, 'delete');
  });

  test('all five acknowledge the admin', async () => {
    const s = H.makeSock();
    await runCmd(s, '.antispam off');
    await runCmd(s, '.antispam on');
    await H.sleep(200);
    // .antiforward answers with a reaction rather than text, so text replies
    // and total sends are asserted separately.
    assert.ok(s._rec.sent.length >= 2, `${s._rec.sent.length} sends`);
  });

  test('a non-admin cannot change any of them', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('.antispam off', { sender: H.MEMBER }));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /admin/i.test(t)), 'should be told this is admin-only');
    assert.equal(getGS().antiSpam, true, 'the setting must not have changed');
  });
});

describe('antispam', () => {
  before(() => setGS({ antiSpam: true, antiSpamLimit: 3, antiSpamWindow: 60, antiSpamAction: 'delete' }));

  test('stays quiet below the threshold and deletes at it', async () => {
    const s = H.makeSock();
    // A sender nobody else in this run has used: the tracker is module-level
    // state keyed by (group, sender) and survives between dispatches.
    const spam = (t) => H.textMsg(t, { sender: H.SPAMMER });
    await run(s, spam('one'));
    await run(s, spam('two'));
    await H.sleep(150);
    assert.equal(s._rec.deletes.length, 0, 'two of three must not trigger');

    await run(s, spam('three'));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the third message must be deleted');
    assert.ok(s._rec.texts.some((t) => /Anti-Spam/i.test(t)), 'a notice must be posted');
  });

  test('admins are immune', async () => {
    const s = H.makeSock();
    for (let i = 0; i < 6; i++) await run(s, H.textMsg(`a${i}`, { sender: H.ADMIN }));
    await H.sleep(300);
    assert.equal(s._rec.deletes.length, 0);
  });
});

describe('antiviewonce', () => {
  before(() => setGS({ antiviewonce: true }));

  test('reveals a view-once image with the stubbed media stream', async () => {
    const s = H.makeSock();
    await run(s, viewOnceImage('secret'));
    await H.sleep(350);

    assert.equal(s._rec.images.length, 1, 'exactly one re-send');
    const sent = s._rec.images[0];
    assert.match(sent.caption, /View-once revealed/i);
    assert.match(sent.caption, /secret/, 'the original caption must survive');
    assert.ok(Buffer.isBuffer(sent.image));
    assert.equal(sent.image.toString(), 'FAKE_MEDIA_BYTES', 'the stub stream must reach the socket');
  });
});

describe('antibot', () => {
  before(() => setGS({ antibot: true }));

  test('removes an @hosted.lid agent account', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('beep boop', { sender: H.BOT_ACCOUNT }));
    await H.sleep(350);
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove' && k.participants.includes(H.BOT_ACCOUNT)),
      JSON.stringify(s._rec.kicks));
    assert.ok(s._rec.texts.some((t) => /AntiBot/i.test(t)));
  });

  test('leaves an ordinary member alone', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('beep boop', { sender: H.MEMBER, pushName: 'Normal Person' }));
    await H.sleep(300);
    assert.equal(s._rec.kicks.length, 0);
  });

  test('also catches bots by name pattern', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('hi', { sender: H.MEMBER, pushName: 'Cool Chatbot' }));
    await H.sleep(300);
    assert.ok(s._rec.kicks.some((k) => k.participants.includes(H.MEMBER)),
      'pushName matching /chatbot/i should be detected');
  });
});

describe('antiforward', () => {
  // This is the hook whose database contract was broken: the command read
  // settings.antiforward / antiforwardAction / antiforwardMaxWarnings while the
  // old database returned {enabled, warnLimit}, so its guard
  // `if (!settings.antiforward) return false` was always true and the feature
  // never ran at all.
  before(() => setGS({ antiforward: true, antiforwardAction: 'warn', antiforwardLimit: 2 }));

  test('the settings accessor exposes both naming conventions', () => {
    const cfg = database.runAsBot(A, () => database.getAntiforwardSettings(H.GROUP));
    assert.equal(cfg.antiforward, true);
    assert.equal(cfg.antiforwardAction, 'warn');
    assert.equal(cfg.antiforwardMaxWarnings, 2);
    assert.equal(cfg.enabled, true, 'original name kept for compatibility');
    assert.equal(cfg.warnLimit, 2);
  });

  test('warns on the first forward and removes at the limit', async () => {
    const s = H.makeSock();
    await run(s, forwarded());
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the forward must be deleted');
    assert.ok(s._rec.texts.some((t) => /AntiForward/.test(t) && /1\/2/.test(t)),
      s._rec.texts.filter((t) => /AntiForward/.test(t)).join(' | '));
    assert.equal(database.runAsBot(A, () => database.getAntiforwardWarningCount(H.GROUP, H.MEMBER)), 1);

    await run(s, forwarded());
    await H.sleep(350);
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove' && k.participants.includes(H.MEMBER)),
      JSON.stringify(s._rec.kicks));
    assert.equal(database.runAsBot(A, () => database.getAntiforwardWarningCount(H.GROUP, H.MEMBER)), 0,
      'strikes must reset after the removal');
  });

  test('clearing one member no longer wipes the whole group', () => {
    // The original clearAllAntiforwardWarnings(groupId) ignored the second
    // argument the command passed and cleared every warning in the group.
    database.runAsBot(A, () => {
      database.addAntiforwardWarning(H.GROUP, H.MEMBER);
      database.addAntiforwardWarning(H.GROUP, H.ADMIN);
      database.clearAllAntiforwardWarnings(H.GROUP, H.MEMBER);
    });
    assert.equal(database.runAsBot(A, () => database.getAntiforwardWarningCount(H.GROUP, H.MEMBER)), 0);
    assert.equal(database.runAsBot(A, () => database.getAntiforwardWarningCount(H.GROUP, H.ADMIN)), 1);
    database.runAsBot(A, () => database.clearWarnings(H.GROUP));
  });

  test('the command can switch action and limit without losing either', async () => {
    const s = H.makeSock();
    await runCmd(s, '.antiforward action kick');
    await H.sleep(250);
    assert.equal(database.runAsBot(A, () => database.getAntiforwardSettings(H.GROUP)).antiforwardAction, 'kick');

    await runCmd(s, '.antiforward warns 5');
    await H.sleep(250);
    const cfg = database.runAsBot(A, () => database.getAntiforwardSettings(H.GROUP));
    assert.equal(cfg.antiforwardMaxWarnings, 5);
    assert.equal(cfg.antiforwardAction, 'kick', 'changing the limit must not reset the action');

    const s2 = H.makeSock();
    await run(s2, forwarded());
    await H.sleep(300);
    assert.ok(s2._rec.kicks.some((k) => k.action === 'remove'), 'kick action must remove immediately');
  });

  test('the legacy three-argument call shape still works', () => {
    database.runAsBot(A, () => database.updateAntiforwardSettings(H.GROUP, true, 7));
    const cfg = database.runAsBot(A, () => database.getAntiforwardSettings(H.GROUP));
    assert.equal(cfg.antiforwardMaxWarnings, 7, 'a number in the action slot is the limit');
    assert.equal(cfg.antiforwardAction, 'kick', 'and must not be read as an action');
    database.runAsBot(A, () => database.updateAntiforwardSettings(H.GROUP, true, 'warn', 2));
  });
});

describe('antitagadmins', () => {
  before(() => database.runAsBot(A, () =>
    database.setAntiTagAdminsSettings(H.GROUP, { enabled: true, action: 'kick' })));

  test('removes a member who tags an admin', async () => {
    const s = H.makeSock();
    await run(s, taggingAdmin());
    await H.sleep(350);
    assert.ok(s._rec.deletes.length >= 1);
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove'), JSON.stringify(s._rec.kicks));
    assert.ok(s._rec.texts.some((t) => /AntiTagAdmins/i.test(t)));
  });

  test('tagging a non-admin does not trigger it', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({
      extendedTextMessage: { text: 'hey', contextInfo: { mentionedJid: [H.MEMBER] } },
    }));
    await H.sleep(300);
    assert.equal(s._rec.kicks.length, 0);
  });

  test('an admin tagging an admin is exempt', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({
      extendedTextMessage: { text: 'hey', contextInfo: { mentionedJid: [H.ADMIN] } },
    }, { sender: H.ADMIN }));
    await H.sleep(300);
    assert.equal(s._rec.deletes.length, 0);
    assert.equal(s._rec.kicks.length, 0);
  });

  test('an invalid action falls back rather than being stored', () => {
    const next = database.runAsBot(A, () =>
      database.setAntiTagAdminsSettings(H.GROUP, { enabled: true, action: 'nuke' }));
    assert.equal(next.action, 'warn');
    database.runAsBot(A, () => database.setAntiTagAdminsSettings(H.GROUP, { action: 'kick' }));
  });
});

describe('per-bot isolation of the hooks', () => {
  test('a second bot with nothing enabled takes no action at all', async () => {
    const gsB = getGS(B);
    for (const key of ['antiSpam', 'antiviewonce', 'antibot', 'antiforward', 'antitagadmins']) {
      assert.equal(gsB[key], false, `${key} should be off for bot B`);
    }

    const s = H.makeSock();
    for (let i = 0; i < 6; i++) await run(s, H.textMsg(`spam ${i}`), B);
    await run(s, forwarded(), B);
    await run(s, taggingAdmin(), B);
    await run(s, H.textMsg('x', { sender: H.BOT_ACCOUNT }), B);
    await run(s, viewOnceImage(), B);
    await H.sleep(350);

    assert.equal(s._rec.deletes.length, 0);
    assert.equal(s._rec.kicks.length, 0);
    assert.equal(s._rec.images.length, 0);
  });

  test('bot A still enforces its own settings', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('x', { sender: H.BOT_ACCOUNT }), A);
    await H.sleep(300);
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove'));
  });

  test('the settings are persisted per bot on disk', () => {
    database.flush();
    const gA = H.readBotFile(DATA, A)?.groups?.[H.GROUP] || {};
    for (const key of ['antiSpam', 'antiviewonce', 'antibot', 'antiforward', 'antitagadmins']) {
      assert.equal(gA[key], true, `bot A should have ${key} on disk`);
    }
    const gB = H.readBotFile(DATA, B)?.groups?.[H.GROUP];
    assert.ok(!gB || !gB.antiSpam, 'bot B must not have inherited them');
  });
});
