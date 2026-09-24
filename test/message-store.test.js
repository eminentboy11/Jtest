// MESSAGE STORE TEST — LRU-bounded in-memory store (utils/messageStore.js)
// The unbounded chat list was the slow RAM climb that R14'd the Heroku dyno.

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const { EventEmitter } = require('events');
const assert = require('assert');

const { createMessageStore } = require('../utils/messageStore');

function mkMsg(id, jid, participant = null) {
  return { key: { id, remoteJid: jid, participant }, message: { conversation: `m${id}` }, messageTimestamp: Number(id) || 0 };
}

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  ❌ ${label}: ${err.message}`);
  }
}

(async () => {
  // ── 1. Per-chat cap ─────────────────────────────────────────────────────────
  console.log('per-chat cap');
  {
    const store = createMessageStore({ maxPerChat: 20, maxChats: 300 });
    for (let i = 1; i <= 25; i++) store.storeMessage('g1@g.us', mkMsg(`m${i}`, 'g1@g.us'));
    await check('chat holds exactly 20 messages', () => assert.strictEqual(store.messages.get('g1@g.us').size, 20));
    await check('oldest 5 evicted (m1 gone)', () => assert.strictEqual(store.messages.get('g1@g.us').has('m1'), false));
    await check('newest kept (m25 present)', () => assert.strictEqual(store.messages.get('g1@g.us').has('m25'), true));
  }

  // ── 2. Total chat cap ───────────────────────────────────────────────────────
  console.log('total chat cap');
  {
    const store = createMessageStore({ maxPerChat: 20, maxChats: 10 });
    for (let i = 1; i <= 12; i++) store.storeMessage(`c${i}@s.whatsapp.net`, mkMsg(`x${i}`, `c${i}@s.whatsapp.net`));
    await check('only 10 chats kept', () => assert.strictEqual(store.messages.size, 10));
    await check('oldest chats evicted (c1, c2 gone)', () => {
      assert.strictEqual(store.messages.has('c1@s.whatsapp.net'), false);
      assert.strictEqual(store.messages.has('c2@s.whatsapp.net'), false);
    });
    await check('newest chat kept (c12)', () => assert.strictEqual(store.messages.has('c12@s.whatsapp.net'), true));
  }

  // ── 3. LRU touch: an active chat survives, idle chats drop first ───────────
  console.log('LRU ordering');
  {
    const store = createMessageStore({ maxPerChat: 5, maxChats: 3 });
    store.storeMessage('a', mkMsg('a1', 'a'));
    store.storeMessage('b', mkMsg('b1', 'b'));
    store.storeMessage('c', mkMsg('c1', 'c'));
    store.storeMessage('a', mkMsg('a2', 'a')); // touch a → order b, c, a
    store.storeMessage('d', mkMsg('d1', 'd')); // evicts b (least recently used)
    await check('idle chat b evicted', () => assert.strictEqual(store.messages.has('b'), false));
    await check('touched chat a survives', () => assert.strictEqual(store.messages.has('a'), true));
    await check('c and d kept', () => {
      assert.strictEqual(store.messages.has('c'), true);
      assert.strictEqual(store.messages.has('d'), true);
    });
  }

  // ── 4. loadMessage ──────────────────────────────────────────────────────────
  console.log('loadMessage');
  {
    const store = createMessageStore();
    store.storeMessage('g@g.us', mkMsg('id1', 'g@g.us'));
    await check('known message resolves', async () => {
      const m = await store.loadMessage('g@g.us', 'id1');
      assert.ok(m && m.key.id === 'id1');
    });
    await check('unknown message → null', async () => {
      const m = await store.loadMessage('g@g.us', 'nope');
      assert.strictEqual(m, null);
    });
  }

  // ── 5. bind() feeds from messages.upsert ────────────────────────────────────
  console.log('bind()');
  {
    const store = createMessageStore({ maxPerChat: 20, maxChats: 300 });
    const ev = new EventEmitter();
    store.bind(ev);
    ev.emit('messages.upsert', {
      messages: [mkMsg('u1', 'gr@g.us', '1@s.whatsapp.net'), mkMsg('u2', 'gr@g.us', '2@s.whatsapp.net')],
    });
    await check('upsert batch stored', () => assert.strictEqual(store.messages.get('gr@g.us').size, 2));
  }

  // ── 6. evictOldestChats (watchdog escape hatch) ─────────────────────────────
  console.log('evictOldestChats');
  {
    const store = createMessageStore({ maxPerChat: 20, maxChats: 100 });
    for (let i = 1; i <= 10; i++) store.storeMessage(`e${i}`, mkMsg(`k${i}`, `e${i}`));
    const remaining = store.evictOldestChats(4);
    await check('evicts down to target', () => assert.strictEqual(remaining, 4));
    await check('oldest dropped (e1, e6 gone; e7, e10 kept)', () => {
      assert.strictEqual(store.messages.has('e1'), false);
      assert.strictEqual(store.messages.has('e6'), false);
      assert.strictEqual(store.messages.has('e7'), true);
      assert.strictEqual(store.messages.has('e10'), true);
    });
    await check('target below 0 is safe', () => assert.strictEqual(store.evictOldestChats(-5), 0));
  }

  // ── 7. Bad input is a no-op, never crashes ──────────────────────────────────
  console.log('bad input');
  {
    const store = createMessageStore();
    store.storeMessage(null, mkMsg('x', 'a'));
    store.storeMessage('a', null);
    store.storeMessage('a', { key: {} });
    store.storeMessage('a', {});
    await check('nothing stored, no crash', () => assert.strictEqual(store.messages.size, 0));
  }

  if (failures > 0) {
    console.error(`\n❌ message store: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✅ message store: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('message store test crashed:', err);
  process.exit(1);
});
