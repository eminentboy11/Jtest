'use strict';

/**
 * `.clean` — deletes recent messages in the group.
 *
 * This command was broken in a way nothing caught: it read `store.messages` out
 * of `require('../../index')`, but index.js exports nothing, so `store` was
 * always `undefined` and every call threw. It now reads the antidelete replay
 * cache, which is the only message history Jtest keeps. These tests pin that:
 *
 *   - it reads the expected source (KV namespace 'antidelete', msg:<chat>|<id>)
 *   - it deletes newest-first
 *   - a reply narrows the deletion to that sender
 *   - it never touches the process, and never requires the entry point
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-clean';
const A = 'bot-alpha';

let database, handler;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  await database.runAsBot(A, async () => database.setOwners([H.OWNER]));
});

after(() => H.teardown(handler, database));

const run = (sock, m) => H.dispatch(database, handler, A, sock, m);

/** Seed the antidelete cache the way the real capture path does. */
function seed(chatId, entries) {
  return database.runAsBot(A, async () => {
    for (const e of entries) {
      database.saveAntideleteMessage(chatId, e.id, {
        sender: e.sender,
        timestamp: e.ts,
        type: 'text',
        text: 'x',
      }, e.ts);
    }
  });
}

describe('.clean', () => {
  test('reports when the cache holds nothing for this chat', async () => {
    const sock = H.makeSock();
    await run(sock, H.textMsg('.clean 5', { sender: H.ADMIN }));
    assert.equal(sock._rec.texts.length, 1);
    assert.match(sock._rec.texts[0], /No stored messages/i);
  });

  test('deletes the requested number, newest first', async () => {
    await seed(H.GROUP, [
      { id: 'M1', sender: H.MEMBER, ts: 1000 },
      { id: 'M2', sender: H.MEMBER, ts: 2000 },
      { id: 'M3', sender: H.MEMBER, ts: 3000 },
    ]);

    const sock = H.makeSock();
    await run(sock, H.textMsg('.clean 2', { sender: H.ADMIN }));

    const deleted = sock._rec.deletes;
    assert.equal(deleted.length, 2, 'two deletes sent');
    assert.deepEqual(deleted.map((d) => d.id), ['M3', 'M2'], 'newest two, in order');
    assert.equal(sock._rec.texts.at(-1).includes('2'), true);
  });

  test('a reply narrows the deletion to the quoted sender', async () => {
    const chat = '120363000000000001@g.us';
    await seed(chat, [
      { id: 'A1', sender: H.MEMBER, ts: 1000 },
      { id: 'A2', sender: H.ADMIN, ts: 2000 },
      { id: 'A3', sender: H.MEMBER, ts: 3000 },
    ]);

    const sock = H.makeSock();
    const m = H.makeMsg({
      extendedTextMessage: {
        text: '.clean 5',
        contextInfo: { participant: H.MEMBER, quotedMessage: { conversation: 'hi' } },
      },
    }, { remoteJid: chat, sender: H.ADMIN });

    await run(sock, m);
    const deleted = sock._rec.deletes;
    assert.equal(deleted.length, 2);
    assert.deepEqual(deleted.map((d) => d.id).sort(), ['A1', 'A3'], 'only MEMBER messages');
    assert.ok(deleted.every((d) => d.participant === H.MEMBER));
  });

  test('rejects a bad count without touching anything', async () => {
    const sock = H.makeSock();
    await run(sock, H.textMsg('.clean nope', { sender: H.ADMIN }));
    assert.equal(sock._rec.deletes.length, 0);
    assert.match(sock._rec.texts[0], /valid number/i);
  });

  test('the module reads no message store and requires no entry point', () => {
    // comments are stripped first: the header explains what the OLD code did,
    // and naming `require('../../index')` in prose is not the same as calling it
    const src = fs.readFileSync(path.join(H.REPO, 'commands/admin/clean.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/require\(\s*['"][^'"]*index['"]\s*\)/.test(src),
      'must not require index.js — it exports nothing and boot-loads the platform');
    assert.ok(!/process\.(exit|kill|abort)/.test(src), 'must never end the process');
    assert.match(src, /getAllKV\('antidelete'\)/, 'reads the antidelete cache');
  });
});
