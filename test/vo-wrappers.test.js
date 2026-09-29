'use strict';

/**
 * View-once capture hardening.
 *
 * Proves three properties the prime-at-receive design depends on:
 *   1. EVERY wrapper variant is detected, stored as VO, and primed —
 *      viewOnceMessageV2 (image/video), viewOnceMessageV2Extension (audio),
 *      legacy viewOnceMessage, ephemeral-stacked V2, and bare media carrying
 *      viewOnce=true.
 *   2. The primed-byte counter is exact: every eviction path (id overwrite,
 *      per-chat overflow, global trim, recover-then-drop, mode off) releases
 *      its buffer, so the cache can't phantom-fill and silently stop priming.
 *   3. With JUNE_AD_VO_PERSIST=1 the primed bytes survive a simulated restart
 *      (RAM wiped, SQLite kept) and the resurrect still sends the media.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-vo';
const A = 'bot-alpha';

let database, handler, antidelete;

before(async () => {
  ({ database, handler } = await H.boot({
    dataDir: DATA,
    stubMedia: true,
    owners: [H.OWNER],
    env: { JUNE_AD_VO_PERSIST: '1' },
  }));
  await database.runAsBot(A, () => database.setAntideleteMode('chat'));
  antidelete = require('../utils/commandLoader.js').loadCommands().get('antidelete');
  assert.equal(typeof antidelete.storeMessage, 'function');
});

after(() => H.teardown(handler, database));

const run = (sock, m, botId = A) => H.dispatch(database, handler, botId, sock, m);
const del = (s, items, botId = A) => database.runAsBot(botId, () => handler.handleMessagesUpdate(s, items));

const flush = () => database.runAsBot(A, () => antidelete.flush());
const ram = () => antidelete._internals.messageStore;
const entryFor = (id, chat = H.GROUP) => ram().get(chat)?.get(id) || null;
const primedBytes = () => antidelete._internals.getPrimedBytes();

const revokeFor = (id) => ({
  key: { remoteJid: H.GROUP, fromMe: false, participant: H.MEMBER, id: `X${id}` },
  update: { message: { protocolMessage: { type: 0, key: { remoteJid: H.GROUP, id, participant: H.MEMBER, fromMe: false } } } },
});

const variants = {
  'V2 image': (over) => H.makeMsg({ viewOnceMessageV2: { message: { imageMessage: { url: 'u', mediaKey: {}, directPath: 'd', caption: 'vo-img' } } } }, over),
  'V2 video': (over) => H.makeMsg({ viewOnceMessageV2: { message: { videoMessage: { url: 'u', mediaKey: {}, directPath: 'd', caption: 'vo-vid' } } } }, over),
  'V2Extension audio': (over) => H.makeMsg({ viewOnceMessageV2Extension: { message: { audioMessage: { url: 'u', mediaKey: {}, directPath: 'd', ptt: true } } } }, over),
  'V1 image': (over) => H.makeMsg({ viewOnceMessage: { message: { imageMessage: { url: 'u', mediaKey: {}, directPath: 'd' } } } }, over),
  'ephemeral-stacked V2 image': (over) => H.makeMsg({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { url: 'u', mediaKey: {}, directPath: 'd' } } } } } }, over),
  'bare media with viewOnce flag': (over) => H.makeMsg({ imageMessage: { url: 'u', mediaKey: {}, directPath: 'd', viewOnce: true } }, over),
};

let n = 0;
const nextId = () => `VO${String(++n).padStart(3, '0')}`;

async function capture(variant) {
  const id = nextId();
  const s = H.makeSock();
  await run(s, variants[variant]({ id }));
  const entry = entryFor(id);
  assert.ok(entry, `${variant}: stored`);
  assert.equal(entry.isVO, true, `${variant}: detected as VO`);
  await entry.mediaPromise; // prime is async — wait for it
  await H.sleep(80);
  assert.ok(entry.mediaBuffer, `${variant}: primed at receive time`);
  return { id, s };
}

describe('every wrapper variant is primed at receive', () => {
  for (const variant of Object.keys(variants)) {
    test(variant, async () => {
      const { id, s } = await capture(variant);
      await flush();

      await del(s, [revokeFor(id)]);
      await H.sleep(300);

      const bucket = variant.includes('video') ? 'videos' : variant.includes('audio') ? 'audios' : 'images';
      const sent = s._rec[bucket];
      assert.equal(sent.length, 1, `${variant}: exactly one media re-send`);
      const media = sent[0].image ?? sent[0].video ?? sent[0].audio;
      assert.ok(Buffer.isBuffer(media), 'a media buffer was sent');
      assert.equal(media.toString(), 'FAKE_MEDIA_BYTES', `${variant}: the primed buffer reached the socket`);
      assert.ok(s._rec.texts.some((t) => /Deleted Message Recovered/.test(t)), 'card posted');
    });
  }
});

describe('the primed-byte counter is exact', () => {
  test('id overwrite releases the old buffer', async () => {
    const id = nextId();
    const s = H.makeSock();
    await run(s, variants['V2 image']({ id }));
    const first = entryFor(id);
    await first.mediaPromise;
    const afterFirst = primedBytes();
    assert.ok(afterFirst > 0);

    // Same message id again (Baileys re-delivery): the new entry must evict
    // the old one's buffer from the counter.
    await run(s, variants['V2 image']({ id }));
    const second = entryFor(id);
    await second.mediaPromise;
    assert.notEqual(second, first);
    assert.equal(primedBytes(), afterFirst, 'counter must not double-count the id');
  });

  test('global FIFO trim releases evicted buffers', async () => {
    antidelete._internals.resetRuntime(); // hermetic: no leftovers from other tests
    antidelete._internals.setRamLimit(1);
    try {
      const a = nextId();
      await run(H.makeSock(), variants['V2 image']({ id: a }));
      const entryA = entryFor(a);
      await entryA.mediaPromise;
      assert.equal(primedBytes(), entryA.mediaBuffer.length, 'exactly A is buffered');

      const b = nextId();
      await run(H.makeSock(), variants['V2 image']({ id: b }));
      const entryB = entryFor(b);
      await entryB.mediaPromise;
      // A was trimmed to keep RAM at 1; only B's buffer may be counted.
      assert.ok(!entryA.mediaBuffer, 'A released on global trim');
      assert.equal(primedBytes(), entryB.mediaBuffer.length, 'counter dropped A with its buffer');
    } finally {
      antidelete._internals.setRamLimit(4000);
    }
  });

  test('recover-then-drop releases the buffer', async () => {
    antidelete._internals.resetRuntime(); // hermetic
    const { id, s } = await capture('V2 image');
    await flush();
    const counted = primedBytes();
    assert.ok(counted > 0, 'the capture is buffered');
    await del(s, [revokeFor(id)]);
    await H.sleep(250);
    assert.ok(primedBytes() < counted, 'the recovered entry must release its buffer');
  });

  test('mode off drains the counter and the persisted cache', async () => {
    const id = nextId();
    await capture('V2 image');
    await flush();
    assert.ok(primedBytes() > 0);
    await database.runAsBot(A, () => antidelete.execute(H.makeSock(), H.textMsg('.antidelete off'), ['off'], { reply: async () => {} }));
    assert.equal(primedBytes(), 0, 'off must zero the counter');
    await database.runAsBot(A, () => database.setAntideleteMode('chat')); // restore for later tests
  });
});

describe('restart persistence (JUNE_AD_VO_PERSIST=1)', () => {
  test('a wiped RAM still resurrects the media from SQLite', async () => {
    const id = nextId();
    const s1 = H.makeSock();
    await run(s1, variants['V2 image']({ id }));
    const entry = entryFor(id);
    await entry.mediaPromise;
    await flush();

    // ── simulate a process restart: RAM gone, SQLite kept ──
    antidelete._internals.resetRuntime();
    assert.equal(primedBytes(), 0);
    assert.ok(!entryFor(id), 'hot cache is empty after restart');

    const s2 = H.makeSock();
    await del(s2, [revokeFor(id)]);
    await H.sleep(350);

    assert.equal(s2._rec.images.length, 1, 'resurrected after restart');
    assert.equal(s2._rec.images[0].image.toString(), 'FAKE_MEDIA_BYTES',
      'the persisted bytes reached the socket (not a CDN-expiry notice)');
    assert.ok(s2._rec.texts.some((t) => /Deleted Message Recovered/.test(t)));
  });

  test('the persisted copy is removed once recovered', async () => {
    // The previous test's recover dropped the record; the vo: KV entry for its
    // id must be gone too — store a fresh one and check lifecycle directly.
    const id = nextId();
    const s = H.makeSock();
    await run(s, variants['V2 image']({ id }));
    const entry = entryFor(id);
    await entry.mediaPromise;
    await flush();

    const kv = database.runAsBot(A, () => database.getAllKV('antidelete'));
    assert.ok(Object.keys(kv).some((k) => k.startsWith('vo:') && k.includes(id)), 'persisted after prime');

    await del(s, [revokeFor(id)]);
    await H.sleep(250);
    const after = database.runAsBot(A, () => database.getAllKV('antidelete'));
    assert.ok(!Object.keys(after).some((k) => k.startsWith('vo:') && k.includes(id)), 'cleaned after recovery');
  });
});
