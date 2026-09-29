'use strict';

/**
 * The ..wdp mentor port: message utilities, group administration commands,
 * the warnings/mutes store, and the welcome/goodbye greeting hook.
 *
 * Everything here runs through the real handler.handleMessage() dispatch,
 * the same way test/dispatch.test.js does — the mentor's commands must work
 * unmodified against Jtest's `extra` contract.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-upgrade';
const A = 'bot-alpha';

// Fresh targets per concern — warnings/mutes are keyed by (group, user) and
// would leak between tests otherwise.
const T1 = '234805550001@s.whatsapp.net';   // kick / promote / demote target
const T2 = '234805550002@s.whatsapp.net';   // warn target
const T3 = '234805550003@s.whatsapp.net';   // mute target
const NEWCOMER = '2348044444444@s.whatsapp.net';

let database, handler, msgTools;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  msgTools = require(path.join(H.REPO, 'utils/msgTools.js'));
});

after(() => {
  H.teardown(handler, database);
});

const run = (sock, m) => H.dispatch(database, handler, A, sock, m);

/** A message whose contextInfo mentions jids (and optionally quotes someone). */
const mentionMsg = (text, jids, over = {}, quote = null) => H.makeMsg({
  extendedTextMessage: {
    text,
    contextInfo: {
      mentionedJid: jids,
      ...(quote ? { stanzaId: quote.id, participant: quote.author, quotedMessage: quote.message } : {}),
    },
  },
}, { sender: H.ADMIN, ...over });

const asAdmin = (text, over = {}) => H.textMsg(text, { sender: H.ADMIN, ...over });

// ─────────────────────────────────────────────────────────────────────────────

describe('msgTools (wdp helpers)', () => {
  test('getQuotedContext finds the quote through every reply wrapper', () => {
    const quoted = { conversation: 'the original' };
    for (const message of [
      { extendedTextMessage: { text: 'k', contextInfo: { quotedMessage: quoted } } },
      { buttonsResponseMessage: { selectedButtonId: 'x', contextInfo: { quotedMessage: quoted } } },
      { listResponseMessage: { title: 'x', contextInfo: { quotedMessage: quoted } } },
    ]) {
      const found = msgTools.getQuotedContext(H.makeMsg(message, { dm: true }));
      assert.ok(found, JSON.stringify(Object.keys(message)));
      assert.equal(found.quotedMessage, quoted);
    }
    assert.equal(msgTools.getQuotedContext(H.makeMsg({ conversation: 'no quote' }, { dm: true })), null);
  });

  test('resolveQuoted rebuilds a full message with the right key', () => {
    const r = msgTools.resolveQuoted(H.makeMsg({
      extendedTextMessage: {
        text: 'reply',
        contextInfo: { stanzaId: 'ST1', participant: H.MEMBER, quotedMessage: { conversation: 'orig' } },
      },
    }, { dm: true }));
    assert.equal(r.fullQuoted.key.id, 'ST1');
    assert.equal(r.fullQuoted.key.participant, H.MEMBER);
    assert.equal(r.fullQuoted.message.conversation, 'orig');
  });

  test('getTargets prefers mentions, then falls back to the quoted author', () => {
    const fromMention = msgTools.getTargets(mentionMsg('.x', [T1, T2], {}, null));
    assert.deepEqual(fromMention, [T1, T2]);

    const fromQuote = msgTools.getTargets(mentionMsg('.x', [], {},
      { id: 'Q1', author: H.MEMBER, message: { conversation: 'hi' } }));
    assert.deepEqual(fromQuote, [H.MEMBER]);

    assert.deepEqual(msgTools.getTargets(H.textMsg('.x', { dm: true })), []);
  });

  test('text and format helpers match the mentor contract', () => {
    assert.deepEqual(msgTools.parseMentions('hi @234812345678 and @234800000001'),
      ['234812345678@s.whatsapp.net', '234800000001@s.whatsapp.net']);
    assert.equal(msgTools.runtime(90061), '1d 1h 1m 1s');
    assert.equal(msgTools.formatDuration(3723000), '1h 2m 3s');
    assert.equal(msgTools.formatSize(1536), '1.5 KB');
    assert.ok(msgTools.isUrl('https://example.com/x'));
    assert.equal(msgTools.random([7]), 7);
  });
});

describe('group administration (wdp port)', () => {
  test('.kick removes the mentioned member and refuses self-kick', async () => {
    const s = H.makeSock();
    await run(s, mentionMsg('.kick @234805550001', [T1]));
    await H.sleep(150);
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove' && k.participants.includes(T1)),
      JSON.stringify(s._rec.kicks));

    const s2 = H.makeSock();
    await run(s2, mentionMsg(`.kick @${H.BOT.split('@')[0]}`, [H.BOT]));
    await H.sleep(150);
    assert.equal(s2._rec.kicks.length, 0, 'the bot must refuse to kick itself');
    assert.ok(s2._rec.texts.some((t) => /Cannot kick myself/i.test(t)), JSON.stringify(s2._rec.texts));
  });

  test('.kick refuses a non-admin', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({
      extendedTextMessage: { text: '.kick @234805550001', contextInfo: { mentionedJid: [T1] } },
    }, { sender: H.MEMBER }));
    await H.sleep(150);
    assert.equal(s._rec.kicks.length, 0);
    assert.ok(s._rec.texts.some((t) => /admin/i.test(t)), JSON.stringify(s._rec.texts));
  });

  test('.promote and .demote move admin rights', async () => {
    // T1 is not in the mock roster, so promote correctly refuses to touch it;
    // MEMBER and ADMIN are real participant rows.
    const s0 = H.makeSock();
    await run(s0, mentionMsg(`.promote @${T1.split('@')[0]}`, [T1]));
    await H.sleep(150);
    assert.equal(s0._rec.kicks.length, 0, 'a non-member must not be promoted');
    assert.ok(s0._rec.texts.some((t) => /not in this group/i.test(t)));

    const s = H.makeSock();
    await run(s, mentionMsg(`.promote @${H.MEMBER.split('@')[0]}`, [H.MEMBER]));
    await H.sleep(150);
    assert.ok(s._rec.kicks.some((k) => k.action === 'promote' && k.participants.includes(H.MEMBER)),
      JSON.stringify(s._rec.kicks));

    const s2 = H.makeSock();
    await run(s2, mentionMsg(`.demote @${H.ADMIN.split('@')[0]}`, [H.ADMIN]));
    await H.sleep(150);
    assert.ok(s2._rec.kicks.some((k) => k.action === 'demote' && k.participants.includes(H.ADMIN)));
  });

  test('.hidetag silently tags everyone and deletes the command', async () => {
    const s = H.makeSock();
    await run(s, asAdmin('.hidetag hello squad'));
    await H.sleep(150);
    assert.ok(s._rec.deletes.length >= 1, 'the command message must be deleted');
    const tagged = s._rec.sent.find((x) => x.content?.mentions);
    assert.ok(tagged, JSON.stringify(s._rec.texts));
    assert.equal(tagged.content.mentions.length, 3, 'all three mock participants');
    assert.equal(tagged.content.text, 'hello squad');
  });

  test('.staff lists the owner and admins', async () => {
    const s = H.makeSock();
    await run(s, asAdmin('.staff'));
    await H.sleep(150);
    const text = s._rec.texts.join('\n');
    assert.match(text, /GROUP STAFF/);
    assert.match(text, /Owner: @2348011111111/);
    assert.match(text, /Admins \(1\): @2348022222222/);
  });

  test('.grouplink and .revoke manage the invite link', async () => {
    const s = H.makeSock();
    s.groupInviteCode = async () => 'TESTCODE';
    await run(s, asAdmin('.grouplink'));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => t.includes('chat.whatsapp.com/TESTCODE')), JSON.stringify(s._rec.texts));

    const s2 = H.makeSock();
    let revoked = false;
    s2.groupInviteCode = async () => 'NEWCODE';
    s2.groupRevokeInvite = async () => { revoked = true; };
    await run(s2, asAdmin('.revoke'));
    await H.sleep(150);
    assert.ok(revoked, 'the old link must be revoked');
    assert.ok(s2._rec.texts.some((t) => t.includes('chat.whatsapp.com/NEWCODE')));
  });

  test('.setgname and .setgdesc update the group', async () => {
    const s = H.makeSock();
    const seen = {};
    s.groupUpdateSubject = async (jid, name) => { seen.subject = name; };
    s.groupUpdateDescription = async (jid, desc) => { seen.desc = desc; };
    await run(s, asAdmin('.setgname New Squad'));
    await run(s, asAdmin('.setgdesc Be excellent'));
    await H.sleep(150);
    assert.equal(seen.subject, 'New Squad');
    assert.equal(seen.desc, 'Be excellent');
    assert.ok(s._rec.texts.some((t) => /updated/i.test(t)));
  });
});

describe('warnings & mutes (the dormant store, now live)', () => {
  test('.warn counts up and removes at the limit', async () => {
    const s = H.makeSock();
    for (let i = 0; i < 3; i++) {
      await run(s, mentionMsg(`.warn @${T2.split('@')[0]} spamming`, [T2]));
      await H.sleep(80);
    }
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /Warnings: 3\/3/.test(t)), JSON.stringify(s._rec.texts));
    assert.ok(s._rec.texts.some((t) => /maximum warnings/i.test(t)));
    assert.ok(s._rec.kicks.some((k) => k.action === 'remove' && k.participants.includes(T2)),
      'the limit must trigger removal');
  });

  test('.resetwarn clears the record', async () => {
    await database.runAsBot(A, () => database.addWarning(H.GROUP, T2, 'x'));
    const s = H.makeSock();
    await run(s, mentionMsg(`.resetwarn @${T2.split('@')[0]}`, [T2]));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /Warnings Reset/.test(t)), JSON.stringify(s._rec.texts));
    const count = await database.runAsBot(A, () => database.getWarnings(H.GROUP, T2).count);
    assert.equal(count, 0);
  });

  test('.warn refuses to warn an admin', async () => {
    const s = H.makeSock();
    await run(s, mentionMsg(`.warn @${H.ADMIN.split('@')[0]}`, [H.ADMIN]));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /Cannot warn an admin/i.test(t)), JSON.stringify(s._rec.texts));
  });

  test('.mute / .unmute drive the handler\'s delete-on-sight list', async () => {
    const s = H.makeSock();
    await run(s, mentionMsg(`.mute @${T3.split('@')[0]}`, [T3]));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /User Muted/.test(t)), JSON.stringify(s._rec.texts));
    const muted = await database.runAsBot(A, () => database.isUserMuted(H.GROUP, T3));
    assert.equal(muted, true);

    const s2 = H.makeSock();
    await run(s2, mentionMsg(`.unmute @${T3.split('@')[0]}`, [T3]));
    await H.sleep(150);
    assert.ok(s2._rec.texts.some((t) => /User Unmuted/.test(t)));
    const still = await database.runAsBot(A, () => database.isUserMuted(H.GROUP, T3));
    assert.equal(still, false);
  });

  test('.mute with no target locks the group, .unmute reopens it', async () => {
    const modes = [];
    const s = H.makeSock();
    s.groupSettingUpdate = async (jid, mode) => { modes.push(mode); };
    await run(s, asAdmin('.mute'));
    await run(s, asAdmin('.unmute'));
    await H.sleep(150);
    assert.deepEqual(modes, ['announcement', 'not_announcement']);
    assert.ok(s._rec.texts.some((t) => /Group Locked/.test(t)));
    assert.ok(s._rec.texts.some((t) => /Group Reopened/.test(t)));
  });
});

describe('welcome / goodbye greetings (wdp port)', () => {
  test('stays dormant while the switches are off', async () => {
    const s = H.makeSock();
    await handler.handleParticipantsUpdate(s, {
      id: H.GROUP, participants: [NEWCOMER], action: 'add', author: H.ADMIN,
    });
    await H.sleep(150);
    assert.equal(s._rec.sent.length, 0, JSON.stringify(s._rec.texts));
  });

  test('.welcome on greets new members with the template variables filled', async () => {
    const s = H.makeSock();
    await run(s, asAdmin('.welcome on'));
    await run(s, asAdmin('.setwelcome Welcome @user to @group!'));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /Welcome messages enabled/.test(t)), JSON.stringify(s._rec.texts));
    assert.ok(s._rec.texts.some((t) => /updated/.test(t)));

    const s2 = H.makeSock();
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s2, {
      id: H.GROUP, participants: [NEWCOMER], action: 'add', author: H.ADMIN,
    }));
    await H.sleep(150);
    const greet = s2._rec.sent.find((x) => String(x.content?.caption || x.content?.text || '').includes('Welcome @2348044444444'));
    assert.ok(greet, JSON.stringify(s2._rec.texts));
    assert.ok((greet.content.caption || greet.content.text).includes('Test Group'));
    assert.deepEqual(greet.content.mentions, [NEWCOMER]);

    // off again → dormant
    await run(s2, asAdmin('.welcome off'));
    const s3 = H.makeSock();
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s3, {
      id: H.GROUP, participants: [NEWCOMER], action: 'add', author: H.ADMIN,
    }));
    await H.sleep(150);
    assert.ok(!s3._rec.texts.some((t) => /Welcome @/.test(t)), JSON.stringify(s3._rec.texts));
  });

  test('.goodbye on fires on leaves', async () => {
    const s = H.makeSock();
    await run(s, asAdmin('.goodbye on'));
    await run(s, asAdmin('.setgoodbye Bye @user, from @group'));
    await H.sleep(150);

    const s2 = H.makeSock();
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s2, {
      id: H.GROUP, participants: [NEWCOMER], action: 'remove', author: H.ADMIN,
    }));
    await H.sleep(150);
    const bye = s2._rec.sent.find((x) => String(x.content?.caption || x.content?.text || '').includes('Bye @2348044444444'));
    assert.ok(bye, JSON.stringify(s2._rec.texts));
    assert.ok((bye.content.caption || bye.content.text).includes('Test Group'));
    await run(s, asAdmin('.goodbye off'));
  });

  test('promote/demote events never greet', async () => {
    await database.runAsBot(A, () => database.updateGroupSettings(H.GROUP, { welcome: true, goodbye: true }));
    const s = H.makeSock();
    await database.runAsBot(A, () => handler.handleParticipantsUpdate(s, {
      id: H.GROUP, participants: [T1], action: 'promote', author: H.ADMIN,
    }));
    await H.sleep(150);
    assert.ok(!s._rec.texts.some((t) => /Welcome @|Bye @/.test(t)), JSON.stringify(s._rec.texts));
    await database.runAsBot(A, () => database.updateGroupSettings(H.GROUP, { welcome: false, goodbye: false }));
  });
});

describe('the enriched extra contract', () => {
  test('commands receive quoted, mentionedJid and text', async () => {
    // .warn resolves its target through extra-adjacent msgTools, and the
    // dispatch path itself passes quoted/mentionedJid/text — probe them via a
    // quoted-author warn (no @mention in contextInfo.mentionedJid).
    const s = H.makeSock();
    await run(s, H.makeMsg({
      extendedTextMessage: {
        text: '.warn off topic',
        contextInfo: {
          stanzaId: 'QEX', participant: T2,
          quotedMessage: { conversation: 'the offending message' },
        },
      },
    }, { sender: H.ADMIN }));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => /USER WARNING/.test(t) && t.includes('@234805550002')),
      JSON.stringify(s._rec.texts));
  });

  test('a document caption dispatches commands', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({ documentMessage: { caption: '.ping', mimetype: 'application/pdf' } }, { dm: true }));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /Speed:.*ms/.test(t)), JSON.stringify(s._rec.texts));
  });

  test('a button reply dispatches its prefixed id', async () => {
    const s = H.makeSock();
    await run(s, H.makeMsg({
      buttonsResponseMessage: { selectedButtonId: '.ping', selectedDisplayText: 'Ping!' },
    }, { dm: true }));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /Speed:.*ms/.test(t)), JSON.stringify(s._rec.texts));
  });
});
