'use strict';

/**
 * Message dispatch through the real handler.handleMessage().
 *
 * The command set is deliberately tiny (ping and uptime plus the five
 * moderation commands), so what matters here is that everything the 300-odd
 * removed commands used to touch still falls through silently instead of
 * throwing, and that bot mode gating works per bot.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-dispatch';
const A = 'bot-alpha';
const B = 'bot-beta';

let database, handler;
const noise = [];
const realError = console.error;
const realWarn = console.warn;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  // boot()'s `owners` option would write to the default bot; these tests
  // dispatch as bot-alpha, so the owner list belongs on that bot.
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
  await database.runAsBot(B, async () => database.setOwners([H.OWNER]));
  // Anything the handler logs at error/warn is a candidate regression, so it is
  // captured for the whole run and asserted on at the end.
  console.error = (...a) => noise.push('ERROR: ' + a.map((x) => x?.message || x).join(' ').slice(0, 200));
  console.warn = (...a) => noise.push('WARN : ' + a.map((x) => x?.message || x).join(' ').slice(0, 200));
});

after(() => {
  console.error = realError;
  console.warn = realWarn;
  H.teardown(handler, database);
});

const run = (sock, m, botId = A) => H.dispatch(database, handler, botId, sock, m);

describe('the shipped commands', () => {
  test('.ping replies and then edits with a measured latency', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.ping', { dm: true }));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /pong/i.test(t)), JSON.stringify(s._rec.texts));
    assert.ok(s._rec.texts.some((t) => /Speed:.*ms/.test(t)), JSON.stringify(s._rec.texts));
  });

  test('.ping uses the bot name from that bot\'s own settings', async () => {
    await database.runAsBot(A, async () => database.setBotSetting('botName', 'AlphaNamed'));
    await database.runAsBot(B, async () => database.setBotSetting('botName', 'BetaNamed'));

    const sa = H.makeDmSock();
    const sb = H.makeDmSock();
    await run(sa, H.textMsg('.ping', { dm: true }), A);
    await run(sb, H.textMsg('.ping', { dm: true }), B);
    await H.sleep(300);

    assert.ok(sa._rec.texts.some((t) => t.includes('AlphaNamed')), JSON.stringify(sa._rec.texts));
    assert.ok(sb._rec.texts.some((t) => t.includes('BetaNamed')), JSON.stringify(sb._rec.texts));
    assert.ok(!sa._rec.texts.some((t) => t.includes('BetaNamed')), 'bot names must not cross over');
  });

  test('.uptime reports a runtime', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.uptime', { dm: true }));
    await H.sleep(250);
    assert.ok(s._rec.texts.length >= 1, 'uptime must reply');
    assert.ok(s._rec.texts.some((t) => /uptime|runtime|second|minute|hour|day/i.test(t)),
      JSON.stringify(s._rec.texts).slice(0, 200));
  });

  test('every alias resolves to the same command', async () => {
    for (const alias of ['.pong', '.p']) {
      const s = H.makeDmSock();
      await run(s, H.textMsg(alias, { dm: true }));
      await H.sleep(200);
      assert.ok(s._rec.texts.some((t) => /pong|Speed/i.test(t)), `${alias} -> ${JSON.stringify(s._rec.texts)}`);
    }
    for (const alias of ['.runtime', '.up']) {
      const s = H.makeDmSock();
      await run(s, H.textMsg(alias, { dm: true }));
      await H.sleep(200);
      assert.ok(s._rec.texts.length >= 1, `${alias} must reply`);
    }
  });

  test('a configured prefix is honoured per bot', async () => {
    await database.runAsBot(B, async () => database.setBotSetting('prefix', '!'));
    const s = H.makeDmSock();
    await run(s, H.textMsg('!ping', { dm: true }), B);
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /pong|Speed/i.test(t)), 'B must answer !ping');

    const s2 = H.makeDmSock();
    await run(s2, H.textMsg('.ping', { dm: true }), B);
    await H.sleep(250);
    assert.ok(!s2._rec.texts.some((t) => /Speed/i.test(t)), 'B must no longer answer .ping');
    await database.runAsBot(B, async () => database.setBotSetting('prefix', '.'));
  });
});

describe('removed commands fall through silently', () => {
  const gone = ['.play', '.fancy', '.list', '.antilink', '.antibadword', '.groupstats',
    '.logomenu', '.docconvert', '.tictactoe', '.bomb', '.antiedit', '.anticall',
    '.antibug', '.autodownloadstatus'];

  for (const name of gone) {
    test(`${name} produces no crash and no user-visible output`, async () => {
      const s = H.makeDmSock();
      await run(s, H.textMsg(name, { dm: true }));
      await H.sleep(120);
      assert.equal(s._rec.texts.length, 0, `${name} replied: ${JSON.stringify(s._rec.texts)}`);
    });
  }

  test('an unrecognised command is silent rather than an error', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.definitelynotacommand', { dm: true }));
    await H.sleep(150);
    assert.equal(s._rec.texts.length, 0);
  });

  test('plain conversation produces no output', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('just chatting about the weather', { dm: true }));
    await H.sleep(150);
    assert.equal(s._rec.sent.length, 0);
  });
});

describe('bot mode gating is per bot', () => {
  test('private mode ignores a non-owner', async () => {
    await database.runAsBot(A, async () => database.setBotMode('private'));
    const s = H.makeDmSock();
    await run(s, H.textMsg('.ping', { dm: true }), A);
    await H.sleep(250);
    assert.equal(s._rec.texts.length, 0, 'a non-owner must be ignored in private mode');
  });

  test('private mode still answers the owner', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.ping', { dm: true, remoteJid: H.OWNER }), A);
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /pong|Speed/i.test(t)), JSON.stringify(s._rec.texts));
  });

  test('another bot in public mode is unaffected', async () => {
    assert.equal(database.runAsBot(B, () => database.getBotMode()), 'public');
    const s = H.makeDmSock();
    await run(s, H.textMsg('.ping', { dm: true }), B);
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /pong|Speed/i.test(t)),
      'bot B must keep answering while bot A is private');
    await database.runAsBot(A, async () => database.setBotMode('public'));
  });
});

describe('group traffic', () => {
  test('a group command from a member works', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('.ping'));
    await H.sleep(250);
    assert.ok(s._rec.texts.some((t) => /pong|Speed/i.test(t)));
  });

  test('group activity is counted for the right bot', async () => {
    const gs = require('path').join(H.REPO, 'utils/groupstats.js');
    const stats = require(gs);
    const today = new Date().toISOString().slice(0, 10);
    const s = H.makeSock();
    for (let i = 0; i < 4; i++) await run(s, H.textMsg(`chat ${i}`, { sender: H.MEMBER }), B);
    await H.sleep(200);
    stats.flush();
    database.flush();
    await H.sleep(100);
    const day = database.runAsBot(B, () => database.getGroupStat(H.GROUP, today));
    assert.ok(day && day.total >= 4, `expected >=4, got ${day?.total}`);
  });
});

describe('the restored commands respond', () => {
  test('.menu lists loaded commands and never absent ones', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.menu', { dm: true }));
    await H.sleep(200);
    assert.equal(s._rec.texts.length, 1, JSON.stringify(s._rec.texts));
    const text = s._rec.texts[0];
    for (const n of ['.menu', '.ping', '.sticker', '.antidelete', '.ttt2']) {
      assert.ok(text.includes(n), `menu must list ${n}`);
    }
    // Entry lines start at column 2; descriptions may mention other commands
    // in prose (ttt2's does), so only the entry lines count as advertising.
    for (const absent of ['.fancy', '.bomb', '.tictactoe', '.play']) {
      assert.ok(!new RegExp(`^\\s{2}\\${absent}\\b`, 'm').test(text),
        `menu must not advertise ${absent}`);
    }
  });

  test('.chatbot status reports the missing key instead of crashing', async () => {
    const s = H.makeSock();   // group: sender below is an admin, so the gate passes
    await run(s, H.textMsg('.chatbot status', { sender: H.ADMIN }));
    await H.sleep(200);
    assert.equal(s._rec.texts.length, 1, JSON.stringify(s._rec.texts));
    assert.ok(/Chatbot/.test(s._rec.texts[0]), s._rec.texts[0]);
    assert.ok(/MISSING/.test(s._rec.texts[0]), 'no CHATBOT_API_KEY in tests, so it must say MISSING');
  });

  test('.chatbot refuses non-admins', async () => {
    const s = H.makeSock();
    await run(s, H.textMsg('.chatbot on', { sender: H.MEMBER }));
    await H.sleep(200);
    assert.equal(s._rec.texts.length, 1, JSON.stringify(s._rec.texts));
    assert.ok(/Admins only/.test(s._rec.texts[0]), s._rec.texts[0]);
    // chatbot defaults to false in DEFAULT_GROUP_SETTINGS; a refused toggle
    // must leave it there. Read under the bot the dispatch ran as.
    const on = database.runAsBot(A, () => database.getGroupSettings(H.GROUP).chatbot);
    assert.equal(on, false, 'a refused toggle must not enable the chatbot');
  });

  test('.vv without a quoted view-once asks for one', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.vv', { dm: true }));
    await H.sleep(200);
    assert.equal(s._rec.texts.length, 1, JSON.stringify(s._rec.texts));
    assert.ok(/view-once/.test(s._rec.texts[0]), s._rec.texts[0]);
  });

  test('.save without a quoted status asks for one', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.save', { dm: true }));
    await H.sleep(200);
    assert.equal(s._rec.texts.length, 1, JSON.stringify(s._rec.texts));
    assert.ok(/status/.test(s._rec.texts[0]), s._rec.texts[0]);
  });

  test('.help answers with the rich card or its fallback, never a crash', async () => {
    const s = H.makeDmSock();
    await run(s, H.textMsg('.help', { dm: true }));
    await H.sleep(250);
    assert.ok(s._rec.texts.length >= 0); // rich path uses relayMessage, not sendMessage
    assert.ok(s._rec.relayed ? s._rec.relayed.length >= 1 : s._rec.texts.length >= 1,
      'help must produce either a relayed rich message or a fallback text');
  });
});

describe('no silent breakage', () => {
  test('nothing was logged at error or warn across the whole run', () => {
    const real = noise.filter((e) => !/404|forbidden|rate-overlimit/.test(e));
    assert.deepEqual(real, [], real.slice(0, 5).join('\n'));
  });
});
