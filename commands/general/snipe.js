/**
 * Snipe Command — show recently deleted messages in this chat
 *
 * Data source: antidelete's record of recovered deletes. Antidelete is what
 * captures messages in the first place, so snipe reports *from* that capture
 * rather than keeping a second copy of every message. Consequence worth
 * knowing: if antidelete is off, nothing was captured and there is nothing to
 * report — the command says so instead of pretending the chat is clean.
 *
 * This reports what was deleted (who/when/type/preview). It deliberately does
 * NOT re-send the original media — that is antidelete's job, and duplicating it
 * here would mean two recovery paths to keep in sync.
 *
 * Usage: .snipe [count]      (count 1..10, default 1)
 */

const { applyFont } = require('../../utils/fontConverter');

const DEFAULT_COUNT = 1;
const MAX_COUNT = 10;

const TYPE_ICONS = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  sticker: '🧩',
  document: '📄',
  text: '💬',
};

/** Compact "how long ago" for a timestamp. */
function timeAgo(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One-line, length-capped preview so a long message cannot flood the chat. */
function preview(text, max = 120) {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const numberFrom = (jid) => String(jid || '').split('@')[0].split(':')[0];

module.exports = {
  name: 'snipe',
  aliases: ['snipped', 'deleted', 'whatdeleted'],
  category: 'general',
  description: 'Show recently deleted messages in this chat',
  usage: '.snipe [count]',
  groupOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      // The antidelete command object is the capture record; reach it through
      // the live dispatch table the handler hands us.
      const antidelete = extra.commands?.get?.('antidelete');

      if (!antidelete?.getRecentDeletes) {
        return extra.reply('❌ Antidelete is not loaded, so nothing is being captured.');
      }

      // Antidelete captures nothing while it is off — surface that plainly
      // rather than reporting "no deletes", which would be misleading.
      const mode = antidelete.getStoreStats?.().mode;
      if (!mode || mode === 'off') {
        return extra.reply(
          '⚠️ *Snipe needs antidelete running.*\n\n' +
          'Nothing is captured while it is off, so there is nothing to snipe.\n' +
          'Enable it with *.antidelete on* (or *.antidelete private* to DM you).'
        );
      }

      const requested = Math.floor(Number(args[0])) || DEFAULT_COUNT;
      const count = Math.min(Math.max(1, requested), MAX_COUNT);

      const hits = antidelete.getRecentDeletes(extra.from, count);
      if (!hits.length) {
        return extra.reply(
          `🫥 Nothing deleted in this chat recently.` +
          (count > 1 ? `\n_(checked the last ${count})_` : '')
        );
      }

      const blocks = hits.map((hit, i) => {
        const who = numberFrom(hit.senderAlt || hit.sender) || 'unknown';
        const icon = TYPE_ICONS[hit.type] || '💬';
        const vo = hit.isVO ? ' · _view-once_' : '';
        const body = preview(hit.text);
        const line = `${i + 1}. ${icon} *@${who}* — ${timeAgo(hit.at)}${vo}`;
        return `${line}\n   > ${body || `_(${hit.type}, no caption)_`}`;
      });

      const mentions = hits
        .map((hit) => hit.senderAlt || hit.sender)
        .filter(Boolean);

      await sock.sendMessage(extra.from, {
        text: applyFont(
          `🕵️ *Recently deleted* — ${hits.length}\n\n` +
          `${blocks.join('\n\n')}\n\n` +
          `_Media is not re-sent here; .antidelete handles recovery._`
        ),
        mentions,
      }, { quoted: msg });

    } catch (error) {
      console.error('[snipe]', error.message);
      await extra.reply('❌ Could not read the delete history.');
    }
  },
};
