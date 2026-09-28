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
    assert.equal(handler.getCommandCount(), 36);  // the shipped set, see loader.test.js
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

describe('antiall content protections', () => {
  before(() => setGS({ antilink: true, antiimage: true, antiaudio: true, antisticker: true }));

  // A unique sender per test: antispam is left ON by the suite above (limit 3),
  // and its tracker is module-level per (group, sender) — shared senders would
  // trip it mid-describe.
  let __n = 0;
  const fresh = () => `2348071${String(++__n).padStart(5, '0')}@s.whatsapp.net`;

  test('antilink deletes a member link and posts a notice', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('check https://www.facebook.com/share today', { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the link message must be deleted');
    assert.ok(s._rec.texts.some((t) => /Anti-Link/i.test(t)), 'a notice must be posted');
  });

  test('plain text from the same member passes untouched', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('just words, nothing more', { sender: fresh() }));
    await H.sleep(250);
    assert.equal(s._rec.deletes.length, 0);
  });

  test('admins are immune', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('https://github.com/anything', { sender: H.ADMIN }));
    await H.sleep(250);
    assert.equal(s._rec.deletes.length, 0);
  });

  test('antiimage deletes a member photo', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({ imageMessage: { caption: 'photo' } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the image must be deleted');
    assert.ok(s._rec.texts.some((t) => /Anti-Image/i.test(t)));
  });

  test('antiaudio deletes a member voice note', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({ audioMessage: { ptt: true, mimetype: 'audio/ogg' } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the voice note must be deleted');
  });

  test('antivideo deletes a member video', async () => {
    setGS({ antilink: false, antiimage: false, antivideo: true });
    const s = H.makeSock();
    await run(s, H.makeMsg({ videoMessage: { mimetype: 'video/mp4' } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the video must be deleted');
    assert.ok(s._rec.texts.some((t) => /Anti-Video/i.test(t)));
  });

  test('antidocument deletes a member file', async () => {
    setGS({ antilink: false, antivideo: false, antidocument: true });
    const s = H.makeSock();
    await run(s, H.makeMsg({ documentMessage: { fileName: 'index.js', mimetype: 'text/javascript' } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the document must be deleted');
    assert.ok(s._rec.texts.some((t) => /Anti-File/i.test(t)));
  });

  test('antiimage deletes a VIEW-ONCE photo (unwrapped probe)', async () => {
    setGS({ antidocument: false, antiimage: true });
    const s = H.makeSock();
    await run(s, H.makeMsg(
      { viewOnceMessageV2: { message: { imageMessage: { caption: 'peek' } } } },
      { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'view-once images must not escape antiimage');
  });

  test('antisticker deletes a member sticker', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({ stickerMessage: { mimetype: 'image/webp' } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'the sticker must be deleted');
  });
});

describe('antiall master gate (pipeline-first)', () => {
  // unique sender per test (antispam's tracker is module-level per sender)
  let __mn = 0;
  const fresh = () => `2348072${String(++__mn).padStart(5, '0')}@s.whatsapp.net`;

  test('master ON deletes plain member text — by design, not a bug', async () => {
    database.runAsBot(A, () => database.setAntiAllEnabled(H.GROUP, true));
    setGS({ antilink: false, antiimage: false });
    const s = H.makeSock();
    await run(s, H.textMsg('hi, good morning', { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'master blocks all non-admin messages');
    database.setAntiAllEnabled(H.GROUP, false);
  });

  test('master ON deletes view-once media from members — gate runs first', async () => {
    database.runAsBot(A, () => database.setAntiAllEnabled(H.GROUP, true));
    setGS({ antilink: false, antiimage: false });
    const s = H.makeSock();
    await run(s, H.makeMsg({ viewOnceMessageV2: { message: { imageMessage: { caption: 'peek' } } } }, { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s._rec.deletes.length >= 1, 'view-once can no longer slip past the gate');
    database.setAntiAllEnabled(H.GROUP, false);
  });

  test('master OFF lets members chat, antilink still fires', async () => {
    database.runAsBot(A, () => database.setAntiAllEnabled(H.GROUP, false));
    setGS({ antilink: true, antiimage: false });
    const s = H.makeSock();
    await run(s, H.textMsg('just chatting, no links', { sender: fresh() }));
    await H.sleep(250);
    assert.equal(s._rec.deletes.length, 0, 'plain text must pass');

    const s2 = H.makeSock();
    await run(s2, H.textMsg('look https://example.com/x', { sender: fresh() }));
    await H.sleep(300);
    assert.ok(s2._rec.deletes.length >= 1, 'antilink still deletes');
  });
});

describe('antidelete detector (wdp stub-type port)', () => {
  test('non-revoke updates are ignored without error', async () => {
    const s = H.makeSock();
    await handler.handleMessagesUpdate(s, [
      { key: { remoteJid: H.GROUP, id: 'X1', participant: H.MEMBER }, update: { status: 3 } },
    ]);
  });

  test('a WAMessageStubType.REVOKE update recovers the stored message', async () => {
    database.setAntideleteMode('chat');
    const { WAMessageStubType } = require('@whiskeysockets/baileys');
    const s = H.makeSock();
    const secret = 'stub-recover-' + Date.now();
    await run(s, H.textMsg(secret, { sender: H.MEMBER, id: 'STUBSTORE1' }));
    await H.sleep(200);
    await handler.handleMessagesUpdate(s, [{
      // Real Baileys REVOKE shape: the REVOKED message's key rides at item.key
      key: { remoteJid: H.GROUP, id: 'STUBSTORE1', fromMe: false, participant: H.MEMBER },
      update: { messageStubType: WAMessageStubType.REVOKE },
    }]);
    await H.sleep(350);
    assert.ok(s._rec.texts.some((t) => t.includes(secret)), 'the original text must be re-sent');
    database.setAntideleteMode('off');
  });

  test('revoke with the key ONLY at update.key (production shape) recovers', async () => {
    database.setAntideleteMode('chat');
    const { WAMessageStubType } = require('@whiskeysockets/baileys');
    const s = H.makeSock();
    const secret = 'updatekey-recover-' + Date.now();
    await run(s, H.textMsg(secret, { sender: H.MEMBER, id: 'UKSTORE1' }));
    await H.sleep(200);
    await handler.handleMessagesUpdate(s, [{
      key: { remoteJid: H.GROUP, id: 'ENVELOPE-DOES-NOT-MATCH', participant: H.MEMBER },
      update: {
        messageStubType: WAMessageStubType.REVOKE,
        key: { remoteJid: H.GROUP, id: 'UKSTORE1', fromMe: false, participant: H.MEMBER },
      },
    }]);
    await H.sleep(350);
    assert.ok(s._rec.texts.some((t) => t.includes(secret)), 'update.key must be probed, not just item.key');
    database.setAntideleteMode('off');
  });

  test('revoke where update.key carries a DIFFERENT id than the outer key still recovers', async () => {
    database.setAntideleteMode('chat');
    const { WAMessageStubType } = require('@whiskeysockets/baileys');
    const s = H.makeSock();
    const secret = 'dualkey-recover-' + Date.now();
    await run(s, H.textMsg(secret, { sender: H.MEMBER, id: 'OUTERKEY1' }));
    await H.sleep(200);
    await handler.handleMessagesUpdate(s, [{
      // outer key = the ORIGINAL message (wdp's source); update.key = the
      // revoke envelope with its own id — both must be probed.
      key: { remoteJid: H.GROUP, id: 'OUTERKEY1', fromMe: false, participant: H.MEMBER },
      update: {
        messageStubType: WAMessageStubType.REVOKE,
        key: { remoteJid: H.GROUP, id: 'ENVELOPE-99', fromMe: false, participant: H.MEMBER },
      },
    }]);
    await H.sleep(350);
    assert.ok(s._rec.texts.some((t) => t.includes(secret)), 'outer-key id must be probed');
    database.setAntideleteMode('off');
  });

  test('protocolMessage fallback still works', async () => {
    database.setAntideleteMode('chat');
    const s = H.makeSock();
    const secret = 'proto-recover-' + Date.now();
    await run(s, H.textMsg(secret, { sender: H.MEMBER, id: 'PROTOSTORE1' }));
    await H.sleep(200);
    await handler.handleMessagesUpdate(s, [{
      key: { remoteJid: H.GROUP, id: 'P9', participant: H.MEMBER },
      update: { message: { protocolMessage: { type: 0, key: { remoteJid: H.GROUP, id: 'PROTOSTORE1', participant: H.MEMBER, fromMe: false } } } },
    }]);
    await H.sleep(350);
    assert.ok(s._rec.texts.some((t) => t.includes(secret)), 'the original text must be re-sent');
    database.setAntideleteMode('off');
  });
});

describe('antidemote / antipromote (wdp port)', () => {
  test('demote event with antidemote=revert re-promotes the victim', async () => {
    setGS({ antidemote: true, antidemoteAction: 'revert' });
    const s = H.makeSock();
    // The demoter must not be the bot itself or the owner; the call must run
    // inside the same bot context the settings were written to.
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s, {
      id: H.GROUP, action: 'demote', participants: [H.MEMBER], author: H.ADMIN,
    }));
    await H.sleep(350);
    const promote = s._rec.kicks.find((k) => k.action === 'promote');
    assert.ok(promote, 'the bot must re-promote the demoted admin');
    assert.ok(promote.participants.includes(H.MEMBER));
    assert.ok(s._rec.texts.some((t) => /AntiDemote/i.test(t)), 'a security alert must be posted');
  });

  test('does nothing when antidemote is off', async () => {
    setGS({ antidemote: false });
    const s = H.makeSock();
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s, {
      id: H.GROUP, action: 'demote', participants: [H.MEMBER], author: H.ADMIN,
    }));
    await H.sleep(250);
    assert.equal(s._rec.kicks.length, 0);
    assert.equal(s._rec.texts.length, 0);
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
