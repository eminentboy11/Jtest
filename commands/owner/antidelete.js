'use strict';

/**
 * AntiDelete — recovers deleted messages (text, image, video, audio, sticker,
 * document). Deleted view-once media is re-sent AS view-once again (bare, no
 * caption) and the recovery card — Type: viewonce — is quoted onto it.
 *
 * Configuration is bot-wide SQLite state. Captured messages use one record path:
 *   in-memory cache for immediate recovery
 *   → SQLite antidelete_messages for recovery after a restart
 *
 * There is no file-backed backup, standalone anti-delete JSON, or second
 * persistent message store. View-once media bytes live in RAM only (bounded
 * prime cache) UNLESS JUNE_AD_VO_PERSIST=1, which additionally stores small
 * primed buffers (default <=2MB, max 200) in the same SQLite KV so a deleted
 * view-once still resurrects after a restart.
 */

const database = require('../../database');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const messageStore = new Map();
const pendingPersistence = new Map();

// ── Recently recovered deletes — the record `.snipe` reads ───────────────────
//
// handleDelete() re-sends a recovered message and then frees the stored entry
// (removeStoredEntry), so the data would be gone the instant it was recovered.
// This keeps a small, bounded tail of what was deleted where, newest last, so
// `.snipe` can report a delete without re-sending the original media.
//
// Text is copied; the media buffer is deliberately NOT retained here beyond the
// entry object (releasePrimed still governs the primed bytes), so snipe adds no
// meaningful RAM on top of what antidelete already holds.
const recentDeletes = new Map();
const RECENT_DELETES_MAX = Number(process.env.JUNE_SNIPE_MAX) || 20;

function rememberDelete(chatId, messageId, entry, originChatId) {
  let list = recentDeletes.get(chatId);
  if (!list) { list = []; recentDeletes.set(chatId, list); }
  list.push({
    id: messageId,
    at: Date.now(),
    originChatId: originChatId || chatId,
    sender: entry.sender || null,
    senderAlt: entry.senderAlt || null,
    type: entry.type || 'text',
    isVO: !!entry.isVO,
    text: entry.text || null,
    entry,
  });
  while (list.length > RECENT_DELETES_MAX) list.shift();
}

/** Newest-first slice of what was deleted in `chatId`. */
function getRecentDeletes(chatId, limit = 1) {
  const list = recentDeletes.get(chatId) || [];
  const n = Math.max(1, Math.floor(Number(limit) || 1));
  return list.slice(-n).reverse();
}

function clearRecentDeletes() { recentDeletes.clear(); }

const PERSIST_DEBOUNCE_MS = 2_000;
const PERSIST_RETRY_INTERVAL_MS = 5_000;
const MAX_PRIMED_VO_BYTES = Number(process.env.JUNE_AD_VO_MAX_BYTES) || 32 * 1024 * 1024;
const MAX_PRIMED_VO_TOTAL = Number(process.env.JUNE_AD_VO_CACHE_BYTES) || 128 * 1024 * 1024;
let primedViewOnceBytes = 0;

let persistenceTimer = null;
let lastPersistenceErrorAt = 0;
const debugLog = (...args) => {
  if (process.env.DEBUG || process.env.JUNE_ANTIDELETE_DEBUG) console.log(...args);
};

// ── Restart persistence for primed view-once media (opt-in) ──────────────────
// Primed VO buffers are RAM-only, so a restart loses them and the VO CDN link
// is usually dead by then. With JUNE_AD_VO_PERSIST=1 a successful prime also
// writes the bytes into the bot's SQLite KV (namespace 'antidelete', keys
// 'vo:...') and the resend path loads them back after a restart. Small media
// only (default 2MB) with an entry cap — this is a recovery cache, not storage.
const voPersistEnabled = () => process.env.JUNE_AD_VO_PERSIST === '1';
const VO_PERSIST_MAX_BYTES = Number(process.env.JUNE_AD_VO_PERSIST_MAX_BYTES) || 2 * 1024 * 1024;
const VO_PERSIST_MAX_ENTRIES = Number(process.env.JUNE_AD_VO_PERSIST_MAX_ENTRIES) || 200;
const voKey = (chatId, messageId) => `vo:${String(chatId)}|${String(messageId)}`;

function persistPrimedVo(chatId, messageId, buffer) {
  if (!voPersistEnabled() || !buffer || buffer.length > VO_PERSIST_MAX_BYTES) return;
  try {
    database.setKV('antidelete', voKey(chatId, messageId), { b64: buffer.toString('base64'), storedAt: Date.now() });
    const all = database.getAllKV('antidelete');
    const vos = Object.entries(all).filter(([k]) => k.startsWith('vo:'));
    if (vos.length > VO_PERSIST_MAX_ENTRIES) {
      vos.sort((a, b) => (a[1]?.storedAt || 0) - (b[1]?.storedAt || 0));
      for (const [k] of vos.slice(0, vos.length - VO_PERSIST_MAX_ENTRIES)) {
        try { database.delKV('antidelete', k); } catch (_) {}
      }
    }
    debugLog(`[ANTIDELETE] view-once persisted type=cache bytes=${buffer.length}`);
  } catch (error) {
    reportPersistenceError(error);
  }
}

function loadPrimedVo(chatId, messageId) {
  if (!voPersistEnabled() || !chatId || !messageId) return null;
  try {
    const rec = database.getKV('antidelete', voKey(chatId, messageId));
    if (!rec?.b64) return null;
    const buffer = Buffer.from(rec.b64, 'base64');
    return buffer.length ? buffer : null;
  } catch (_) { return null; }
}

function deletePrimedVo(chatId, messageId) {
  if (!chatId || !messageId) return;
  try { database.delKV('antidelete', voKey(chatId, messageId)); } catch (_) {}
}

function wipePrimedVo() {
  try {
    const all = database.getAllKV('antidelete');
    for (const k of Object.keys(all)) if (k.startsWith('vo:')) { try { database.delKV('antidelete', k); } catch (_) {} }
  } catch (_) {}
}

const getMode = () => database.getAntideleteMode();
const getTimezone = () => database.getTimeZone();

const MEDIA_MAP = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
  // rc13+ documents can arrive in this container (incl. inside view-once);
  // it carries the same url/mediaKey fields so download works unchanged.
  documentWithCaptionMessage: 'document',
};

const VO_WRAPPERS = [
  'viewOnceMessageV2Extension',
  'viewOnceMessageV2',
  'viewOnceMessage',
];

function unwrap(raw) {
  let inner = raw;
  // WhatsApp can stack ephemeral + view-once containers. Walk all layers
  // instead of selecting only the first one (the old code skipped media when
  // ephemeralMessage wrapped viewOnceMessageV2).
  for (let depth = 0; inner && depth < 8; depth += 1) {
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessageV2Extension?.message ||
      inner.viewOnceMessageV2?.message ||
      inner.viewOnceMessage?.message;
    if (!next || next === inner) break;
    inner = next;
  }
  // rc13+ documents-in-disguise: the container carries the document fields itself
  if (inner?.documentWithCaptionMessage && !inner.documentMessage) {
    const doc = inner.documentWithCaptionMessage.message || inner.documentWithCaptionMessage;
    if (doc && (doc.url || doc.mediaKey)) inner = { ...inner, documentMessage: doc };
  }
  return inner;
}

function isViewOnce(raw) {
  let current = raw;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (
      current.imageMessage?.viewOnce === true ||
      current.videoMessage?.viewOnce === true ||
      current.audioMessage?.viewOnce === true
    ) return true;

    const next =
      current.ephemeralMessage?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessage?.message;
    if (!next || next === current) break;

    // A wrapper is authoritative even when the inner media object no longer
    // carries a direct viewOnce flag after Baileys normalises the message.
    if (
      current.viewOnceMessageV2Extension ||
      current.viewOnceMessageV2 ||
      current.viewOnceMessage
    ) return true;
    current = next;
  }
  return false;
}

function recordKey(chatId, messageId) {
  return `${String(chatId)}\u0000${String(messageId)}`;
}

function normaliseTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

// Baileys media metadata includes Buffers such as mediaKey/file hashes. Encode
// those explicitly so a SQLite JSON payload can be restored into valid Buffers
// after a restart without writing a companion media/JSON file.
function encodeForDatabase(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return { __juneBigInt: value.toString() };
  if (Buffer.isBuffer(value)) return { __juneBuffer: value.toString('base64') };
  if (value instanceof Uint8Array) return { __juneBuffer: Buffer.from(value).toString('base64') };

  if (Array.isArray(value)) return value.map(item => encodeForDatabase(item, seen));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const encoded = encodeForDatabase(item, seen);
    if (encoded !== undefined) output[key] = encoded;
  }
  seen.delete(value);
  return output;
}

function decodeFromDatabase(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decodeFromDatabase);
  if (typeof value !== 'object') return value;
  if (typeof value.__juneBuffer === 'string') {
    try { return Buffer.from(value.__juneBuffer, 'base64'); } catch (_) { return null; }
  }
  if (typeof value.__juneBigInt === 'string') return value.__juneBigInt;

  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = decodeFromDatabase(item);
  return output;
}

function toPersistentEntry(entry) {
  return {
    sender: String(entry.sender || ''),
    senderAlt: entry.senderAlt ? String(entry.senderAlt) : null,
    timestamp: normaliseTimestamp(entry.timestamp),
    type: String(entry.type || 'text'),
    isVO: entry.isVO === true,
    mtype: entry.mtype ? String(entry.mtype) : null,
    text: entry.text === null || entry.text === undefined ? null : String(entry.text),
    inner: entry.mtype ? encodeForDatabase(entry.inner) : null,
  };
}

function fromPersistentEntry(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type || 'text');
  const mtype = payload.mtype ? String(payload.mtype) : null;
  const inner = payload.inner ? decodeFromDatabase(payload.inner) : null;
  if (type !== 'text' && (!mtype || !inner)) return null;

  return {
    sender: String(payload.sender || ''),
    senderAlt: payload.senderAlt ? String(payload.senderAlt) : null,
    timestamp: normaliseTimestamp(payload.timestamp),
    type,
    isVO: payload.isVO === true,
    mtype,
    inner,
    text: payload.text === null || payload.text === undefined ? null : String(payload.text),
  };
}

function reportPersistenceError(error) {
  const now = Date.now();
  if (now - lastPersistenceErrorAt < 60_000) return;
  lastPersistenceErrorAt = now;
  console.error('[ANTIDELETE] SQLite persistence error:', error?.message || error);
}

function schedulePersistence() {
  if (persistenceTimer) return;
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    flushPersistentMessages();
  }, PERSIST_DEBOUNCE_MS);
  persistenceTimer.unref?.();
}

function queuePersistentMessage(chatId, messageId, entry) {
  pendingPersistence.set(recordKey(chatId, messageId), {
    chatId: String(chatId),
    messageId: String(messageId),
    payload: toPersistentEntry(entry),
    storedAt: Date.now(),
  });
  schedulePersistence();
}

function flushPersistentMessages() {
  if (persistenceTimer) {
    clearTimeout(persistenceTimer);
    persistenceTimer = null;
  }

  let saved = 0;
  for (const [key, record] of [...pendingPersistence.entries()]) {
    try {
      database.saveAntideleteMessage(record.chatId, record.messageId, record.payload, record.storedAt);
      pendingPersistence.delete(key);
      saved += 1;
    } catch (error) {
      // Keep the pending record for the retry interval or graceful shutdown.
      reportPersistenceError(error);
    }
  }
  return saved;
}

function getCachedEntry(chatId, messageId) {
  return messageStore.get(chatId)?.get(messageId) || null;
}

function getStoredEntry(chatId, messageId) {
  const cached = getCachedEntry(chatId, messageId);
  if (cached) return cached;

  try {
    const row = database.getAntideleteMessage(chatId, messageId);
    return row ? fromPersistentEntry(row.payload) : null;
  } catch (error) {
    reportPersistenceError(error);
    return null;
  }
}

/**
 * Safety net for key-shape drift: Baileys can deliver the revoke under a
 * different chat JID form (e.g. @g.us vs an @lid variant) than the original
 * message carried. Exact lookup first, then the same chat by id alone, then
 * the whole RAM store by id alone. Deletes are rare, so the scan is free.
 * Returns { entry, chatId } so the record is cleaned from the right chat.
 */
function findEntryLoose(chatId, messageId) {
  const exact = getStoredEntry(chatId, messageId);
  if (exact) return { entry: exact, chatId };

  const sameChat = messageStore.get(chatId)?.get(messageId);
  if (sameChat) return { entry: sameChat, chatId };

  for (const [cid, map] of messageStore) {
    if (map.has(messageId)) return { entry: map.get(messageId), chatId: cid };
  }

  // KV can hold the record under a different chat-jid form (DMs that used to
  // arrive with a phone-number jid now arrive as @lid after the rc14 switch).
  // The exact KV read misses that, so scan the capped namespace by message id.
  try {
    const all = database.getAllKV('antidelete');
    const hitKey = Object.keys(all).find((k) => k.startsWith('msg:') && k.endsWith(`|${messageId}`));
    if (hitKey) {
      const row = fromPersistentEntry(all[hitKey]?.payload);
      if (row) {
        const kvChat = hitKey.slice(4, hitKey.length - messageId.length - 1);
        return { entry: row, chatId: kvChat };
      }
    }
  } catch (_) {}
  return null;
}

// One decrement per buffer release — every eviction path (per-chat overflow,
// global FIFO trim, id overwrite, recover-then-drop, mode off) must go through
// this or primedViewOnceBytes phantom-inflates until priming stops entirely.
function releasePrimed(entry) {
  if (entry?.mediaBuffer) {
    primedViewOnceBytes -= entry.mediaBuffer.length;
    if (primedViewOnceBytes < 0) primedViewOnceBytes = 0;
    entry.mediaBuffer = null;
  }
}

function removeStoredEntry(chatId, messageId) {
  const chatMap = messageStore.get(chatId);
  if (chatMap) {
    releasePrimed(chatMap.get(messageId));
    chatMap.delete(messageId);
    if (chatMap.size === 0) messageStore.delete(chatId);
  }
  pendingPersistence.delete(recordKey(chatId, messageId));
  deletePrimedVo(chatId, messageId);

  try {
    database.deleteAntideleteMessage(chatId, messageId);
  } catch (error) {
    reportPersistenceError(error);
  }
}

// Global in-memory ceiling across ALL chats. Per-chat is capped at 500, but a
// bot sitting in 30 busy groups would otherwise hold ~15k entries (~40MB+);
// this bounds total RAM to a panel-friendly ~10MB worst case.
let ramMax = Number(process.env.JUNE_AD_RAM_MAX) || 4000;
const setRamLimit = (n) => { ramMax = n; };

const storeMessage = (msg) => {
  try {
    if (!msg?.key?.id || !msg.message) return;
    // No capture while the feature is off — zero RAM/disk cost for chats that
    // never use antidelete. (.antidelete on starts capturing from that moment.)
    if (getMode() === 'off') return;

    const chatId = msg.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast') return;

    const sender = msg.key.participant || msg.key.remoteJid;
    // rc14 LID groups: participant is a @lid JID; participantAlt carries the
    // real phone JID — store both so cards can @mention a renderable number.
    const senderAlt = msg.key.participantAlt || null;
    const inner = unwrap(msg.message);
    const text =
      inner.conversation ||
      inner.extendedTextMessage?.text ||
      inner.imageMessage?.caption ||
      inner.videoMessage?.caption ||
      inner.documentMessage?.caption ||
      null;
    const mtype = Object.keys(MEDIA_MAP).find(key => inner[key]);
    if (!text && !mtype) {
      // DEBUG hunts: prove whether a message was SEEN at all, and why skipped.
      if (process.env.DEBUG || process.env.JUNE_ANTIDELETE_DEBUG) {
        const outer = Object.keys(msg.message || {}).join('+') || 'empty';
        console.log(`[ANTIDELETE] seen ${chatId} id=${msg.key.id} SKIP no-text/media outer=[${outer}]`);
      }
      return;
    }

    // View-once marker: the outer wrapper (V2Extension/V2/V1) or the media's
    // own viewOnce flag. Persisted so a deleted VO is re-sent AS view-once
    // even after a restart.
    const isVO = isViewOnce(msg.message);

    const entry = {
      sender,
      senderAlt,
      timestamp: msg.messageTimestamp,
      type: mtype ? MEDIA_MAP[mtype] : 'text',
      isVO,
      mtype: mtype || null,
      inner,
      text: text || null,
    };

    if (!messageStore.has(chatId)) messageStore.set(chatId, new Map());
    const chatMap = messageStore.get(chatId);
    releasePrimed(chatMap.get(msg.key.id)); // id re-delivery must not orphan a buffer
    chatMap.set(msg.key.id, entry);
    debugLog(`[ANTIDELETE] seen ${chatId} id=${msg.key.id} STORED (${entry.type}${entry.isVO ? ' vo' : ''}) chat=${chatMap.size}`);
    if (chatMap.size > 500) {
      const oldestId = chatMap.keys().next().value;
      releasePrimed(chatMap.get(oldestId));
      chatMap.delete(oldestId);
    }

    // Global FIFO trim: oldest chat first, oldest message within it.
    let total = 0;
    for (const m of messageStore.values()) total += m.size;
    while (total > ramMax) {
      const oldestChat = messageStore.keys().next().value;
      const m = messageStore.get(oldestChat);
      const oldestId = m.keys().next().value;
      releasePrimed(m.get(oldestId));
      m.delete(oldestId);
      if (!m.size) messageStore.delete(oldestChat);
      total--;
    }

    // SQLite is the persistent record path; the memory Map remains only the
    // immediate hot cache for messages arriving during this process lifetime.
    queuePersistentMessage(chatId, msg.key.id, entry);

    // View-once media may be unavailable after WhatsApp consumes the message.
    // Prime a bounded in-memory copy while the CDN material is still usable.
    if (entry.isVO) {
      entry._chatId = chatId;
      entry._messageId = msg.key.id;
      primeViewOnceMedia(entry);
    }
  } catch (_) {}
};

async function downloadMediaFromMessage(stored, maxBytes = Infinity) {
  try {
    const { inner, mtype } = stored;
    if (!inner || !mtype || !inner[mtype]) {
      debugLog(`[ANTIDELETE] media unavailable type=${stored?.type || 'unknown'} mtype=${mtype || 'none'}`);
      return null;
    }
    const stream = await downloadContentFromMessage(inner[mtype], MEDIA_MAP[mtype]);
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    debugLog(`[ANTIDELETE] media download failed type=${stored?.type || 'unknown'} mtype=${stored?.mtype || 'none'}: ${error?.message || error}`);
    return null;
  }
}

function primeViewOnceMedia(stored) {
  if (!stored?.isVO || stored.mediaPromise || stored.mediaBuffer) return;
  stored.mediaPromise = downloadMediaFromMessage(stored, MAX_PRIMED_VO_BYTES)
    .then((buffer) => {
      if (!buffer) {
        debugLog(`[ANTIDELETE] view-once prime failed type=${stored.type}`);
        return null;
      }
      if (primedViewOnceBytes + buffer.length > MAX_PRIMED_VO_TOTAL) {
        debugLog(`[ANTIDELETE] view-once prime skipped: cache limit reached (${buffer.length} bytes)`);
        return null;
      }
      stored.mediaBuffer = buffer;
      primedViewOnceBytes += buffer.length;
      debugLog(`[ANTIDELETE] view-once primed type=${stored.type} bytes=${buffer.length}`);
      persistPrimedVo(stored._chatId, stored._messageId, buffer);
      return buffer;
    })
    .catch(() => null);
}

async function downloadMedia(stored, origin = {}) {
  if (stored?.mediaBuffer) return stored.mediaBuffer;
  if (stored?.mediaPromise) {
    const primed = await stored.mediaPromise;
    if (primed) return primed;
  }
  // Post-restart path: RAM is empty, but JUNE_AD_VO_PERSIST may have the bytes.
  const fromDisk = loadPrimedVo(origin.chatId, origin.messageId);
  if (fromDisk) {
    stored.mediaBuffer = fromDisk;
    primedViewOnceBytes += fromDisk.length;
    debugLog(`[ANTIDELETE] view-once restored from persistence bytes=${fromDisk.length}`);
    return fromDisk;
  }
  return downloadMediaFromMessage(stored);
}

async function getChatLabel(sock, chatId) {
  try {
    if (chatId.endsWith('@g.us')) {
      const meta = await sock.groupMetadata(chatId);
      return `👥 *${meta.subject}*`;
    }
    return `💬 DM (${chatId.split('@')[0]})`;
  } catch {
    return chatId.endsWith('@g.us')
      ? `👥 Group (${chatId.split('@')[0]})`
      : `💬 DM (${chatId.split('@')[0]})`;
  }
}

async function sendRecovered(sock, targetJid, stored, originChat, origin = {}) {
  const mentionJid = stored.senderAlt || stored.sender || null;
  const senderNum = mentionJid?.split('@')[0]?.split(':')[0] || 'Unknown';
  // A deleted view-once is always labelled 'viewonce' — that is the whole point.
  const displayType = stored.isVO ? 'viewonce' : stored.type;
  const typeEmoji = stored.isVO
    ? '📄'
    : ({
      image: '🖼️', video: '🎬', audio: '🎵',
      sticker: '🧩', document: '📄', text: '📝',
    }[stored.type] || '📝');

  const readmore = String.fromCharCode(8206).repeat(4001);
  const divider = '━━━━━━━━━━━━━━━━━━━━';
  const timestamp = stored.timestamp
    ? new Date(Number(stored.timestamp) * 1000).toLocaleString('en-GB', {
      hour12: false,
      timeZone: getTimezone(),
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
    : new Date().toLocaleString();

  const chatLabel = originChat && originChat !== targetJid
    ? `\n📍 *Chat:* ${await getChatLabel(sock, originChat)}`
    : '';
  const mentions = mentionJid ? [mentionJid] : [];
  const meta =
    `🗑️ *DELETED MESSAGE* 🗑️\n` +
    `${divider}\n` +
    `👤 *From:* @${senderNum}\n` +
    `🕐 *Time:* ${timestamp}\n` +
    `${typeEmoji} *Type:* ${displayType}` +
    chatLabel + '\n' +
    `${divider}\n${readmore}\n`;

  // ── Deleted view-once media: resurrect as VIEW-ONCE ──────────────────────
  // The media goes out bare (no caption) wrapped in view-once again, then the
  // recovery card arrives as a separate message QUOTING the resurrected VO.
  if (stored.isVO && ['image', 'video', 'audio'].includes(stored.type)) {
    const buffer = await downloadMedia(stored, origin);
    if (!buffer) {
      await sock.sendMessage(targetJid, {
        text: `${meta}⚠️ _Media expired (CDN link gone)._\n${divider}`,
        mentions,
      });
      return;
    }

    const voContent =
      stored.type === 'image'
        ? { image: buffer }
        : stored.type === 'video'
          ? { video: buffer, mimetype: stored.inner?.videoMessage?.mimetype || 'video/mp4' }
          : {
            audio: buffer,
            ptt: stored.inner?.audioMessage?.ptt === true,
            mimetype: stored.inner?.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
          };
    voContent.viewOnce = true;   // Baileys re-wraps the media in view-once

    const sent = await sock.sendMessage(targetJid, voContent);

    const card =
      `🗑️ *Deleted Message Recovered*\n${divider}\n` +
      `👤 *From:* @${senderNum}\n` +
      `🕐 *Time:* ${timestamp}\n` +
      `📄 *Type:* viewonce` +
      chatLabel +
      `\n${divider}`;
    await sock.sendMessage(targetJid, { text: card, mentions }, { quoted: sent?.key });
    return;
  }

  if (stored.type === 'text') {
    await sock.sendMessage(targetJid, {
      text: `${meta}📝 *Message:*\n${stored.text}\n${divider}`,
      mentions,
    });
    return;
  }

  const buffer = await downloadMedia(stored);
  if (!buffer) {
    await sock.sendMessage(targetJid, {
      text: `${meta}⚠️ _Media expired (CDN link gone)._\n${divider}`,
      mentions,
    });
    return;
  }

  const caption =
    `🗑️ *Deleted Message Recovered*\n${divider}\n` +
    `👤 *From:* @${senderNum}\n` +
    `🕐 *Time:* ${timestamp}\n` +
    `${typeEmoji} *Type:* ${displayType}` +
    chatLabel +
    (stored.text ? `\n${divider}\n${readmore}\n📝 *Caption:*\n${stored.text}` : '') +
    `\n${divider}`;
  const textHeader = `${meta}${stored.text ? `📝 *Caption:*\n${stored.text}\n` : ''}${divider}`;

  if (stored.type === 'image') {
    await sock.sendMessage(targetJid, { image: buffer, caption, mentions });
  } else if (stored.type === 'video') {
    await sock.sendMessage(targetJid, {
      video: buffer,
      caption,
      mentions,
      mimetype: stored.inner?.videoMessage?.mimetype || 'video/mp4',
    });
  } else if (stored.type === 'audio') {
    const isVoice = stored.inner?.audioMessage?.ptt === true;
    await sock.sendMessage(targetJid, {
      audio: buffer,
      ptt: isVoice,
      mimetype: stored.inner?.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
    });
    await sock.sendMessage(targetJid, { text: textHeader, mentions });
  } else if (stored.type === 'sticker') {
    await sock.sendMessage(targetJid, {
      sticker: buffer,
      mimetype: stored.inner?.stickerMessage?.mimetype || 'image/webp',
    });
    await sock.sendMessage(targetJid, { text: textHeader, mentions });
  } else if (stored.type === 'document') {
    await sock.sendMessage(targetJid, {
      document: buffer,
      mimetype: stored.inner?.documentMessage?.mimetype || 'application/octet-stream',
      fileName: stored.inner?.documentMessage?.fileName || 'file',
      caption,
      mentions,
    });
  }
}

function ownerJid(sock) {
  const id = sock.user?.id;
  if (!id) return null;
  return id.includes(':') ? id.split(':')[0] + '@s.whatsapp.net' : id;
}

const handleDelete = async (sock, revokeItems) => {
  try {
    const globalMode = getMode();
    const botJid = ownerJid(sock);
    if (!globalMode || globalMode === 'off') return;

    for (const item of revokeItems) {
      const chatId = item.key?.remoteJid;
      const deletedId = item.key?.id;
      if (!chatId || !deletedId || chatId === 'status@broadcast') continue;

      const targetJid = globalMode === 'private' && botJid
        ? botJid
        : globalMode === 'chat'
          ? chatId
          : null;
      if (!targetJid) continue;

      const hit = findEntryLoose(chatId, deletedId);
      if (process.env.DEBUG) {
        if (hit) {
          console.log(`[ANTIDELETE] lookup ${chatId} id=${deletedId}: HIT${hit.chatId !== chatId ? ` (via ${hit.chatId})` : ''}`);
        } else {
          const ramMap = messageStore.get(chatId);
          const ramIds = ramMap ? [...ramMap.keys()].slice(-5) : [];
          let kvCount = 0;
          try { kvCount = Object.keys(database.getAllKV('antidelete')).filter((k) => k.startsWith('msg:')).length; } catch (_) {}
          console.log(`[ANTIDELETE] lookup ${chatId} id=${deletedId}: MISS — not in RAM (${ramMap ? ramMap.size : 0} this chat) and not in KV (${kvCount} keys, id-scanned). Verdict: never captured — sent before .antidelete was on, before the last restart, or during the restart gap (no backfill). Check the console for a [ANTIDELETE] seen ... STORED line with this id; no such line = the bot never received it.`);
        }
      }
      if (!hit) continue;

      // Record before the entry is freed below — this is what `.snipe` reads.
      rememberDelete(chatId, deletedId, hit.entry, hit.chatId);

      await sendRecovered(sock, targetJid, hit.entry, chatId, { chatId: hit.chatId, messageId: deletedId });
      // A recovered record no longer needs to occupy the capped SQLite store.
      removeStoredEntry(hit.chatId, deletedId);
    }
  } catch (error) {
    console.error('[ANTIDELETE] handleDelete error:', error.message);
  }
};

function getStoreStats() {
  let messages = 0;
  for (const chatMap of messageStore.values()) messages += chatMap.size;
  return {
    mode: getMode(),
    chats: messageStore.size,
    messages,
    pendingPersistence: pendingPersistence.size,
    persistentStore: 'SQLite antidelete_messages',
  };
}

// A short debounce avoids synchronous SQLite writes in the incoming-message
// hot path. The interval retries a temporary database failure without creating
// a second persistent store.
setInterval(flushPersistentMessages, PERSIST_RETRY_INTERVAL_MS).unref();
global.__JUNE_FLUSH_ANTIDELETE = flushPersistentMessages;
process.prependListener('exit', flushPersistentMessages);

module.exports = {
  name: 'antidelete',
  aliases: ['antidel'],
  category: 'owner',
  description: 'Recover deleted messages',
  usage: '.antidelete on/private/off/status',
  adminOnly: true,

  storeMessage,
  handleDelete,
  getRecentDeletes,
  clearRecentDeletes,
  _internals: {
    messageStore, pendingPersistence, setRamLimit,
    getPrimedBytes: () => primedViewOnceBytes,
    // Test seam for "restart": empties RAM exactly like a process restart
    // would, while the SQLite KV (including persisted VO media) survives.
    resetRuntime() {
      for (const map of messageStore.values()) for (const e of map.values()) releasePrimed(e);
      messageStore.clear();
      pendingPersistence.clear();
      clearRecentDeletes();
      primedViewOnceBytes = 0;
    },
  },
  getStoreStats,
  flush: flushPersistentMessages,
  flushPersistentMessages,

  async execute(sock, msg, args, extra) {
    const { reply } = extra;
    const sub = (args[0] || '').toLowerCase();
    const globalMode = getMode();
    const statusLabel =
      globalMode === 'chat' ? '✅ ON — Chat' :
      globalMode === 'private' ? '✅ ON — Private' : '❌ OFF';

    if (!sub || sub === 'status') {
      const mb = (primedViewOnceBytes / (1024 * 1024)).toFixed(1);
      const persist = voPersistEnabled() ? 'on' : 'off';
      return reply(`🗑️ Anti-Delete: *${statusLabel}*\n🧠 Primed VO cache: ${mb} MB\n💾 VO restart cache: ${persist}\n\n.antidelete on | private | off`);
    }
    if (sub === 'on' || sub === 'chat') {
      database.setAntideleteMode('chat');
      return reply('🗑️ Anti-Delete set to *ON* — deleted msgs shown in each chat.');
    }
    if (sub === 'private') {
      database.setAntideleteMode('private');
      return reply('🗑️ Anti-Delete set to *Private* — all deleted msgs go to owner DM.');
    }
    if (sub === 'off') {
      database.setAntideleteMode('off');
      // Free the memory immediately — no recovery is expected while off.
      for (const map of messageStore.values()) for (const e of map.values()) releasePrimed(e);
      messageStore.clear();
      pendingPersistence.clear();
      primedViewOnceBytes = 0;
      wipePrimedVo();
      return reply('🗑️ Anti-Delete set to *OFF*. Message cache released.');
    }
    return reply('⚠️ Usage: .antidelete on | private | off | status');
  },
};
