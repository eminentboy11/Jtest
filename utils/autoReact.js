/**
 * Auto-React settings backed by June X's existing SQLite bot_settings system.
 *
 * The individual keys are intentional: bot_settings is the established
 * settings mechanism and lets updates preserve every unrelated Auto-React
 * preference. The random emoji catalogue is static in utils/emojis.js.
 */
const db = require('../database');

const DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'bot',
  target: 'both',
  fixedEmoji: '🌪️',
  randomMode: false,
});

const MODES = new Set(['bot', 'all']);
const TARGETS = new Set(['dms', 'groups', 'both']);

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function load() {
  // autoReactMode is retained as a read fallback so existing installations
  // keep their selected source mode when upgraded.
  const legacyMode = db.getBotSetting('autoReactMode');
  const mode = db.getBotSetting('autoReactSource') || legacyMode || DEFAULTS.mode;

  return {
    enabled: bool(db.getBotSetting('autoReact'), DEFAULTS.enabled),
    mode: MODES.has(mode) ? mode : DEFAULTS.mode,
    target: TARGETS.has(db.getBotSetting('autoReactTarget'))
      ? db.getBotSetting('autoReactTarget')
      : DEFAULTS.target,
    fixedEmoji: typeof db.getBotSetting('autoReactFixedEmoji') === 'string' && db.getBotSetting('autoReactFixedEmoji').trim()
      ? db.getBotSetting('autoReactFixedEmoji').trim()
      : DEFAULTS.fixedEmoji,
    randomMode: bool(db.getBotSetting('autoReactRandomMode'), DEFAULTS.randomMode),
  };
}

function save(updates = {}) {
  const current = load();
  const next = {
    enabled: Object.prototype.hasOwnProperty.call(updates, 'enabled')
      ? updates.enabled === true : current.enabled,
    mode: Object.prototype.hasOwnProperty.call(updates, 'mode') && MODES.has(updates.mode)
      ? updates.mode : current.mode,
    target: Object.prototype.hasOwnProperty.call(updates, 'target') && TARGETS.has(updates.target)
      ? updates.target : current.target,
    fixedEmoji: Object.prototype.hasOwnProperty.call(updates, 'fixedEmoji') &&
      typeof updates.fixedEmoji === 'string' && updates.fixedEmoji.trim()
      ? updates.fixedEmoji.trim() : current.fixedEmoji,
    randomMode: Object.prototype.hasOwnProperty.call(updates, 'randomMode')
      ? updates.randomMode === true : current.randomMode,
  };

  db.updateBotSettings({
    autoReact: next.enabled,
    // Keep this legacy key synchronized for existing status/settings displays.
    autoReactMode: next.mode,
    autoReactSource: next.mode,
    autoReactTarget: next.target,
    autoReactFixedEmoji: next.fixedEmoji,
    autoReactRandomMode: next.randomMode,
  });

  try {
    db.setBotSetting('autoReact', next.enabled);
    db.setBotSetting('autoReactMode', next.mode);
  } catch (_) {}
  try { global.invalidateSettingsCache?.(); } catch (_) {}

  return next;
}

function canTargetChat(target, isGroup) {
  return target === 'both' || (target === 'groups' && isGroup) || (target === 'dms' && !isGroup);
}

module.exports = { DEFAULTS, load, save, canTargetChat };
