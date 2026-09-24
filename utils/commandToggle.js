/**
 * Command Toggle — runtime command disable/enable.
 *
 * Backed by SQLite bot_settings via database.js (key: 'disabledCommands',
 * stored as a JSON array of canonical command names) so the list survives
 * restarts and reconnects.
 *
 * Enforcement lives in handler.js: the dispatch gate asks isDisabled() and
 * refuses non-owner/non-sudo callers. Owner and sudo can always run
 * everything (including .enable), so a disabled command can never lock
 * the bot's owner out of the bot.
 */
const db = require('../database');

const KEY = 'disabledCommands';

// Commands that can never be disabled — turning these off would leave no
// way to manage the feature from chat itself.
const PROTECTED = ['disable', 'enable'];

const readList = () => {
  try {
    const v = db.getBotSetting(KEY);
    return Array.isArray(v) ? v.map(x => String(x).toLowerCase()) : [];
  } catch (_) {
    return [];
  }
};

const writeList = (list) => {
  try {
    db.setBotSetting(KEY, [...new Set(list.map(x => String(x).toLowerCase()))]);
    return true;
  } catch (_) {
    return false;
  }
};

const getAll = () => readList().sort();

const isDisabled = (name) => {
  const key = String(name || '').toLowerCase();
  return !!key && readList().includes(key);
};

const isProtected = (name) => PROTECTED.includes(String(name || '').toLowerCase());

/** Marks a command disabled. Idempotent. @returns {boolean} success */
const disable = (name) => {
  const key = String(name || '').toLowerCase();
  if (!key || isProtected(key)) return false;
  const list = readList();
  if (list.includes(key)) return true; // already disabled
  return writeList([...list, key]);
};

/** Marks a command enabled. Idempotent. @returns {boolean} success */
const enable = (name) => {
  const key = String(name || '').toLowerCase();
  if (!key) return false;
  const list = readList();
  if (!list.includes(key)) return true; // already enabled
  return writeList(list.filter(x => x !== key));
};

/** Re-enables every disabled command. @returns {number} how many were re-enabled */
const enableAll = () => {
  const list = readList();
  writeList([]);
  return list.length;
};

module.exports = { KEY, PROTECTED, getAll, isDisabled, isProtected, disable, enable, enableAll };
