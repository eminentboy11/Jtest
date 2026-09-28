/**
 * Bot Mode — the single switch for how the bot behaves.
 * Merged: audience modes (public/private/group/pm) + stealthmode (invisibility).
 *
 *   public  — everyone can use commands in groups and DMs
 *   private — only owner/sudo can use commands anywhere
 *   group   — commands only work in groups (not in DMs)
 *   pm      — commands only work in DMs / private chats (not in groups)
 *   stealth — private PLUS invisibility: no presence updates (typing, recording,
 *             online) and no read receipts leave the socket; the bot connects
 *             without the "online" mark. Enforcement of the owner/sudo gate
 *             lives in handler.js; this module mutes the visibility layer via
 *             applyToSocket() (index.js calls it once per connection, so every
 *             reconnect is covered too).
 *
 * The wrappers check the current mode on every call, so switching modes takes
 * effect immediately — no reconnect needed.
 */
const db = require('../database');

const VALID_MODES = db.VALID_BOT_MODES;

function getMode() {
  return db.getBotMode();
}

function setMode(mode) {
  return db.setBotMode(mode);
}

/** Stealth is just a mode now: mode === 'stealth'. */
function isStealth() {
  return getMode() === 'stealth';
}

function getModeLabel() {
  const labels = {
    public:  '🌐 Public',
    private: '🔒 Private',
    group:   '👥 Group Only',
    pm:      '💬 PM Only',
    stealth: '👻 Stealth',
    silent:  '🔒 Private',
    groups:  '👥 Group Only',
    dms:     '💬 PM Only',
  };
  return labels[getMode()] || '🌐 Public';
}

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
      if (isStealth() && type !== 'unavailable') return;
      return origPresence(type, ...rest);
    };
  }
  if (origRead) {
    sock.readMessages = async (...a) => {
      if (isStealth()) return;
      return origRead(...a);
    };
  }
  return sock;
}

module.exports = { getMode, setMode, getModeLabel, isStealth, applyToSocket, VALID_MODES };
