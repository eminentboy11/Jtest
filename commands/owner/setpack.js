'use strict';

/**
 * SetPack — owner only
 *
 * Sticker pack metadata. Stored in SQLite via database.js, so it survives
 * restarts and the loader re-extracting the application directory.
 *
 * `author` and `stickerAuthor` are written together. They are the same idea —
 * take.js prefers stickerAuthor and falls back to author, while sticker.js and
 * circlesticker.js read author only — so keeping them in step avoids stickers
 * being credited differently depending on which command produced them.
 */

const database = require('../../database');

const flag = (v) => (v === undefined || v === null || v === '') ? '_not set_' : `*${v}*`;

function box(lines) {
  return `╭━━『 *Sticker Pack* 』━━╮\n\n${lines.join('\n')}\n\n╰━━━━━━━━━━━━━━━━━━╯`;
}

function statusLines(prefix) {
  return [
    `📦 *Pack name:* ${flag(database.getBotSetting('packname'))}`,
    `✍️ *Author:* ${flag(database.getBotSetting('author'))}`,
    '',
    `💡 *${prefix}setpack name <text>*`,
    `💡 *${prefix}setpack author <text>*`,
    `💡 *${prefix}setpack reset*`,
  ];
}

module.exports = {
  name: 'setpack',
  aliases: ['setpackname', 'stickerpack', 'setstickerpack'],
  category: 'owner',
  description: 'Set the sticker pack name and author used on every sticker the bot makes',
  usage: '.setpack name <text> | .setpack author <text> | .setpack reset',
  ownerOnly: true,
  adminOnly: false,
  groupOnly: false,
  botAdminOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const prefix = database.getBotSetting('prefix') || '.';
      const sub = String(args[0] || '').trim().toLowerCase();
      const value = args.slice(1).join(' ').trim();

      if (!sub || sub === 'status') {
        return extra.reply(box(statusLines(prefix)));
      }

      if (sub === 'reset') {
        const d = database.BOT_SETTINGS_DEFAULTS;
        database.setBotSetting('packname', d.packname);
        database.setBotSetting('author', d.author);
        database.setBotSetting('stickerAuthor', d.stickerAuthor);
        return extra.reply(box([
          '♻️ *Reset to defaults.*',
          '',
          ...statusLines(prefix).slice(0, 2),
        ]));
      }

      if (sub !== 'name' && sub !== 'author') {
        return extra.reply(box([
          '❌ *Unknown option.*',
          '',
          `Use *name*, *author* or *reset*.`,
          `Example: *${prefix}setpack name My Pack*`,
        ]));
      }

      if (!value) {
        return extra.reply(box([
          `⚠️ Provide a value.`,
          '',
          `Example: *${prefix}setpack ${sub} ${sub === 'name' ? 'My Pack' : 'My Name'}*`,
        ]));
      }

      if (value.length > 60) {
        return extra.reply(box(['❌ Too long. Maximum 60 characters.']));
      }

      if (sub === 'name') {
        database.setBotSetting('packname', value);
      } else {
        // keep both in step — see the note at the top of this file
        database.setBotSetting('author', value);
        database.setBotSetting('stickerAuthor', value);
      }

      return extra.reply(box([
        `✅ *${sub === 'name' ? 'Pack name' : 'Author'}* updated.`,
        '',
        ...statusLines(prefix).slice(0, 2),
        '',
        '_Make a sticker to see the change._',
      ]));
    } catch (error) {
      console.error('SetPack command error:', error);
      return extra.reply(box(['❌ *Failed to update sticker pack*', '', error.message]));
    }
  },
};
