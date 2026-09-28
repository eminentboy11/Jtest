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
 * persistent message store.
 */

const database = require('../../database');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const messageStore = new Map();
const pendingPersistence = new Map();
const PERSIST_DEBOUNCE_MS = 2_000;
const PERSIST_RETRY_INTERVAL_MS = 5_000;

let persistenceTimer = null;
let lastPersistenceErrorAt = 0;

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

function unwrap(raw) {
  let inner = (
    raw.ephemeralMessage?.message ||
    raw.viewOnceMessageV2Extension?.message ||
    raw.viewOnceMessageV2?.message ||
    raw.viewOnceMessage?.message ||
    raw
  );
  // rc13+ documents-in-disguise: the container carries the document fields itself
  if (inner?.documentWithCaptionMessage && !inner.documentMessage) {
    const doc = inner.documentWithCaptionMessage.message || inner.documentWithCaptionMessage;
    if (doc && (doc.url || doc.mediaKey)) inner = { ...inner, documentMessage: doc };
  }
  return inner;
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

function removeStoredEntry(chatId, messageId) {
  const chatMap = messageStore.get(chatId);
  if (chatMap) {
    chatMap.delete(messageId);
    if (chatMap.size === 0) messageStore.delete(chatId);
  }
  pendingPersistence.delete(recordKey(chatId, messageId));

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
    if (!text && !mtype) return;

    // View-once marker: the outer wrapper (V2Extension/V2/V1) or the media's
    // own viewOnce flag. Persisted so a deleted VO is re-sent AS view-once
    // even after a restart.
    const isVO = !!(
      msg.message.viewOnceMessageV2Extension ||
      msg.message.viewOnceMessageV2 ||
      msg.message.viewOnceMessage ||
      inner.imageMessage?.viewOnce ||
      inner.videoMessage?.viewOnce ||
      inner.audioMessage?.viewOnce
    );

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
    chatMap.set(msg.key.id, entry);
    if (process.env.DEBUG) console.log(`[ANTIDELETE] stored ${chatId} id=${msg.key.id} (${entry.type}${entry.isVO ? ' vo' : ''}) chat=${chatMap.size}`);
    if (chatMap.size > 500) chatMap.delete(chatMap.keys().next().value);

    // Global FIFO trim: oldest chat first, oldest message within it.
    let total = 0;
    for (const m of messageStore.values()) total += m.size;
    while (total > ramMax) {
      const oldestChat = messageStore.keys().next().value;
      const m = messageStore.get(oldestChat);
      m.delete(m.keys().next().value);
      if (!m.size) messageStore.delete(oldestChat);
      total--;
    }

    // SQLite is the persistent record path; the memory Map remains only the
    // immediate hot cache for messages arriving during this process lifetime.
    queuePersistentMessage(chatId, msg.key.id, entry);
  } catch (_) {}
};

async function downloadMedia(stored) {
  try {
    const { inner, mtype } = stored;
    if (!inner || !mtype || !inner[mtype]) return null;
    const stream = await downloadContentFromMessage(inner[mtype], MEDIA_MAP[mtype]);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
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

async function sendRecovered(sock, targetJid, stored, originChat) {
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
    const buffer = await downloadMedia(stored);
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
          console.log(`[ANTIDELETE] lookup ${chatId} id=${deletedId}: MISS — not in RAM (${ramMap ? ramMap.size : 0} this chat) and not in KV (${kvCount} keys, id-scanned). Verdict: message was never captured — sent before .antidelete was on / before the last restart.`);
        }
      }
      if (!hit) continue;

      await sendRecovered(sock, targetJid, hit.entry, chatId);
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
  _internals: { messageStore, pendingPersistence, setRamLimit },
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
      return reply(`🗑️ Anti-Delete: *${statusLabel}*\n\n.antidelete on | private | off`);
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
      messageStore.clear();
      pendingPersistence.clear();
      return reply('🗑️ Anti-Delete set to *OFF*. Message cache released.');
    }
    return reply('⚠️ Usage: .antidelete on | private | off | status');
  },
};
