/**
 * Stealth Mode — makes the bot completely invisible.
 *
 * Backed by SQLite bot_settings via database.js (key: 'stealthMode').
 * While enabled:
 *   • no presence updates leave the socket (typing, recording, online)
 *   • no read receipts leave the socket (chats AND statuses)
 *   • the socket connects with markOnlineOnConnect disabled
 *
 * It does not touch any other feature's settings: autotyping, autorecording,
 * alwaysonline and autoread keep their configured values — they are simply
 * muted while stealth is on, and resume the moment stealth is turned off.
 *
 * applyToSocket() wraps the live Baileys socket once per connection (index.js
 * calls it right after makeWASocket, so every reconnect is covered too).
 * The wrappers check the current setting on every call, so toggling stealth
 * takes effect immediately — no reconnect needed.
 */
const db = require('../database');

const KEY = 'stealthMode';

const isEnabled = () => {
  try { return !!db.getBotSetting(KEY); } catch (_) { return false; }
};

const setEnabled = (value) => {
  try { db.setBotSetting(KEY, !!value); return true; } catch (_) { return false; }
};

/**
 * Silence a live socket while stealth is on.
 * 'unavailable' presence is deliberately allowed through — that is the
 * "appear offline" signal stealth itself needs when it switches on.
 */
function applyToSocket(sock) {
  if (!sock || sock.__stealthPatched) return sock;
  sock.__stealthPatched = true;

  const origPresence = typeof sock.sendPresenceUpdate === 'function'
    ? sock.sendPresenceUpdate.bind(sock) : null;
  const origRead = typeof sock.readMessages === 'function'
    ? sock.readMessages.bind(sock) : null;

  if (origPresence) {
    sock.sendPresenceUpdate = async (type, ...rest) => {
      if (isEnabled() && type !== 'unavailable') return;
      return origPresence(type, ...rest);
    };
  }
  if (origRead) {
    sock.readMessages = async (...a) => {
      if (isEnabled()) return;
      return origRead(...a);
    };
  }
  return sock;
}

module.exports = { KEY, isEnabled, setEnabled, applyToSocket };
