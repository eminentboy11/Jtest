/**
 * Console Theme Engine — dual-look console for June Ultra.
 *
 * 🌙 DARK  (night) = June Ultra's current log style:
 *      blue bold `[ JUNEX ULTRA ]` prefix, magenta [ CMD ] lines, the big
 *      one-box startup report. Byte-identical to the classic output.
 * ☀️ LIGHT (day)   = June Lite's exact log style:
 *      gray bold `[HH:MM:SS]` timestamp + level icon (💡✅⚠️❌🔌🗄️) on every
 *      line, boxed `╭─╮ 🤖 Bot` message display, Lite-flavoured boot lines.
 *
 * Mode: 'auto' (default) | 'dark' | 'light' — persisted in SQLite
 * bot_settings (key: 'consoleTheme') via database.js, so it survives
 * restarts. Set it from chat with `.theme dark|light|auto`.
 *
 * AUTO switch (user spec): ☀️ white 06:00→18:00, 🌙 dark 18:00→06:00, read
 * in the TIMEZONE env var when set (validated), otherwise standard UTC.
 * The active theme is re-evaluated on every log call and by a 30 s ticker,
 * so the flip happens live — one transition line, no restart.
 */
'use strict';
const chalk = require('chalk');
const db = require('../database');

const KEY = 'consoleTheme';
const VALID = ['auto', 'dark', 'light'];
const DAY_START_HOUR = 6;   // ☀️ white theme from 06:00 (inclusive)…
const NIGHT_START_HOUR = 18; // …🌙 dark theme from 18:00 (inclusive)

// ── Time zone — ONE source of truth: the bot's own timezone setting ────────
// Priority: 1) bot setting 'timezone' (set with .settimezone, default from
// database.js) → 2) TIMEZONE env (parity with June Lite) → 3) UTC fallback.
// The theme clock and every themed timestamp follow the SAME clock as the
// rest of the bot — no duplicate timezone.
function _validTz(v) {
  if (!v || typeof v !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(new Date()); return true; }
  catch (_) { return false; }
}
function getTimeZone() {
  // Single source of truth lives in database.js (bot setting → TIMEZONE env
  // → shipped default). Legacy chain below only for stubs/unloaded db.
  if (typeof db.getTimeZone === 'function') {
    try { return db.getTimeZone(); } catch (_) {}
  }
  try {
    const setting = db.getBotSetting('timezone');
    if (_validTz(setting)) return setting;
  } catch (_) {}
  if (_validTz(process.env.TIMEZONE)) return process.env.TIMEZONE;
  return 'UTC';
}
function getTimeZoneSource() {
  if (typeof db.getTimeZoneSource === 'function') {
    try { return db.getTimeZoneSource(); } catch (_) {}
  }
  try { if (_validTz(db.getBotSetting('timezone'))) return 'bot'; } catch (_) {}
  if (_validTz(process.env.TIMEZONE)) return 'env';
  return 'default';
}

function nowParts() {
  const timeZone = getTimeZone();
  const d = new Date();
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone,
  });
  const hour = Number(d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone }));
  return { time, hour: Number.isFinite(hour) ? hour : 0 };
}

// ── Mode / theme resolution ────────────────────────────────────────────────
function getMode() {
  // Rainbow console is the only look now: the .theme command was removed and
  // any stored light/auto preference is ignored — the classic colorful Ultra
  // console renders permanently, day and night.
  return 'dark';
}

function setMode(mode) {
  // Kept for API compatibility; switching is disabled (rainbow console only).
  return false;
}

function currentTheme() {
  const mode = getMode();
  if (mode === 'dark' || mode === 'light') return mode;
  const { hour } = nowParts();
  return (hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR) ? 'light' : 'dark';
}

// ── Transition line (printed once whenever the active theme flips) ─────────
let _lastTheme = null;
function ensureTheme() {
  const t = currentTheme();
  if (_lastTheme === null) { _lastTheme = t; return t; }
  if (t === _lastTheme) return t;
  const { time, hour } = nowParts();
  const hh = String(hour).padStart(2, '0') + ':00';
  if (t === 'light') {
    console.log(
      chalk.gray.bold(`[${time}]`) + ' ☀️ ' +
      chalk.green.bold(`Console switched to white theme (June Lite style) — ${hh}`)
    );
  } else {
    console.log(
      chalk.blue.bold('[ JUNEX ULTRA ]') + ' ' +
      chalk.yellow(`🌙 Console switched to dark theme (June Ultra style) — ${hh}`)
    );
  }
  _lastTheme = t;
  return t;
}
setInterval(() => { try { ensureTheme(); } catch (_) {} }, 30_000).unref();

// ── Dark logger — June Ultra's classic log(), byte-identical output ────────
function darkLog(message, color, isError) {
  const prefix = chalk.blue.bold('[ JUNEX ULTRA ]');
  const logFunc = isError ? console.error : console.log;
  const coloredMessage = chalk[color] ? chalk[color](message) : message;
  if (String(message).includes('\n') || String(message).includes('════')) {
    logFunc(prefix, coloredMessage)
  } else {
    logFunc(`${prefix} ${coloredMessage}`)
  }
}

// ── Light logger — June Lite's printLog(): [HH:MM:SS] icon text ─────────────
const LIGHT_ICON_BY_COLOR = {
  red: '❌', yellow: '⚠️', green: '✅', cyan: '🔌', magenta: '🗄️',
};
const LIGHT_PAINT_BY_COLOR = {
  red: (t) => chalk.red(t),
  yellow: (t) => chalk.yellow(t),
  green: (t) => chalk.green(t),
  cyan: (t) => chalk.cyan(t),
  magenta: (t) => chalk.magenta(t),
  blue: (t) => chalk.blue(t),
  gray: (t) => chalk.gray(t),
  white: (t) => chalk.white(t),
};
function lightLog(message, color, isError) {
  const { time } = nowParts();
  const c = isError ? 'red' : (LIGHT_PAINT_BY_COLOR[color] ? color : 'white');
  const icon = isError ? '❌' : (LIGHT_ICON_BY_COLOR[c] || '💡');
  const stamp = chalk.gray.bold(`[${time}]`);
  const text = LIGHT_PAINT_BY_COLOR[c](String(message));
  if (String(message).includes('\n')) {
    console.log(stamp, icon, text);
  } else {
    console.log(`${stamp} ${icon} ${text}`);
  }
}

// ── Public logger (global.log calls this) ───────────────────────────────────
function log(message, color = 'white', isError = false) {
  const theme = ensureTheme();
  if (theme === 'light') lightLog(message, color, isError);
  else darkLog(message, color, isError);
}

// ── Command execution line (handler.js) ─────────────────────────────────────
function cmdLine(commandName, senderNum, role) {
  if (ensureTheme() === 'dark') {
    console.log(
      chalk.magenta.bold('[ CMD ]'),
      chalk.cyan(`✦ ${commandName}`),
      chalk.yellow(`← ${senderNum}`),
      role === 'OWNER' ? chalk.green('[OWNER]') : role === 'SUDO' ? chalk.blue('[SUDO]') : chalk.white('[USER]')
    );
    return;
  }
  const { time } = nowParts();
  console.log(
    chalk.gray.bold(`[${time}]`) + ' ' +
    chalk.cyan.bold('⌨️ CMD') + ' ' +
    chalk.green.bold(`✦ ${commandName}`) + ' ' +
    chalk.yellow(`← ${senderNum}`) + ' ' +
    (role === 'OWNER' ? chalk.green('[OWNER]') : role === 'SUDO' ? chalk.blue('[SUDO]') : chalk.gray('[USER]'))
  );
}

// ── Message box — June Lite's exact printMessage() look (light theme only) ──
const BOX_INNER = 50;
const BOX_BAR = '─'.repeat(BOX_INNER);
const BOX_CYAN = '#00D9FF';
const MAX_MSG_LINES = 40;

function edge(text) { return chalk.hex(BOX_CYAN).bold(text); }

function wrapLines(text, width) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = [];
  for (const para of src.split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    const tokens = para.split(/(\s+)/);
    for (const token of tokens) {
      if (token.length > width) {
        if (line.trim()) { out.push(line.trimEnd()); line = ''; }
        for (let i = 0; i < token.length; i += width) {
          const chunk = token.slice(i, i + width);
          if (i + width < token.length) out.push(chunk);
          else line = chunk;
        }
        continue;
      }
      if (line.length + token.length > width) { out.push(line.trimEnd()); line = token.trimStart(); }
      else line += token;
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [''];
}

function printLabeled(label, value, labelPaint, valuePaint) {
  const raw = String(value ?? '');
  const indent = ' '.repeat(Math.max(label.length + 1, 8));
  const firstWidth = Math.max(16, BOX_INNER - (label.length + 2));
  const first = wrapLines(raw, firstWidth);
  const restSrc = first.length > 1 ? first.slice(1).join('\n') : '';
  const rest = restSrc ? wrapLines(restSrc, BOX_INNER - indent.length) : [];
  console.log(edge('│') + ' ' + labelPaint(label) + ' ' + valuePaint(first[0] || ''));
  for (const line of rest) console.log(edge('│') + ' ' + indent + valuePaint(line));
}

function extractPhoneNumber(jid) {
  if (!jid) return null;
  return String(jid)
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace('@g.us', '')
    .split(':')[0];
}

const TYPE_LABELS = {
  conversation: 'TEXT', extendedTextMessage: 'TEXT', imageMessage: 'IMAGE',
  videoMessage: 'VIDEO', audioMessage: 'AUDIO', documentMessage: 'DOCUMENT',
  stickerMessage: 'STICKER', contactMessage: 'CONTACT', locationMessage: 'LOCATION',
};

/**
 * Lite-style boxed message display. No-op unless the LIGHT theme is active,
 * so dark mode keeps Ultra's console exactly as it is today.
 * @param {object} msg       raw Baileys message
 * @param {object} content   unwrapped message content (getMessageContent result)
 * @param {object} sock      live socket (used for bot name / own number)
 * @param {object} [opts]    { groupName } to reuse already-fetched metadata
 */
function printMessage(msg, content, sock, opts = {}) {
  try {
    if (ensureTheme() !== 'light') return;
    if (!msg?.key || !content) return;

    const typeKey = Object.keys(content)[0];
    if (['senderKeyDistributionMessage', 'protocolMessage', 'reactionMessage'].includes(typeKey)) return;

    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || msg.key.remoteJid;
    const isGroup = String(chatId).endsWith('@g.us');
    const fromMe = !!msg.key.fromMe;

    let name = '';
    let phone = '';
    if (fromMe) {
      name = sock?.user?.name || 'Owner';
      phone = extractPhoneNumber(sock?.user?.id || sock?.user?.jid) || 'me';
    } else {
      name = (msg.pushName || '').trim();
      phone = extractPhoneNumber(senderId) || String(senderId || '').split('@')[0];
    }
    const who = name && name !== phone ? `${name} (${phone})` : phone;

    let body = '';
    let fileLength = 0;
    if (typeKey === 'conversation') body = content.conversation || '';
    else if (typeKey === 'extendedTextMessage') body = content.extendedTextMessage?.text || '';
    else if (typeKey === 'imageMessage') { body = content.imageMessage?.caption || '[Image]'; fileLength = content.imageMessage?.fileLength || 0; }
    else if (typeKey === 'videoMessage') { body = content.videoMessage?.caption || '[Video]'; fileLength = content.videoMessage?.fileLength || 0; }
    else if (typeKey === 'audioMessage') {
      const secs = content.audioMessage?.seconds || 0;
      body = `[Audio ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}]`;
      fileLength = content.audioMessage?.fileLength || 0;
    }
    else if (typeKey === 'documentMessage') { body = `[📄 ${content.documentMessage?.fileName || 'Document'}]`; fileLength = content.documentMessage?.fileLength || 0; }
    else if (typeKey === 'stickerMessage') { body = '[Sticker]'; fileLength = content.stickerMessage?.fileLength || 0; }
    else if (typeKey === 'contactMessage') body = `[👤 ${content.contactMessage?.displayName || 'Contact'}]`;
    else if (typeKey === 'locationMessage') body = '[📍 Location]';
    else body = `[${String(typeKey || 'msg').replace('Message', '')}]`;

    let sizeLabel = '';
    if (fileLength > 0) {
      const fl = Number(fileLength) || 0;
      if (fl > 0) {
        const units = ['B', 'KB', 'MB', 'GB'];
        const unit = Math.min(3, Math.floor(Math.log(fl) / Math.log(1024)));
        sizeLabel = ` (${(fl / Math.pow(1024, unit)).toFixed(1)} ${units[unit]})`;
      }
    }

    const stamp = msg.messageTimestamp
      ? new Date((msg.messageTimestamp.low || Number(msg.messageTimestamp) || 0) * 1000)
      : new Date();
    const validStamp = stamp && !Number.isNaN(stamp.getTime()) ? stamp : new Date();
    const time = validStamp.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: getTimeZone(),
    });

    const isCommand = /^\s*[.!#\/]/.test(String(body));
    const typeName = TYPE_LABELS[typeKey] || String(typeKey || 'msg').replace('Message', '').toUpperCase();
    const isBotReply = String(body).includes('JUNE') || String(body).includes('Pinging...') ||
      String(body).includes('*🤖') || (fromMe && String(body).includes('*'));
    const msgPaint = isCommand
      ? (t) => chalk.greenBright.bold(t)
      : isBotReply
        ? (t) => chalk.cyan.bold(t)
        : fromMe
          ? (t) => chalk.blueBright.bold(t)
          : (t) => chalk.white.bold(t);

    console.log(edge('╭' + BOX_BAR));
    console.log(
      edge('│') + ' ' + chalk.cyan.bold('🤖 Bot') + ' ' +
      chalk.white.bgCyan.bold(` ${time} `) + ' ' +
      chalk.magenta.bold(typeName) + chalk.gray.bold(sizeLabel)
    );
    printLabeled(fromMe ? '📤 ME' : '📨 FROM', who,
      (t) => (fromMe ? chalk.green.bold(t) : chalk.yellow.bold(t)),
      (t) => chalk.white.bold(t));
    if (isGroup) {
      const gName = opts.groupName || 'Group';
      printLabeled('👥 GROUP', gName, (t) => chalk.blue.bold(t), (t) => chalk.white.bold(t));
    } else {
      printLabeled('💬 PRIVATE', 'Private Chat', (t) => chalk.magenta.bold(t), (t) => chalk.white.bold(t));
    }
    if (body) {
      console.log(edge('├' + BOX_BAR));
      let lines = wrapLines(body, BOX_INNER);
      if (lines.length > MAX_MSG_LINES) {
        const total = lines.length;
        lines = lines.slice(0, MAX_MSG_LINES);
        lines.push(`... (${total - MAX_MSG_LINES} more lines)`);
      }
      lines.forEach((line, i) => {
        if (i === 0) {
          console.log(edge('│') + ' ' + chalk.hex('#FFD700').bold('💭 MSG') + ' ' + msgPaint(line));
        } else {
          console.log(edge('│') + ' ' + msgPaint(line));
        }
      });
    }
    console.log(edge('╰' + BOX_BAR));
    console.log('');
  } catch (err) {
    // A console cosmetic must never break message handling.
    try { console.log(chalk.red.bold('❌ Error logging message:'), err.message); } catch (_) {}
  }
}

// ── Light boot banner (replaces Ultra's one-box startup report by day) ──────
function bootBanner(data = {}) {
  try {
    ensureTheme();
    const { time } = nowParts();
    const botName = (db.getBotSetting('botName') || 'JUNE-X ULTRA');
    const stamp = () => chalk.gray.bold(`[${nowParts().time}]`);
    const line = (icon, paint, text) => console.log(stamp(), icon, paint(text));

    console.log('');
    line('💡', chalk.blue, `[ ${botName} ]`);
    if (data.version) line('💡', chalk.white, `Version   : v${String(data.version).replace(/^v/, '')}`);
    if (data.owner) line('💡', chalk.white, `Owner     : ${data.owner}`);
    if (data.prefix !== undefined) line('💡', chalk.white, `Prefix    : [ ${data.prefix} ]`);
    if (data.mode) line('💡', chalk.white, `Mode      : ${String(data.mode).toUpperCase()}`);
    if (data.commandCount !== undefined) line('💡', chalk.white, `Commands  : ${data.commandCount} loaded${data.aliasCount ? ` (+${data.aliasCount} aliases)` : ''}`);
    line('🗄️', chalk.magenta, `Database  : ${data.sqliteLabel || 'ready'} (${data.sqliteDriver || 'sqlite'})`);
    if (data.sessionLabel) line('🔌', chalk.cyan, `Session   : ${data.sessionLabel} (${data.authSource || 'sqlite'})`);
    if (data.platform) line('💡', chalk.white, `Platform  : ${data.platform} • Node ${data.nodeVersion || process.version}`);
    if (data.startupTime) line('✅', chalk.green, `Boot complete in ${data.startupTime}`);
    line('💡', chalk.blue, `Timezone  : ${getTimeZone()} (theme switch ${String(DAY_START_HOUR).padStart(2, '0')}:00 ☀️ / ${String(NIGHT_START_HOUR).padStart(2, '0')}:00 🌙)`);
    console.log('');
  } catch (_) { /* never block boot for a cosmetic */ }
}

module.exports = {
  KEY, VALID, getTimeZone, getTimeZoneSource, nowParts, getMode, setMode,
  currentTheme, ensureTheme, log, cmdLine, printMessage, bootBanner,
};
