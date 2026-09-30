'use strict';

/**
 * The nsfw / detect link gates and .snipe.
 *
 * `nsfw` and `detect` both shipped in DEFAULT_GROUP_SETTINGS as dormant keys
 * that nothing in the codebase read. These tests pin the behaviour that now
 * backs them, and — just as importantly — pin the *defaults*, because both are
 * inert settings whose safety depends on which way they fall:
 *
 *   nsfw   OFF by default -> adult links are removed
 *   detect OFF by default -> nothing is scanned
 *
 * .snipe is covered here too: it reports from antidelete's delete record rather
 * than keeping a second copy of every message, so the interesting cases are the
 * dependency being off, and a real delete flowing through.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-gates';
const A = 'bot-gates';

let database, handler, gates;

const run = (sock, m, botId = A) => H.dispatch(database, handler, botId, sock, m);
const setGS = (patch) => database.runAsBot(A, () => database.updateGroupSettings(H.GROUP, patch));
const getGS = () => database.runAsBot(A, () => database.getGroupSettings(H.GROUP));
const setAdMode = (mode) => database.runAsBot(A, () => database.setAntideleteMode(mode));
/** Drive a revoke exactly the way index.js does (inside runAsBot). */
const del = (s, items) => database.runAsBot(A, () => handler.handleMessagesUpdate(s, items));

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  gates = require(path.join(H.REPO, 'utils/contentGates.js'));
});

after(() => H.teardown(handler, database));

// ── classification ──────────────────────────────────────────────────────────
describe('contentGates classification', () => {
  test('adult domains match the registrable host and any subdomain', () => {
    for (const url of [
      'https://pornhub.com/view_video.php?viewkey=1',
      'https://www.pornhub.com/a',
      'https://m.xvideos.com/v',
      'http://onlyfans.com/user',
    ]) {
      assert.ok(gates.findNsfwLink(url), `${url} should be flagged as nsfw`);
    }
  });

  test('a lookalike host that merely contains a brand name does not match', () => {
    // Substring matching would flag this; registrable-host matching must not.
    assert.equal(gates.findNsfwLink('https://notpornhub.com.evil.co/a'), null);
  });

  test('each deception signal is classified distinctly', () => {
    assert.equal(gates.classifyLink('http://192.168.1.1/login'), 'ip-literal');
    assert.equal(gates.classifyLink('https://xn--80ak6aa92e.com/a'), 'punycode');
    assert.equal(gates.classifyLink('https://bit.ly/3xyzabc'), 'shortener');
    assert.equal(gates.classifyLink('https://cheap-pills.zip/offer'), 'tld:zip');
  });

  test('ordinary links are left alone', () => {
    for (const url of [
      'https://github.com/eminentboy11/Jtest',
      'https://example.com',
      'https://www.bbc.co.uk/news',
    ]) {
      assert.equal(gates.classifyLink(url), null, `${url} should not be flagged`);
    }
  });

  test('the two gates do not overlap', () => {
    const adult = 'https://pornhub.com/a';
    assert.ok(gates.findNsfwLink(adult), 'nsfw gate catches it');
    assert.equal(gates.findSuspiciousLink(adult), null,
      'the scam gate must not also claim it — each notice should name one cause');
  });

  test('malformed input never throws and never matches', () => {
    for (const bad of ['', null, undefined, 'http://', 'www.', 'just text', 42]) {
      assert.doesNotThrow(() => gates.findNsfwLink(bad));
      assert.doesNotThrow(() => gates.findSuspiciousLink(bad));
      assert.equal(gates.findNsfwLink(bad), null);
    }
  });
});

// ── nsfw gate ───────────────────────────────────────────────────────────────
describe('nsfw gate enforcement', () => {
  test('an adult link from a member is removed while the filter is OFF (default)', async () => {
    setGS({ nsfw: false });
    const s = H.makeSock();
    await run(s, H.textMsg('look at https://www.pornhub.com/view_video.php?viewkey=1',
      { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(s._rec.deletes.length, 1, 'the offending message must be deleted');
    assert.ok(s._rec.texts.some((t) => t.includes('NSFW')), 'the notice must name the gate');
  });

  test('turning the filter ON lets the same link through', async () => {
    setGS({ nsfw: true });
    const s = H.makeSock();
    await run(s, H.textMsg('https://www.pornhub.com/a', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(s._rec.deletes.length, 0, 'an admin opted in, so nothing is removed');
    setGS({ nsfw: false });
  });

  test('an admin is never gated by it', async () => {
    setGS({ nsfw: false });
    const s = H.makeSock();
    await run(s, H.textMsg('https://xvideos.com/a', { sender: H.ADMIN }));
    await H.sleep(200);
    assert.equal(s._rec.deletes.length, 0, 'gates apply to non-admins only');
  });
});

// ── detect gate ─────────────────────────────────────────────────────────────
describe('detect gate enforcement', () => {
  test('nothing is scanned while detect is OFF (default)', async () => {
    setGS({ detect: false });
    const s = H.makeSock();
    await run(s, H.textMsg('login at http://192.168.1.1/login', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(s._rec.deletes.length, 0, 'scanning is opt-in per group');
  });

  test('a deceptive link is removed once detect is ON', async () => {
    setGS({ detect: true });
    const s = H.makeSock();
    await run(s, H.textMsg('login at http://192.168.1.1/login', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(s._rec.deletes.length, 1, 'the deceptive link must be removed');
    assert.ok(s._rec.texts.some((t) => t.includes('Suspicious Link')),
      'the notice must name the gate');
    setGS({ detect: false });
  });

  test('a shortener is flagged but an ordinary link is not', async () => {
    setGS({ detect: true });

    const hidden = H.makeSock();
    await run(hidden, H.textMsg('claim now https://bit.ly/3xyzabc', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(hidden._rec.deletes.length, 1, 'a shortener hides the destination');

    const clean = H.makeSock();
    await run(clean, H.textMsg('read https://github.com/eminentboy11/Jtest', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(clean._rec.deletes.length, 0, 'an ordinary link must pass');

    setGS({ detect: false });
  });
});

// ── the commands ────────────────────────────────────────────────────────────
describe('.nsfw and .detect commands', () => {
  test('.nsfw reports status and persists both directions', async () => {
    setGS({ nsfw: false });
    const s = H.makeSock();

    await run(s, H.textMsg('.nsfw status', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => t.includes('NSFW Filter')), 'status must be reported');

    await run(s, H.textMsg('.nsfw on', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.equal(getGS().nsfw, true, 'the setting must persist');

    await run(s, H.textMsg('.nsfw off', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.equal(getGS().nsfw, false, 'and turn back off');
  });

  test('.detect reports status and persists both directions', async () => {
    setGS({ detect: false });
    const s = H.makeSock();

    await run(s, H.textMsg('.detect status', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => t.includes('Scam Link Detection')), 'status must be reported');

    await run(s, H.textMsg('.detect on', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.equal(getGS().detect, true, 'the setting must persist');

    await run(s, H.textMsg('.detect off', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.equal(getGS().detect, false);
  });

  test('a non-admin cannot toggle either one', async () => {
    setGS({ nsfw: false, detect: false });
    const s = H.makeSock();

    await run(s, H.textMsg('.nsfw on', { sender: H.MEMBER }));
    await run(s, H.textMsg('.detect on', { sender: H.MEMBER }));
    await H.sleep(200);

    assert.equal(getGS().nsfw, false, 'adminOnly must be enforced for .nsfw');
    assert.equal(getGS().detect, false, 'adminOnly must be enforced for .detect');
  });

  test('an unknown option is rejected rather than silently ignored', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('.nsfw maybe', { sender: H.ADMIN }));
    await H.sleep(150);
    assert.ok(s._rec.texts.some((t) => t.includes('Invalid option')),
      'a typo must not look like it worked');
  });
});

// ── snipe ───────────────────────────────────────────────────────────────────
describe('.snipe', () => {
  test('explains the antidelete dependency instead of claiming the chat is clean', async () => {
    setAdMode('off');
    const s = H.makeSock();
    await run(s, H.textMsg('.snipe', { sender: H.ADMIN }));
    await H.sleep(200);
    assert.ok(s._rec.texts.some((t) => t.includes('needs antidelete')),
      'with antidelete off nothing was captured, and snipe must say so');
  });

  test('reports who deleted what, once antidelete captured it', async () => {
    const { WAMessageStubType } = require('@whiskeysockets/baileys');
    setAdMode('chat');

    const marker = `snipe-marker-${Date.now()}`;
    const s = H.makeSock();

    // A member sends, then revokes.
    await run(s, H.textMsg(marker, { sender: H.MEMBER, id: 'SNIPEID1' }));
    await H.sleep(250);
    await del(s, [{
      key: { remoteJid: H.GROUP, id: 'SNIPEID1', fromMe: false, participant: H.MEMBER },
      update: { messageStubType: WAMessageStubType.REVOKE },
    }]);
    await H.sleep(350);

    const s2 = H.makeSock();
    await run(s2, H.textMsg('.snipe', { sender: H.ADMIN }));
    await H.sleep(250);

    const report = s2._rec.texts.find((t) => t.includes('Recently deleted'));
    assert.ok(report, 'snipe must produce a report');
    assert.ok(report.includes(marker), 'the report must include the deleted text');
    assert.ok(report.includes(`@${H.MEMBER.split('@')[0]}`), 'and name the sender');

    setAdMode('off');
  });

  test('a quiet chat reports nothing deleted', async () => {
    setAdMode('chat');
    // The delete recorded by the test above belongs to the same group, so clear
    // it explicitly rather than relying on test order.
    require(path.join(H.REPO, 'commands/owner/antidelete')).clearRecentDeletes();
    const s = H.makeSock();
    await run(s, H.textMsg('.snipe', { sender: H.ADMIN }));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => t.includes('Nothing deleted')),
      'a chat with no deletes must say so plainly');
    setAdMode('off');
  });
});
