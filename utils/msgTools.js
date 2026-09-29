'use strict';

/**
 * Shared message utilities.
 *
 * Ported from the ..wdp mentor codebase (utils/quotedMedia.js + utils/helpers.js)
 * and trimmed to Jtest's lean dependency set: no form-data uploads, no AI
 * registries, no scraping. Everything here is pure or Baileys-only.
 *
 * The quoted helpers solve a real mentor bug: commands that only probed
 * `extendedTextMessage.contextInfo` silently failed when the reply came through
 * a button/list response or a captioned media message. getContextInfo() probes
 * every wrapper WhatsApp sends a contextInfo through, and resolveQuoted()
 * rebuilds a full message shape (proper key) so downloadMediaMessage-style
 * helpers can consume the quoted message.
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// ── contextInfo / quoted resolution ─────────────────────────────────────────

/**
 * Find the contextInfo of a message across every wrapper that can carry one
 * (text reply, captioned media, button reply, list reply).
 *
 * @param {object} msg - incoming WAMessage
 * @returns {object|null} the first contextInfo found
 */
function getContextInfo(msg) {
  const m = msg?.message || {};
  const candidates = [
    m.extendedTextMessage?.contextInfo,
    m.imageMessage?.contextInfo,
    videoCtx(m),
    m.buttonsResponseMessage?.contextInfo,
    m.listResponseMessage?.contextInfo,
    m.templateButtonReplyMessage?.contextInfo,
  ];
  return candidates.find(Boolean) || null;
}

function videoCtx(m) {
  return m.videoMessage?.contextInfo;
}

/**
 * Resolve the quoted message's contextInfo, across all reply wrappers.
 *
 * @param {object} msg
 * @returns {{ ctx: object, quotedMessage: object }|null}
 */
function getQuotedContext(msg) {
  const ctx = getContextInfo(msg);
  return ctx?.quotedMessage ? { ctx, quotedMessage: ctx.quotedMessage } : null;
}

/**
 * Build a synthetic full message object (with proper key) for the quoted
 * message so it can be passed to downloadMediaMessage / downloadMedia.
 *
 * @param {object} msg
 * @returns {{ ctx: object, quotedMessage: object, fullQuoted: object }|null}
 */
function resolveQuoted(msg) {
  const found = getQuotedContext(msg);
  if (!found) return null;
  const { ctx, quotedMessage } = found;
  const fullQuoted = {
    key: {
      remoteJid: ctx.remoteJid || msg.key.remoteJid,
      fromMe: false,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
    message: quotedMessage,
  };
  return { ctx, quotedMessage, fullQuoted };
}

/**
 * The JIDs a message mentions (contextInfo across all wrappers).
 *
 * @param {object} msg
 * @returns {string[]}
 */
function getMentionedJids(msg) {
  return getContextInfo(msg)?.mentionedJid || [];
}

/**
 * Resolve moderation targets (kick / promote / demote / warn / mute …) from
 * the message: @mentions first, then the quoted message's author.
 *
 * @param {object} msg
 * @returns {string[]} zero or more target JIDs
 */
function getTargets(msg) {
  const ctx = getContextInfo(msg);
  const mentioned = ctx?.mentionedJid || [];
  if (mentioned.length) return mentioned;
  if (ctx?.participant && ctx.stanzaId && ctx.quotedMessage) return [ctx.participant];
  return [];
}

// ── media ───────────────────────────────────────────────────────────────────

/**
 * Download a media message's payload into a Buffer.
 *
 * @param {object} message - a message object shaped like { imageMessage: {...} }
 *                          (or the inner quoted message) — the mentor contract
 * @returns {Promise<Buffer>}
 */
async function downloadMedia(message) {
  const messageType = Object.keys(message || {})[0];
  if (!messageType || !message[messageType]) {
    throw new Error('No media content found');
  }
  const kind = messageType.replace(/Message$/, '');
  const stream = await downloadContentFromMessage(message[messageType], kind);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── text helpers ────────────────────────────────────────────────────────────

/**
 * Parse @mentions out of text into JIDs.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseMentions(text) {
  const mentions = [];
  const regex = /@(\d+)/g;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    mentions.push(match[1] + '@s.whatsapp.net');
  }
  return mentions;
}

/** Human uptime string: "2d 4h 13m 9s". */
function runtime(seconds) {
  seconds = Number(seconds) || 0;
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || !parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Human duration string from milliseconds: "1h 2m 3s". */
function formatDuration(ms) {
  ms = Number(ms) || 0;
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/** Human file size: "1.5 MB". */
function formatSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

/** Random element from an array (mentor contract: random(array)). */
function random(array) {
  return Array.isArray(array) ? array[Math.floor(Math.random() * array.length)] : undefined;
}

/** Loose URL probe — enough for link-grabbing commands. */
function isUrl(text) {
  return /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/i.test(String(text || ''));
}

module.exports = {
  getContextInfo,
  getQuotedContext,
  resolveQuoted,
  getMentionedJids,
  getTargets,
  downloadMedia,
  parseMentions,
  runtime,
  formatDuration,
  formatSize,
  random,
  isUrl,
};
