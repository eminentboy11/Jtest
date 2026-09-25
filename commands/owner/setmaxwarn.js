'use strict';

/**
 * SetMaxWarn — owner only
 *
 * How many warnings a member may collect before the bot removes them.
 * Read in 13 places across handler.js, the anti-* features, warn.js and the
 * sticker triggers, all of which use `database.getBotSetting('maxWarnings') || 3`.
 *
 * Stored in SQLite so it survives restarts and the loader re-extracting the
 * application directory.
 */

const database = require('../../database');

const MIN = 1;
const MAX = 20;

function box(lines) {
  return `╭━━『 *Warning Limit* 』━━╮\n\n${lines.join('\n')}\n\n╰━━━━━━━━━━━━━━━━━━╯`;
}

module.exports = {
  name: 'setmaxwarn',
  aliases: ['maxwarn', 'warnlimit', 'setwarnlimit'],
  category: 'owner',
  description: 'Set how many warnings a member gets before being removed',
  usage: '.setmaxwarn <1-20>',
  ownerOnly: true,
  adminOnly: false,
  groupOnly: false,
  botAdminOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const prefix = database.getBotSetting('prefix') || '.';
      const current = database.getBotSetting('maxWarnings');
      const raw = String(args[0] || '').trim();

      if (!raw) {
        return extra.reply(box([
          `⚠️ *Current limit:* *${current}* warning${current === 1 ? '' : 's'}`,
          '',
          `Members are removed once they reach it.`,
          '',
          `💡 *${prefix}setmaxwarn <${MIN}-${MAX}>*`,
          `   Example: *${prefix}setmaxwarn 5*`,
        ]));
      }

      if (!/^\d+$/.test(raw)) {
        return extra.reply(box([`❌ *${raw}* is not a number.`, '', `Use a whole number from ${MIN} to ${MAX}.`]));
      }

      const value = parseInt(raw, 10);
      if (value < MIN || value > MAX) {
        return extra.reply(box([
          `❌ Out of range.`,
          '',
          `Choose a value from *${MIN}* to *${MAX}*.`,
        ]));
      }

      if (value === current) {
        return extra.reply(box([`ℹ️ Already set to *${value}*.`]));
      }

      database.setBotSetting('maxWarnings', value);

      return extra.reply(box([
        `✅ *Warning limit set to ${value}.*`,
        '',
        `Members are now removed after *${value}* warning${value === 1 ? '' : 's'}.`,
        `_Was ${current}._`,
      ]));
    } catch (error) {
      console.error('SetMaxWarn command error:', error);
      return extra.reply(box(['❌ *Failed to update warning limit*', '', error.message]));
    }
  },
};
