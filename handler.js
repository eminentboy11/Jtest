/**
 * Message Handler - Processes incoming messages and executes commands
 */

const database = require('./database');
const { loadCommands, watchCommands, swapInto } = require('./utils/commandLoader');
const commandToggle = require('./utils/commandToggle');
const { addMessage, getActiveUsers, getInactiveUsers } = require('./utils/groupstats');
const { jidDecode, jidEncode } = require('@whiskeysockets/baileys');

// Group metadata cache to prevent rate limiting
const groupMetadataCache = new Map();
const CACHE_TTL = 300000; // 5 minute cache (was 1 min)

// Bot-admin status cache — avoids live API call on every message
const botAdminCache = new Map();
const BOT_ADMIN_TTL = 120000; // 2 minutes

// Settings caches — avoids disk reads on every message
let _arSettingsCache   = null;
let _arSettingsExpiry  = 0;
const SETTINGS_CACHE_TTL = 8000; // 8 seconds

function getCachedArSettings() {
  if (_arSettingsCache && Date.now() < _arSettingsExpiry) return _arSettingsCache;
  try {
    _arSettingsCache = require('./utils/autoReact').load();
  } catch { _arSettingsCache = { enabled: false, mode: 'bot' }; }
  _arSettingsExpiry = Date.now() + SETTINGS_CACHE_TTL;
  return _arSettingsCache;
}

// Invalidate settings caches when commands change them (called by set commands)
global.invalidateSettingsCache = () => {
  _arSettingsCache  = null;
  botAdminCache.clear();
};

// ── ViewOnce Reveal Cache ────────────────────────────────────────────────────
// Stores recently-seen view-once messages so emoji reactions can look them up.
// Key: message ID (string)   Value: { msg, expires }
const voCache = new Map();
const VO_CACHE_TTL = 10 * 60 * 1000; // keep entries for 10 minutes

// Resolve the bot's own JID once, consistently, wherever we need to DM ourselves.
const getSelfJid = (sock) => sock.user.id.split(':')[0] + '@s.whatsapp.net';

function cacheViewOnceMsg(msg) {
  try {
    const id = msg.key?.id;
    if (!id) return;
    const raw = msg.message || {};
    const isVO =
      !!raw.viewOnceMessageV2Extension ||
      !!raw.viewOnceMessageV2 ||
      !!raw.viewOnceMessage ||
      !!raw.ephemeralMessage?.message?.viewOnceMessageV2 ||
      !!raw.imageMessage?.viewOnce ||
      !!raw.videoMessage?.viewOnce ||
      !!raw.audioMessage?.viewOnce;
    if (!isVO) return;
    voCache.set(id, { msg, expires: Date.now() + VO_CACHE_TTL });
    // Evict expired entries every so often
    if (voCache.size % 20 === 0) {
      const now = Date.now();
      for (const [k, v] of voCache) { if (v.expires < now) voCache.delete(k); }
    }
  } catch (_) {}
}

/** Reveal a cached view-once message and DM the media to targetJid. */
async function revealVoToDM(sock, originalMsg, targetJid) {
  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
  const { createTempFilePath, deleteTempFile } = require('./utils/tempManager');

  const VO_WRAPPERS = ['viewOnceMessageV2Extension', 'viewOnceMessageV2', 'viewOnceMessage'];
  const MEDIA_DL = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };

  let raw = originalMsg.message || {};
  // Unwrap ephemeral layer
  if (raw.ephemeralMessage?.message) raw = raw.ephemeralMessage.message;

  let innerMsg = null, mtype = null, dlType = null;
  for (const wrapper of VO_WRAPPERS) {
    const inner = raw[wrapper]?.message;
    if (inner) {
      mtype = Object.keys(inner).find(k => MEDIA_DL[k]);
      if (mtype) { innerMsg = inner; dlType = MEDIA_DL[mtype]; break; }
    }
  }
  // Direct viewOnce flag fallback
  if (!innerMsg) {
    for (const [mt, dl] of Object.entries(MEDIA_DL)) {
      if (raw[mt]?.viewOnce) {
        innerMsg = { [mt]: { ...raw[mt], viewOnce: false } };
        mtype = mt; dlType = dl; break;
      }
    }
  }
  if (!innerMsg || !mtype) return false;

  let tmpPath = null;
  try {
    tmpPath = createTempFilePath('vvo', mtype === 'imageMessage' ? 'jpg' : 'mp4');
    const writeStream = require('fs').createWriteStream(tmpPath);
    const dlStream = await downloadContentFromMessage(innerMsg[mtype], dlType);
    await new Promise((res, rej) => {
      dlStream.pipe(writeStream);
      writeStream.on('finish', res);
      writeStream.on('error', rej);
      dlStream.on('error', rej);
    });
    const caption = innerMsg[mtype]?.caption || '';
    if (mtype === 'imageMessage') {
      await sock.sendMessage(targetJid, { image: { url: tmpPath }, caption: caption || '🖼️ *ViewOnce Image*' });
    } else if (mtype === 'videoMessage') {
      await sock.sendMessage(targetJid, { video: { url: tmpPath }, caption: caption || '🎬 *ViewOnce Video*', mimetype: 'video/mp4' });
    } else {
      await sock.sendMessage(targetJid, { audio: { url: tmpPath }, mimetype: innerMsg[mtype]?.mimetype || 'audio/mp4', ptt: false });
    }
    return true;
  } finally {
    if (tmpPath) deleteTempFile(tmpPath);
  }
}

// Load all commands. This is the single command Map for the whole process —
// index.js reads counts back via getCommandCount() instead of loading a second
// copy, which would double the dispatch table and start a second watcher.
const commands = loadCommands();
watchCommands((freshCommands) => {
  // Same Map instance, because the handler references it throughout; swapInto
  // replaces the entries and recomputes the non-enumerable counts.
  swapInto(commands, freshCommands);
  if (typeof global.invalidateSettingsCache === 'function') {
    global.invalidateSettingsCache();
  }
});


// Unwrap WhatsApp containers (ephemeral, view once, etc.)
const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;

  let m = msg.message;

  // Common wrappers in modern WhatsApp
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  // rc13: viewOnceMessageV2Extension is the newest viewonce wrapper — unwrap before V2/V1
  if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

  // You can add more wrappers if needed later
  return m;
};

// Cached group metadata getter with rate limit handling (for non-admin checks)
const getCachedGroupMetadata = async (sock, groupId) => {
  try {
    // Validate group JID before attempting to fetch
    if (!groupId || !groupId.endsWith('@g.us')) {
      return null;
    }

    // Check cache first
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data; // Return cached data (even if null for forbidden groups)
    }

    // Fetch from API
    const metadata = await sock.groupMetadata(groupId);

    // Cache it
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });

    return metadata;
  } catch (error) {
    // Handle forbidden (403) errors - cache null to prevent retry storms
    if (error.message && (
      error.message.includes('forbidden') ||
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Cache null for forbidden groups to prevent repeated attempts
      groupMetadataCache.set(groupId, {
        data: null,
        timestamp: Date.now()
      });
      return null; // Silently return null for forbidden groups
    }

    // Handle rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      const cached = groupMetadataCache.get(groupId);
      if (cached) {
        return cached.data;
      }
      return null;
    }

    // For other errors, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }

    // Return null instead of throwing to prevent crashes
    return null;
  }
};

// Live group metadata getter (always fresh, no cache) - for admin checks
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    // Always fetch fresh metadata, bypass cache
    const metadata = await sock.groupMetadata(groupId);

    // Update cache for other features (antilink, welcome, etc.)
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });

    return metadata;
  } catch (error) {
    // On error, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    return null;
  }
};

// Alias for backward compatibility (non-admin features use cached)
const getGroupMetadata = getCachedGroupMetadata;

// Helper functions
const isOwner = (sender) => {
  if (!sender) return false;

  // SQLite is the only source of truth for ownership.
  //
  // There is deliberately no fallback to database.getOwners(). Users cannot
  // edit config.js — the public loader re-extracts it from the published
  // build on every boot — so that field always holds the numbers shipped by
  // the June team. Falling back to it would hand those numbers owner rights
  // on every deployment, which is precisely what moving owners into the
  // database is meant to stop.
  //
  // A fresh install therefore has no owner at all. That is safe: the account
  // the bot is paired to is recognised through msg.key.fromMe at the command
  // gate, so it can always claim ownership with .setownernumber.
  const owners = database.getOwners();
  if (!owners.length) return false;

  // Extract the raw phone/user number from sender (strips :device and @server)
  const rawNum = sender.split('@')[0].split(':')[0];

  // Fast path: direct number match (catches normal and device-scoped JIDs)
  if (owners.some(o => String(o).replace(/\D/g, '') === rawNum)) return true;

  // LID-aware path: resolve LID JIDs to phone numbers via session mapping files
  try {
    const normalizedSender = normalizeJidWithLid(sender);
    const senderNumber = normalizeJid(normalizedSender);
    if (senderNumber && owners.some(owner => {
      const normalizedOwner = normalizeJidWithLid(String(owner).includes('@') ? String(owner) : `${owner}@s.whatsapp.net`);
      const ownerNumber = normalizeJid(normalizedOwner);
      return ownerNumber === senderNumber;
    })) return true;
  } catch (_) {}

  return false;
};

const isSudo = (sender) => {
  if (!sender) return false;
  // Normalize: strip @domain and :deviceId so "1234:7@s.whatsapp.net" → "1234"
  const number = sender.split('@')[0].split(':')[0];
  return database.isModerator(number);
};

// Alias for backward compat
const isMod = isSudo;

// LID mapping cache
const lidMappingCache = new Map();

// Periodically evict old groupMetadataCache entries (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of groupMetadataCache) {
    if (now - val.timestamp > 10 * 60 * 1000) groupMetadataCache.delete(key);
  }
  // Clear lid mapping cache completely every 10 minutes to prevent unbounded growth
  lidMappingCache.clear();
}, 10 * 60 * 1000);

// Helper to normalize JID to just the number part
const normalizeJid = (jid) => {
  if (!jid) return null;
  if (typeof jid !== 'string') return null;

  // Remove device ID if present (e.g., "1234567890:0@s.whatsapp.net" -> "1234567890")
  if (jid.includes(':')) {
    return jid.split(':')[0];
  }
  // Remove domain if present (e.g., "1234567890@s.whatsapp.net" -> "1234567890")
  if (jid.includes('@')) {
    return jid.split('@')[0];
  }
  return jid;
};

// Read LID mappings from SQLite rather than session mapping files.
const getLidMappingValue = (user, direction) => {
  if (!user) return null;

  const normalizedUser = String(user).split(':')[0].split('@')[0];
  const cacheKey = `${direction}:${normalizedUser}`;
  if (lidMappingCache.has(cacheKey)) return lidMappingCache.get(cacheKey);

  try {
    const value = database.getLidMap(direction, normalizedUser) || null;
    lidMappingCache.set(cacheKey, value);
    return value;
  } catch (_) {
    // Do not cache a database-startup error as a permanent missing mapping.
    return null;
  }
};

function isLidJid(value) {
  try {
    const server = jidDecode(String(value || ''))?.server;
    return server === 'lid' || server === 'hosted.lid';
  } catch (_) {
    return false;
  }
}

function rememberLidPair(lid, pn) {
  const lidUser = String(lid || '').split(':')[0].split('@')[0];
  const pnUser = String(pn || '').split(':')[0].split('@')[0];
  if (!lidUser || !pnUser || lidUser === pnUser) return;

  try {
    if (getLidMappingValue(lidUser, 'lidToPn') !== pnUser) {
      database.saveLidMap('lidToPn', lidUser, pnUser);
      lidMappingCache.set(`lidToPn:${lidUser}`, pnUser);
    }
    if (getLidMappingValue(pnUser, 'pnToLid') !== lidUser) {
      database.saveLidMap('pnToLid', pnUser, lidUser);
      lidMappingCache.set(`pnToLid:${pnUser}`, lidUser);
    }
  } catch (_) {}
}

function rememberParticipantLidMap(participant) {
  if (!participant || typeof participant === 'string') return;
  const values = [participant.lid, participant.id, participant.userJid].filter(Boolean);
  const lid = values.find(isLidJid);
  const pn = participant.phoneNumber || participant.pn || values.find(value => !isLidJid(value));
  if (lid && pn) rememberLidPair(lid, pn);
}

// Normalize JID handling LID conversion
const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;

  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    }

    let user = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;

    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) {
        user = pnUser;
        server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        return true;
      }
      return false;
    };

    if (server === 'lid' || server === 'hosted.lid') {
      mapToPn();
    } else if (server === 's.whatsapp.net' || server === 'hosted') {
      mapToPn();
    }

    if (server === 'hosted') {
      return jidEncode(user, 'hosted');
    }
    return jidEncode(user, 's.whatsapp.net');
  } catch (error) {
    return jid;
  }
};

// Build comparable JID variants (PN + LID) for matching
const buildComparableIds = (jid) => {
  if (!jid) return [];

  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return [normalizeJidWithLid(jid)].filter(Boolean);
    }

    const variants = new Set();
    const normalizedServer = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;

    variants.add(jidEncode(decoded.user, normalizedServer));

    const isPnServer = normalizedServer === 's.whatsapp.net' || normalizedServer === 'hosted';
    const isLidServer = normalizedServer === 'lid' || normalizedServer === 'hosted.lid';

    if (isPnServer) {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) {
        const lidServer = normalizedServer === 'hosted' ? 'hosted.lid' : 'lid';
        variants.add(jidEncode(lidUser, lidServer));
      }
    } else if (isLidServer) {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) {
        const pnServer = normalizedServer === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        variants.add(jidEncode(pnUser, pnServer));
      }
    }

    return Array.from(variants);
  } catch (error) {
    return [jid];
  }
};

// Find participant by either PN JID or LID JID
const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));

  if (!targets.length) return null;

  return participants.find(participant => {
    if (!participant) return false;
    rememberParticipantLidMap(participant);

    const participantIds = [
      participant.id,
      participant.lid,
      participant.userJid
    ]
      .filter(Boolean)
      .flatMap(id => buildComparableIds(id));

    return participantIds.some(id => targets.includes(id));
  }) || null;
};

const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant) return false;

  // Early return for non-group JIDs (DMs) - prevents slow sock.groupMetadata() call
  if (!groupId || !groupId.endsWith('@g.us')) {
    return false;
  }

  // Always fetch live metadata for admin checks
  let liveMetadata = groupMetadata;
  if (!liveMetadata || !liveMetadata.participants) {
    if (groupId) {
      liveMetadata = await getLiveGroupMetadata(sock, groupId);
    } else {
      return false;
    }
  }

  if (!liveMetadata || !liveMetadata.participants) return false;

  // Use findParticipant to handle LID matching
  const foundParticipant = findParticipant(liveMetadata.participants, participant);
  if (!foundParticipant) return false;

  return foundParticipant.admin === 'admin' || foundParticipant.admin === 'superadmin';
};

const isBotAdmin = async (sock, groupId, groupMetadata = null) => {
  if (!sock.user || !groupId) return false;
  if (!groupId.endsWith('@g.us')) return false;

  // Return from cache if still fresh — avoids a live network call every message
  const cached = botAdminCache.get(groupId);
  if (cached && Date.now() - cached.ts < BOT_ADMIN_TTL) return cached.isAdmin;

  try {
    const botId  = sock.user.id;
    const botLid = sock.user.lid;
    if (!botId) return false;

    const botJids = [botId];
    if (botLid) botJids.push(botLid);

    const liveMetadata = await getLiveGroupMetadata(sock, groupId);
    if (!liveMetadata || !liveMetadata.participants) return false;

    const participant = findParticipant(liveMetadata.participants, botJids);
    const isAdmin = !!(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));

    // Store result so the next ~2 minutes of messages skip the API call
    botAdminCache.set(groupId, { isAdmin, ts: Date.now() });
    return isAdmin;
  } catch {
    return false;
  }
};

function extractButtonId(content, msg) {
  const raw = content || msg?.message || {};
  const candidates = [
    raw.buttonsResponseMessage?.selectedButtonId,
    raw.templateButtonReplyMessage?.selectedId,
    raw.listResponseMessage?.singleSelectReply?.selectedRowId,
    raw.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
    raw.interactiveResponseMessage?.body?.text,
    msg?.message?.buttonsResponseMessage?.selectedButtonId,
    msg?.message?.templateButtonReplyMessage?.selectedId,
    msg?.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    msg?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
  ].filter(Boolean);

  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const id = parsed.id || parsed.selectedId || parsed.cmd || parsed.command || parsed.name;
        if (id) return String(id);
      } catch (_) {}
      continue;
    }
    return trimmed;
  }
  return null;
}

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') ||
         jid.includes('status.broadcast') ||
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Main message handler
const handleMessage = async (sock, msg) => {
  try {
    // Debug logging to see all messages
    // Debug log removed

    if (!msg.message) return;


    // Store message for antidelete and antiedit
    try {
      const antidelete = commands.get('antidelete');
      if (antidelete?.storeMessage) antidelete.storeMessage(msg);
    } catch (_) {}
    try {
      const antiedit = commands.get('antiedit');
      if (antiedit?.storeMessage) antiedit.storeMessage(msg);
    } catch (_) {}

    // Cache view-once messages so emoji reactions can look them up later
    try { cacheViewOnceMsg(msg); } catch (_) {}

    // ── Emoji reaction → reveal view-once to DM ──────────────────────────────
    // When the bot owner (either the bot's own linked account reacting, i.e.
    // fromMe, or a configured sudo/owner number) reacts with any emoji to a
    // view-once message, the bot sends the media to sock.user.id's own chat.
    if (msg.message?.reactionMessage) {
      try {
        const _rxn = msg.message.reactionMessage;
        // When the reaction comes from the bot's own linked account (fromMe),
        // key.participant is empty/unreliable — fall back to our own JID so
        // isOwner/isSudo checks (and logging) still have something sane to use.
        const _rxSender = msg.key.fromMe
          ? getSelfJid(sock)
          : (msg.key.participant || msg.key.remoteJid);
        const _rxFrom = msg.key.remoteJid;
        // Trigger for the bot's own account (fromMe) OR owner/sudo users
        if (_rxn.text && (msg.key.fromMe || isOwner(_rxSender) || isSudo(_rxSender))) {
          const _origId = _rxn.key?.id;
          const _cached = _origId ? voCache.get(_origId) : null;
          if (_cached && _cached.expires > Date.now()) {
            const _selfJid = getSelfJid(sock);
            const _ok = await revealVoToDM(sock, _cached.msg, _selfJid);
            if (_ok) {
              // React ✅ on the original reaction message to confirm
              await sock.sendMessage(_rxFrom, { react: { text: '✅', key: msg.key } });
            }
          }
        }
      } catch (_rxErr) { console.error('[VO React]', _rxErr.message); }
      return; // reactions don't need further command processing
    }
    // ─────────────────────────────────────────────────────────────────────────

    // rc13 LID DMs: remoteJid is a @lid JID — resolve to phone JID so all
    // sock.sendMessage(from, ...) calls reach the user instead of silently failing.
    const _rawFrom = msg.key.remoteJid;
    const from = (!_rawFrom.endsWith('@g.us') && _rawFrom.endsWith('@lid') && msg.key.remoteJidAlt)
      ? msg.key.remoteJidAlt
      : _rawFrom;

    // Status updates are filtered from normal command processing, but the
    // auto-download-status command needs to see them first. Its SQLite
    // status_downloads guard makes this safe alongside index.js's status hook.
    if (_rawFrom === 'status@broadcast') {
      try {
        const statusCommand = commands.get('autodownloadstatus');
        if (statusCommand?.handleAutoDownloadStatus) {
          await statusCommand.handleAutoDownloadStatus(sock, msg.key, msg.message);
        }
      } catch (error) {
        console.error('[AutoDL-Status hook]', error.message);
      }
      return;
    }

    // System message filter - ignore broadcast/status/newsletter messages
    if (isSystemJid(_rawFrom)) {
      return; // Silently ignore system messages
    }

    // Unwrap containers first
    const content = getMessageContent(msg);
    // Note: We don't return early if content is null because forwarded status messages might not have content

    // Still check for actual message content for regular processing
    let actualMessageTypes = [];
    if (content) {
      const allKeys = Object.keys(content);
      // Filter out protocol/system messages and find actual message content
      const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = allKeys.filter(key => !protocolMessages.includes(key));
    }

    // We'll check for empty content later after we've processed group messages

    // Use the first actual message type (conversation, extendedTextMessage, etc.)
    const messageType = actualMessageTypes[0];

    // Derive sender JID.
    // rc13 LID change: for @lid-based DMs remoteJid is a LID JID and remoteJidAlt
    // carries the phone-number JID.  Use the alt immediately so isOwner / command
    // checks get a real phone number without waiting for an async lookup.
    const _rawSender = msg.key.fromMe
      ? getSelfJid(sock)
      : msg.key.participant || msg.key.remoteJid;
    const _isGroupJid = from.endsWith('@g.us');
    const sender = (!_isGroupJid && isLidJid(_rawSender) && msg.key.remoteJidAlt)
      ? msg.key.remoteJidAlt   // phone JID available directly — skip async LID lookup
      : _rawSender;
    if (!_isGroupJid && isLidJid(_rawSender) && msg.key.remoteJidAlt) {
      rememberLidPair(_rawSender, msg.key.remoteJidAlt);
    }
    const isGroup = _isGroupJid;

    // ── Presence on ANY incoming message (DM or group, never bot's own) ──────
    if (!msg.key.fromMe) {
      try {
        const { getModeFor } = require('./utils/presenceSettings');
        const _pm = getModeFor(from);
        if (_pm === 'recordtype') {
          sock.sendPresenceUpdate('recording', from).catch(() => {});
          setTimeout(() => {
            sock.sendPresenceUpdate('composing', from).catch(() => {});
          }, 1500);
        } else if (_pm === 'recording') {
          sock.sendPresenceUpdate('recording', from).catch(() => {});
        } else if (_pm === 'typing') {
          sock.sendPresenceUpdate('composing', from).catch(() => {});
        }
      } catch (_pErr) {}
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Fetch group metadata immediately if it's a group
    const groupMetadata = isGroup ? await getGroupMetadata(sock, from) : null;

    // ── Muted-user enforcement: silently delete their messages ────────────────
    if (isGroup && !msg.key.fromMe && sender) {
      try {
        if (database.isUserMuted(from, sender)) {
          await sock.sendMessage(from, { delete: msg.key });
          return; // stop all further processing
        }
      } catch (_muteErr) {}
    }

    // Group moderation hooks.
    //
    // The built-in anti-* checks (antilink, antibadword, antigroupmention,
    // antigroupstatus, antiMedia, antibug, anticall) were removed along with
    // the commands that configured them — they were dormant, since every group
    // setting they read defaults to false. What remains is command-provided, so
    // dropping the matching file back into commands/ re-enables the check with
    // no edit to this handler.
    if (isGroup) {
      const antispam      = commands.get('antispam');
      const antiviewonce  = commands.get('antiviewonce');
      const antibot       = commands.get('antibot');
      const antiforward   = commands.get('antiforward');
      const antitagadmins = commands.get('antitagadmins');
      await Promise.allSettled([
        antispam?.handleAntispam         ? antispam.handleAntispam(sock, msg, groupMetadata)                                    : Promise.resolve(),
        antiviewonce?.handleAntiviewonce ? antiviewonce.handleAntiviewonce(sock, msg)                                           : Promise.resolve(),
        antibot?.handleMessage           ? antibot.handleMessage(sock, msg, groupMetadata)                                      : Promise.resolve(),
        antiforward?.handleAntiforward   ? antiforward.handleAntiforward(sock, msg, groupMetadata)                              : Promise.resolve(),
        antitagadmins?.handleMessage     ? antitagadmins.handleMessage(sock, msg, groupMetadata, sender, from, isOwner(sender))  : Promise.resolve(),
      ]);
    }

    // Track group message statistics
    if (isGroup) {
      addMessage(from, sender);
    }

    // Return early for non-group messages with no recognizable content
    if (!content || actualMessageTypes.length === 0) return;

    // Button / native-flow response. gifted-btns and current WhatsApp send
    // interactiveResponseMessage.paramsJson, not the old buttonsResponseMessage.
    const buttonId = extractButtonId(content, msg);
    if (buttonId) {

      // Helper to build the standard extra object for command execution
      const makeExtra = async () => ({
        from,
        sender,
        isGroup,
        groupMetadata,
        isOwner: isOwner(sender),
        isAdmin: await isAdmin(sock, sender, from, groupMetadata),
        isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
        isMod: isMod(sender),
        isSudo: isMod(sender),
        prefix: database.getBotSetting('prefix') || '.',
        command: '',
        reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
        react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
      });

      // Handle button clicks by routing to commands
      if (buttonId === 'btn_menu') {
        const extra = await makeExtra();
        const menuCmd = commands.get('menu');
        if (menuCmd) await menuCmd.execute(sock, msg, [], extra);
        return;

      // ── Named menu buttons (non-prefixed IDs) ─────────────────────────────
      } else if (buttonId === 'menu_repo') {
        const repoUrl = database.SOCIAL?.github || 'https://github.com/Vinpink2/June-Ultra';
        await sock.sendMessage(from, { text: `💻 *Bot Repository*\n${repoUrl}` }, { quoted: msg });
        return;

      } else if (buttonId === 'menu_yt') {
        const ytUrl = database.SOCIAL?.youtube || 'http://youtube.com/@suprem_e_lord';
        await sock.sendMessage(from, { text: `📺 *YouTube Channel*\n${ytUrl}` }, { quoted: msg });
        return;

      // ── Ping / uptime — execute directly ──────────────────────────────────
      } else if (buttonId === 'btn_ping') {
        const extra = await makeExtra();
        const pingCmd = commands.get('ping');
        if (pingCmd) await pingCmd.execute(sock, msg, [], extra);
        return;

      } else if (buttonId === 'btn_help') {
        const extra = await makeExtra();
        const listCmd = commands.get('list');
        if (listCmd) await listCmd.execute(sock, msg, [], extra);
        return;
      }

      // ── Generic fallback: buttonId starts with the bot prefix → run as command
      const cfgPrefix = database.getBotSetting('prefix') || '.';
      let routedId = String(buttonId).replace(/_(\d{8,})$/, '');
      if (routedId && routedId.startsWith(cfgPrefix)) {
        const parts   = routedId.slice(cfgPrefix.length).trim().split(/\s+/);
        const cmdName = (parts[0] || '').toLowerCase();
        const cmdArgs = parts.slice(1);
        const dynCmd  = commands.get(cmdName);
        if (dynCmd) {
          const extra = await makeExtra();
          extra.command = cmdName;
          extra.prefix  = cfgPrefix;
          extra.isOwner = msg.key.fromMe || extra.isOwner;
          extra.isSudo = extra.isOwner || extra.isSudo;
          extra.isMod = extra.isSudo;
          // Disabled-command gate (button route) — owner/sudo are never blocked
          if (!extra.isOwner && !extra.isSudo && commandToggle.isDisabled(dynCmd.name)) {
            await sock.sendMessage(from, { text: `🚫 The command *${dynCmd.name}* is currently disabled.` }, { quoted: msg });
            return;
          }
          if (dynCmd.ownerOnly && !extra.isOwner && !extra.isSudo) {
            await sock.sendMessage(from, { text: database.MESSAGES.ownerOnly }, { quoted: msg });
            return;
          }
          if (dynCmd.adminOnly && !extra.isAdmin && !extra.isOwner) {
            await sock.sendMessage(from, { text: database.MESSAGES.adminOnly }, { quoted: msg });
            return;
          }
          await dynCmd.execute(sock, msg, cmdArgs, extra);
        }
        return;
      }
    }

    // Get message body from unwrapped content
    let body = '';
    if (content.conversation) {
      body = content.conversation;
    } else if (content.extendedTextMessage) {
      body = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption || '';
    }

    body = (body || '').trim();

    // AntiAll is a SQLite-backed group master toggle. It blocks messages from
    // non-admin/non-owner members before command dispatch.
    if (isGroup) {
      const groupSettings = database.getGroupSettings(from);
      // Never moderate messages sent by the connected WhatsApp account itself.
      // On a linked-device bot those are the owner's green "fromMe" messages.
      if (!msg.key.fromMe && database.isAntiAllEnabled(from)) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        const senderIsOwner = isOwner(sender);

        if (!senderIsAdmin && !senderIsOwner) {
          const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
          if (botIsAdmin) {
            await sock.sendMessage(from, { delete: msg.key });
            return;
          }
        }
      }

      // Anti-tag protection (check BEFORE text check, as tagall can have no text)
      if (groupSettings.antitag && !msg.key.fromMe) {
        const ctx = content.extendedTextMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];

        const messageText = (
          body ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          ''
        );

        const textMentions = messageText.match(/@[\d+\s\-()~.]+/g) || [];
        const numericMentions = messageText.match(/@\d{10,}/g) || [];

        const uniqueNumericMentions = new Set();
        numericMentions.forEach((mention) => {
          const numMatch = mention.match(/@(\d+)/);
          if (numMatch) uniqueNumericMentions.add(numMatch[1]);
        });

        const mentionedJidCount = mentionedJids.length;
        const numericMentionCount = uniqueNumericMentions.size;
        const totalMentions = Math.max(mentionedJidCount, numericMentionCount);

        if (totalMentions >= 3) {
          try {
            const participants = groupMetadata.participants || [];
            const mentionThreshold = Math.max(3, Math.ceil(participants.length * 0.5));
            const hasManyNumericMentions = numericMentionCount >= 10 ||
              (numericMentionCount >= 5 && numericMentionCount >= mentionThreshold);

            if (totalMentions >= mentionThreshold || hasManyNumericMentions) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
              const senderIsOwner = isOwner(sender);

              if (!senderIsAdmin && !senderIsOwner) {
                const action = (groupSettings.antitagAction || 'delete').toLowerCase();

                if (action === 'delete') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, {
                      text: '⚠️ *Tagall Detected!*',
                      mentions: [sender]
                    }, { quoted: msg });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }
                } else if (action === 'kick') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }

                  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
                  if (botIsAdmin) {
                    try {
                      await sock.groupParticipantsUpdate(from, [sender], 'remove');
                    } catch (e) {
                      console.error('Failed to kick for antitag:', e);
                    }
                    const usernames = [`@${sender.split('@')[0]}`];
                    await sock.sendMessage(from, {
                      text: `🚫 *Antitag Detected!*\n\n${usernames.join(', ')} has been kicked for tagging all members.`,
                      mentions: [sender],
                    }, { quoted: msg });
                  }
                }
                return;
              }
            }
          } catch (e) {
            console.error('Error during anti-tag enforcement:', e);
          }
        }
      }
    }

    // AutoSticker feature - convert images/videos to stickers automatically
    if (isGroup) { // Process all messages in groups (including bot's own messages)
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.autosticker) {
        const mediaMessage = content?.imageMessage || content?.videoMessage;

        // Only process if it's an image or video (not documents)
        if (mediaMessage) {
          // Skip if message has a command prefix (let command handle it)
          if (!body.startsWith(database.getBotSetting('prefix'))) {
            try {
              // Import sticker command logic
              const stickerCmd = commands.get('sticker');
              if (stickerCmd) {
                // Execute sticker conversion silently
                await stickerCmd.execute(sock, msg, [], {
                  from,
                  sender,
                  isGroup,
                  groupMetadata,
                  isOwner: isOwner(sender),
                  isAdmin: await isAdmin(sock, sender, from, groupMetadata),
                  isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
                  isMod: isMod(sender),
                  reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
                  react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
                });
                return; // Don't process as command after auto-converting
              }
            } catch (error) {
              console.error('[AutoSticker Error]:', error);
              // Continue to normal processing if autosticker fails
            }
          }
        }
      }
    }

     // Check for active bomb games (before prefix check)
    try {
      const bombModule = require('./commands/fun/bomb');
      if (bombModule.gameState && bombModule.gameState.has(sender)) {
        const bombCommand = commands.get('bomb');
        if (bombCommand && bombCommand.execute) {
          // User has active game, process input
          await bombCommand.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          return; // Don't process as command
        }
      }
    } catch (e) {
      // Silently ignore if bomb command doesn't exist or has errors
    }

    // Check for active tictactoe games (before prefix check)
    try {
      const tictactoeModule = require('./commands/fun/tictactoe');
      if (tictactoeModule.handleTicTacToeMove) {
        // Check if user is in an active game
        const isInGame = Object.values(tictactoeModule.games || {}).some(room =>
          room.id.startsWith('tictactoe') &&
          [room.game.playerX, room.game.playerO].includes(sender) &&
          room.state === 'PLAYING'
        );

        if (isInGame) {
          // User has active game, process input
          const handled = await tictactoeModule.handleTicTacToeMove(sock, msg, {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handled) return; // Don't process as command if move was handled
        }
      }
    } catch (e) {
      // Silently ignore if tictactoe command doesn't exist or has errors
    }

    // Check for active ttt2 games (before prefix check)
    try {
      const ttt2Module = require('./commands/fun/ttt2');
      if (ttt2Module.handleTtt2Move) {
        // Check if user is in an active game
        const isInTtt2 = Object.values(ttt2Module.games || {}).some(room =>
          room.id.startsWith('ttt2') &&
          [room.game.playerX, room.game.playerO].includes(sender) &&
          room.state === 'PLAYING'
        );

        if (isInTtt2) {
          // User has active game, process input
          const handledTtt2 = await ttt2Module.handleTtt2Move(sock, msg, {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, sender, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handledTtt2) return; // Don't process as command if move was handled
        }
      }
    } catch (e) {
      // Silently ignore if ttt2 command doesn't exist or has errors
    }


    // Fancy text style selection: reply to fancy list with just a number
    if (/^\d+$/.test(body.trim())) {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
      if (quotedText.includes('Fancy Text Styles') || quotedText.includes('Fancy Styles for:')) {
        const fancyCmd = commands.get('fancy');
        if (fancyCmd) {
          return fancyCmd.execute(sock, msg, [body.trim()], {
            from,
            sender,
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }),
          });
        }
      }
    }

    // My groups: reply to group list with just a number to get group details
    if (/^\d+$/.test(body.trim())) {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
      if (quotedText.includes('📋') && quotedText.includes('Group List')) {
        const mygroupsCmd = commands.get('mygroups');
        if (mygroupsCmd) {
          return mygroupsCmd.execute(sock, msg, [body.trim()], {
            from,
            sender,
            command: 'mygroups',
            prefix: database.getBotSetting('prefix'),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }),
          });
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────────

    // ── Sticker / single-emoji → auto-reveal view-once ───────────────────────────
    // When the bot owner replies to a view-once with any sticker or a bare emoji,
    // intercept here (before the prefix gate) and run the .vv command directly.
    // Trigger applies for: the bot's own linked account (fromMe) OR an owner/sudo
    // number — previously fromMe was explicitly excluded, which meant your own
    // device could never trigger the reveal.
    {
        const _isSticker     = !!msg.message?.stickerMessage;
        const _rawBody       = msg.message?.extendedTextMessage?.text || msg.message?.conversation || '';
        const _t             = _rawBody.trim();
        const _isSingleEmoji = _t.length > 0 && _t.length <= 16 &&
            /^\p{Emoji}/u.test(_t) && !/^[a-zA-Z0-9./#]/.test(_t);

        if ((_isSticker || _isSingleEmoji) && (msg.key.fromMe || isOwner(sender) || isSudo(sender))) {
            // Extract contextInfo from whichever wrapper is present
            const _ctx =
                msg.message?.stickerMessage?.contextInfo ||
                msg.message?.extendedTextMessage?.contextInfo ||
                msg.message?.imageMessage?.contextInfo ||
                msg.message?.videoMessage?.contextInfo;

            const _quoted = _ctx?.quotedMessage;

            if (_quoted) {
                // Check that the quoted message is actually a view-once
                const _isVO =
                    !!_quoted.viewOnceMessageV2Extension ||
                    !!_quoted.viewOnceMessageV2 ||
                    !!_quoted.viewOnceMessage ||
                    !!_quoted?.imageMessage?.viewOnce ||
                    !!_quoted?.videoMessage?.viewOnce ||
                    !!_quoted?.audioMessage?.viewOnce;

                if (_isVO) {
                    try {
                        const voCmd = commands.get('vv');
                        if (voCmd?.execute) {
                            await voCmd.execute(sock, msg, [], {
                                from,
                                sender,
                                isOwner: true,
                                command: 'vv',
                                reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
                                react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }),
                            });
                        }
                    } catch (_e) {}
                    return;
                }

                // ── Sticker / emoji reply to a status → save to bot self-chat ──
                if (_ctx?.remoteJid === 'status@broadcast') {
                    try {
                        const saveCmd = commands.get('save');
                        if (saveCmd?.execute) {
                            await saveCmd.execute(sock, msg, [], {
                                from,
                                sender,
                                isOwner: msg.key.fromMe || isOwner(sender) || isSudo(sender),
                                command: 'save',
                                forwardToSelf: true,           // sticker/emoji detected here — forward to selfJid
                                triggerLabel: _isSticker ? '🎭 *Trigger:* Sticker' : `💌 *Emoji:* ${_t}`,
                                reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
                                react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }),
                            });
                        }
                    } catch (_e) {}
                    return;
                }
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // Themed console message box (white/Lite theme only — no-op in dark)
    try { require('./utils/consoleTheme').printMessage(msg, content, sock, { groupName: groupMetadata?.subject || null }) } catch (_) {}

    // Prefix gate — determine whether this message even looks like a command attempt.
    // When prefix is empty ('') every message is a potential command (intentional),
    // but that means "command not found" below is what routes to chatbot instead
    // of the prefix check itself.
    
      const _prefix = database.getBotSetting('prefix') ?? '.';
    const hasPrefix = _prefix === '' || body.startsWith(_prefix);

    let args = [];
    let command = null;
    let commandName = '';

    if (hasPrefix) {
        const stripped = _prefix === '' ? body : body.slice(_prefix.length);
        args = stripped.trim().split(/\s+/);
        commandName = (args.shift() || '').toLowerCase();
        command = commands.get(commandName);
    }

    // Auto-React runs after command resolution so "bot" mode reacts only to
    // a real, registered command using the configured prefix—not merely any
    // message that starts with punctuation. It remains before command
    // permissions/dispatch by design, so valid command attempts can be
    // acknowledged even when their command later denies access.
    try {
      const arSettings = getCachedArSettings();
      const sourceMatches = arSettings.mode === 'all' ||
        (arSettings.mode === 'bot' && Boolean(command));
      const { canTargetChat } = require('./utils/autoReact');

      if (
        arSettings.enabled &&
        !msg.key.fromMe &&
        sourceMatches &&
        canTargetChat(arSettings.target, isGroup)
      ) {
        const { reactions } = require('./utils/emojis');
        const emoji = arSettings.randomMode && Array.isArray(reactions) && reactions.length
          ? reactions[Math.floor(Math.random() * reactions.length)]
          : arSettings.fixedEmoji;

        if (emoji) {
          await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
        }
      }
    } catch (e) {
      // A reaction failure must never block normal command/message handling.
      console.error('[AutoReact Error]', e.message);
    }

    // No command matched — either no prefix was used, or (in empty-prefix mode)
    // the first word just isn't a real command name. Either way, fall through
    // to the chatbot auto-reply so plain conversation still gets a response.
       if (!command) {
    const hasMedia = !!(
        msg.message?.imageMessage ||
        msg.message?.stickerMessage ||
        msg.message?.ephemeralMessage?.message?.imageMessage ||
        msg.message?.ephemeralMessage?.message?.stickerMessage ||
        msg.message?.viewOnceMessageV2?.message?.imageMessage ||
        msg.message?.viewOnceMessage?.message?.imageMessage
    );

    if ((body.trim() || hasMedia) && !msg.key.fromMe) {
        try {
            const chatbotCmd = commands.get('chatbot');
            if (chatbotCmd?.handleAutoReply) {
                await chatbotCmd.handleAutoReply(sock, msg, { from, isGroup, commands });
            }
        } catch (e) {
            // Never let chatbot errors break the message handler
        }
    }
    return;
}
    
       let resolvedSender = sender;
    try {
      const { jidDecode: _jidDec } = require('@whiskeysockets/baileys');
      const { getLidMappingValue } = require('./utils/jidHelper');
      const decoded = sender ? _jidDec(sender) : null;
      const server  = decoded?.server;
      const isLidServer = server === 'lid' || server === 'hosted.lid';

      if (isLidServer && decoded?.user) {
        if (isGroup && groupMetadata?.participants) {
          // Group path: resolve via participant list (most authoritative for groups)
          const matched = groupMetadata.participants.find(p => {
            if (!p) return false;
            const pId  = typeof p === 'string' ? p : (p.id  || p.jid || '');
            const pLid = typeof p === 'string' ? '' : (p.lid || '');
            return pId === sender || pLid === sender;
          });
          if (matched && typeof matched === 'object') {
            rememberParticipantLidMap(matched);
            const pn = matched.phoneNumber || matched.pn;
            if (pn) resolvedSender = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          }
          // Fallback to the SQLite LID map if participant data had no phone number
          if (resolvedSender === sender) {
            const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
            if (pnUser) resolvedSender = `${pnUser}@s.whatsapp.net`;
          }
        } else if (!isGroup) {
          // DM path: use Baileys in-memory LID state first, then the persisted
          // SQLite lid_map value. By messages.upsert, Baileys often already has
          // the mapping from remoteJidAlt, and resolvePhone persists it.
          try {
            const { resolvePhone } = require('./utils/jidHelper');
            const pn = await resolvePhone(sock, sender);
            if (pn) resolvedSender = `${pn}@s.whatsapp.net`;
          } catch (_) {
            // Fallback: mapping already stored in SQLite.
            const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
            if (pnUser) resolvedSender = `${pnUser}@s.whatsapp.net`;
          }
        }
      }
    } catch (_lidErr) {
      // Never let resolution errors block command execution
    }
    // ─────────────────────────────────────────────────────────────────────────

    const senderIsOwner = msg.key.fromMe || isOwner(resolvedSender);
    const senderIsSudo  = senderIsOwner || isSudo(resolvedSender);

    // Self mode — bot only responds to its own messages (self-bot mode)
    if (database.getBotSetting('selfMode') && !msg.key.fromMe) return;

    // Bot mode check
    {
      const { getMode } = require('./utils/botMode');
      const botModeVal = getMode();
      // Accept both the user-facing names and the old silent/groups/dms rows.
      if ((botModeVal === 'private' || botModeVal === 'silent') && !senderIsSudo) {
        return;
      }
      if ((botModeVal === 'group' || botModeVal === 'groups') && !isGroup && !senderIsSudo) {
        return;
      }
      if ((botModeVal === 'pm' || botModeVal === 'dms') && isGroup && !senderIsSudo) {
        return;
      }
    }

    // Permission checks
    if (command.ownerOnly && !senderIsOwner && !senderIsSudo) {
      return sock.sendMessage(from, { text: database.MESSAGES.ownerOnly }, { quoted: msg });
    }

    if (command.modOnly && !senderIsSudo) {
      return sock.sendMessage(from, { text: '🔒 This command is only for moderators!' }, { quoted: msg });
    }

    if (command.groupOnly && !isGroup) {
      return sock.sendMessage(from, { text: database.MESSAGES.groupOnly }, { quoted: msg });
    }

    if (command.privateOnly && isGroup) {
      return sock.sendMessage(from, { text: database.MESSAGES.privateOnly }, { quoted: msg });
    }

    if (command.adminOnly && !(await isAdmin(sock, sender, from, groupMetadata)) && !senderIsOwner) {
      return sock.sendMessage(from, { text: database.MESSAGES.adminOnly }, { quoted: msg });
    }

    if (command.botAdminNeeded) {
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      if (!botIsAdmin) {
        return sock.sendMessage(from, { text: database.MESSAGES.botAdminNeeded }, { quoted: msg });
      }
    }

    // Disabled-command gate — owners/sudo are never blocked, so .enable
    // always works even while its target command is disabled.
    if (!senderIsOwner && !senderIsSudo && commandToggle.isDisabled(command.name)) {
      return sock.sendMessage(from, { text: `🚫 The command *${command.name}* is currently disabled.` }, { quoted: msg });
    }

    // Auto presence indicators — read from database/bot-settings.json via presenceSettings
    try {
      const { getModeFor } = require('./utils/presenceSettings');
      const presenceMode = getModeFor(from);
      if (presenceMode === 'recordtype') {
        await sock.sendPresenceUpdate('recording', from);
        await new Promise(r => setTimeout(r, 1500));
        await sock.sendPresenceUpdate('composing', from);
        await new Promise(r => setTimeout(r, 800));
      } else if (presenceMode === 'recording') {
        await sock.sendPresenceUpdate('recording', from);
        await new Promise(r => setTimeout(r, 1000));
      } else if (presenceMode === 'typing') {
        await sock.sendPresenceUpdate('composing', from);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (presenceErr) {
      // Never let presence failure block the command
      console.error('[PRESENCE] error:', presenceErr.message);
    }

    // Themed command execution log (dark = classic Ultra, light = Lite style)
    const senderNum = sender.split('@')[0].split(':')[0];
    require('./utils/consoleTheme').cmdLine(
      commandName,
      senderNum,
      senderIsOwner ? 'OWNER' : senderIsSudo ? 'SUDO' : 'USER'
    );

    const { applyFont } = require('./utils/fontConverter');
    await command.execute(sock, msg, args, {
      from,
      sender,
      isGroup,
      groupMetadata,
      groupName: groupMetadata?.subject || null,
      isOwner: senderIsOwner,
      isAdmin: await isAdmin(sock, sender, from, groupMetadata),
      isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
      isMod: senderIsSudo,
      isSudo: senderIsSudo,
      prefix: database.getBotSetting('prefix'),
      command: commandName,
      reply: (text) => sock.sendMessage(from, { text: applyFont(text) }, { quoted: msg }),
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }),
      getCommandCount: () => commands.commandCount ?? commands.size,
      getAliasCount: () => commands.aliasCount ?? 0,
      getActiveUsers: (groupId, limit) => getActiveUsers(groupId, limit),
      getInactiveUsers: (groupId, participants) => getInactiveUsers(groupId, participants)
    });

  } catch (error) {
    console.error('Error in message handler:', error);

    // Don't send error messages for rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      return;
    }

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `${database.MESSAGES.error}\n\n${error.message}`
      }, { quoted: msg });
    } catch (e) {
      // Don't log rate limit errors when sending error messages
      if (!e.message || !e.message.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

module.exports = {
  handleMessage,
  isOwner,
  isAdmin,
  isBotAdmin,
  isMod,
  isSudo,
  getGroupMetadata,
  findParticipant,
  getCommandCount: () => commands.commandCount ?? commands.size,
  getAliasCount: () => commands.aliasCount ?? 0
};
