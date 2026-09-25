'use strict';

/**
 * Shared harness for the test/ suite.
 *
 * Every test file runs in its own process under `node --test`, so boot() can
 * own the environment: it points the JSON store at a throwaway directory, sets
 * the globals the command files expect, and hands back the real database and
 * handler modules. Nothing here mocks the code under test — the mocks are only
 * at the edges (the WhatsApp socket and, optionally, Baileys' media downloader).
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// ── fixtures ────────────────────────────────────────────────────────────────
const GROUP = '120363000000000000@g.us';
const DM = '2348012345678@s.whatsapp.net';
const BOT = '2348011111111@s.whatsapp.net';
const ADMIN = '2348022222222@s.whatsapp.net';
const MEMBER = '2348033333333@s.whatsapp.net';
const OWNER = '2348099999999@s.whatsapp.net';
// antibot treats these server suffixes as WhatsApp API agent accounts
const BOT_ACCOUNT = '99999@hosted.lid';
// antispam keeps a module-level (group, sender) tracker that outlives a single
// dispatch, so tests that assert an exact threshold need a sender nobody else
// in the run has messaged as.
const SPAMMER = '2348077777777@s.whatsapp.net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stub Baileys' downloadContentFromMessage, which antiviewonce destructures at
 * require time. That export is an ESM live binding (configurable: false), so it
 * cannot be monkey-patched; replacing the cached module exports with a Proxy
 * that serves a fake stream for that one key works and leaves jidDecode and
 * jidEncode real for handler.js. Must be called BEFORE handler.js is required.
 */
function stubMediaDownload(bytes = 'FAKE_MEDIA_BYTES') {
  const bp = require.resolve(path.join(REPO, 'node_modules/@whiskeysockets/baileys'));
  const real = require(bp);
  require.cache[bp].exports = new Proxy(real, {
    get(target, key) {
      if (key === 'downloadContentFromMessage') {
        return async () => (async function* () { yield Buffer.from(bytes); })();
      }
      return target[key];
    },
  });
}

/**
 * Prepare the process and load the real modules.
 *
 * @param {object} opts
 * @param {string} opts.dataDir   throwaway JUNE_DATA_DIR for this file
 * @param {boolean} [opts.stubMedia]  install the Baileys media stub first
 * @param {string[]} [opts.owners]    seed the default bot's owner list
 */
async function boot(opts = {}) {
  const dataDir = opts.dataDir || '/tmp/jtest-test-data';
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  process.env.JUNE_DATA_DIR = dataDir;
  process.env.JUNE_DB_FLUSH_MS = String(opts.flushMs || 40);
  process.chdir(REPO);
  if (!module.paths.includes(path.join(REPO, 'node_modules'))) {
    module.paths.unshift(path.join(REPO, 'node_modules'));
  }
  global.__CORE__ = REPO;
  global.__ROOT__ = REPO;

  if (opts.stubMedia) stubMediaDownload(opts.mediaBytes);

  const database = require(path.join(REPO, 'database.js'));
  const handler = require(path.join(REPO, 'handler.js'));
  await database.ready;
  // utils/groupstats.js flips its own ready flag off database.ready
  await sleep(opts.settleMs || 120);

  if (opts.owners) database.setOwners(opts.owners);

  return { database, handler, dataDir, REPO };
}

/** Recording mock WhatsApp socket. */
function makeSock(over = {}) {
  const rec = {
    sent: [], deletes: [], texts: [], images: [], videos: [], audios: [],
    kicks: [], reacts: [], presences: [], relayed: [],
  };
  const participants = over.participants || [
    { id: BOT, admin: 'superadmin' },
    { id: ADMIN, admin: 'admin' },
    { id: MEMBER, admin: null },
  ];
  const sock = {
    user: { id: over.selfId || BOT, name: over.selfName || 'TestBot' },
    _rec: rec,
    sendMessage: async (jid, content) => {
      rec.sent.push({ jid, content });
      if (content?.delete) rec.deletes.push(content.delete);
      if (content?.react) rec.reacts.push(content.react.text);
      if (typeof content?.text === 'string') rec.texts.push(content.text);
      if (content?.image) rec.images.push(content);
      if (content?.video) rec.videos.push(content);
      if (content?.audio) rec.audios.push(content);
      return { key: { remoteJid: jid, fromMe: true, id: 'S' + rec.sent.length } };
    },
    // The rich-app channel (help, ttt2, tod, snake) sends through
    // relayMessage, not sendMessage, so it needs its own recorder.
    relayMessage: async (jid, content, opts) => {
      rec.relayed.push({ jid, content, opts });
      return { key: { remoteJid: jid, fromMe: true, id: 'R' + rec.relayed.length } };
    },
    groupParticipantsUpdate: async (jid, parts, action) => {
      rec.kicks.push({ jid, participants: parts, action });
      return {};
    },
    groupMetadata: over.groupMetadata || (async (jid) => ({
      id: jid || GROUP,
      subject: over.subject || 'Test Group',
      subjectOwner: OWNER,
      desc: 'a test group',
      participants,
    })),
    sendPresenceUpdate: async (p) => { rec.presences.push(p); },
    presenceSubscribe: async () => {},
    fetchPrivacySettings: async () => ({}),
    fetchStatus: async () => [],
    profilePictureUrl: async () => { throw new Error('404'); },
    onWhatsApp: async () => [],
    sendMessageAck: async () => {},
    groupSettingUpdate: async () => {},
    updateBlockStatus: async () => {},
  };
  return sock;
}

/** A socket whose groupMetadata is forbidden, for private-chat tests. */
function makeDmSock(over = {}) {
  return makeSock({
    ...over,
    groupMetadata: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); },
  });
}

/** Build a Baileys-shaped message. */
function makeMsg(message, over = {}) {
  return {
    key: {
      remoteJid: over.remoteJid || (over.dm ? DM : GROUP),
      fromMe: !!over.fromMe,
      id: over.id || 'M' + Math.random().toString(36).slice(2, 9),
      ...(over.dm ? {} : { participant: over.sender || MEMBER }),
      ...(over.key || {}),
    },
    message,
    pushName: over.pushName || 'Tester',
    messageType: 'conversation',
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

const textMsg = (text, over = {}) => makeMsg({ conversation: text }, over);

/**
 * Dispatch exactly the way index.js does: wrapped in database.runAsBot so every
 * database call made while handling the message is attributed to that bot.
 */
function dispatch(database, handler, botId, sock, m) {
  return database.runAsBot(botId, async () => {
    global.currentSock = sock;
    global.botState = 'connected';
    global.__BOT_ID__ = botId;
    await handler.handleMessage(sock, m);
  });
}

/**
 * Release everything boot() opened, so a test file's process can exit on its
 * own. handler.js starts an fs.watch at require time and the store debounces
 * writes on timers; without this the runner waits forever.
 */
function teardown(handler, database) {
  try { handler?.closeCommandWatcher?.(); } catch (_) {}
  try { global.__JUNE_FLUSH_GROUP_STATS?.(); } catch (_) {}
  try { database?.shutdownDatabase?.(); } catch (_) {}
}

/** Read a bot's JSON file straight off disk. */
function readBotFile(dataDir, botId) {
  const f = path.join(dataDir, `${botId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

module.exports = {
  REPO, GROUP, DM, BOT, ADMIN, MEMBER, OWNER, BOT_ACCOUNT, SPAMMER,
  sleep, boot, stubMediaDownload, makeSock, makeDmSock, makeMsg, textMsg,
  dispatch, readBotFile, teardown,
};
