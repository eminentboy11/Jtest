'use strict';

/**
 * SetMenu Command — owner only
 *
 * Menu presentation settings are stored only in SQLite through database.js.
 */

const database = require('../../database');

const MENU_STYLES = {
  '1': 'Document with thumbnail ad reply',
  '2': 'Simple text reply',
  '3': 'Text with external ad reply',
  '4': 'Image with caption',
  '5': 'Interactive native flow message',
  '6': 'Payment request style',
};

const DISPLAY_OPTIONS = {
  memory:   { key: 'showMemory',      label: 'Memory usage' },
  uptime:   { key: 'showUptime',      label: 'Uptime' },
  plugins:  { key: 'showPluginCount', label: 'Command count' },
  progress: { key: 'showProgressBar', label: 'RAM progress bar' },
};

// .getsettings labels these menumemory / menuuptime / menucommands /
// menuprogress, which did not match the keys accepted here. Accept both
// spellings so whatever a user reads in settings also works as a command.
Object.assign(DISPLAY_OPTIONS, {
  menumemory:   DISPLAY_OPTIONS.memory,
  menuuptime:   DISPLAY_OPTIONS.uptime,
  menucommands: DISPLAY_OPTIONS.plugins,
  commands:     DISPLAY_OPTIONS.plugins,
  menuprogress: DISPLAY_OPTIONS.progress,
  ram:          DISPLAY_OPTIONS.progress,
});

const flag = (enabled) => enabled ? '✅ ON' : '❌ OFF';

function box(lines) {
  let text = `╭━━『 *Menu Style Settings* 』━━╮\n\n`;
  text += lines.join('\n');
  text += `\n\n╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
  return text;
}

function settingsLines(current) {
  return [
    `📌 *Current Style:* ${current.menuStyle} — ${MENU_STYLES[current.menuStyle]}`,
    '',
    '*Menu Details:*',
    `  • Memory: ${flag(current.showMemory)}`,
    `  • Uptime: ${flag(current.showUptime)}`,
    `  • Commands: ${flag(current.showPluginCount)}`,
    `  • Progress Bar: ${flag(current.showProgressBar)}`,
  ];
}

module.exports = {
  name: 'setmenu',
  aliases: ['menustyle', 'menuset'],
  category: 'owner',
  description: 'Set menu style and display details',
  usage: '.setmenu <1-6> | .setmenu <memory|uptime|plugins|progress> [on|off] | .setmenu all <on|off>',
  ownerOnly: true,
  adminOnly: false,
  groupOnly: false,
  botAdminOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const first = String(args[0] || '').trim().toLowerCase();
      const second = String(args[1] || '').trim().toLowerCase();
      const prefix = database.getBotSetting('prefix') || '.';

      if (!first || first === 'status') {
        const current = database.getMenuSettings();
        const lines = settingsLines(current);
        lines.push('', '*Available Styles:*');
        for (const [style, description] of Object.entries(MENU_STYLES)) {
          lines.push(`  *${style}.* ${description}${style === current.menuStyle ? ' ✅' : ''}`);
        }
        lines.push(
          '',
          `💡 Style: *${prefix}setmenu <1-6>*`,
          `💡 Details: *${prefix}setmenu memory on|off*`,
          `💡 Flip one: *${prefix}setmenu memory*`,
          `💡 Flip all: *${prefix}setmenu all off*`,
          `   Options: memory, uptime, plugins (commands), progress`
        );
        return extra.reply(box(lines));
      }

      if (database.MENU_STYLE_VALUES.includes(first)) {
        database.updateMenuSettings({ menuStyle: first });
        return extra.reply(box([
          `✅ *Menu style set to Style ${first}!*`,
          '',
          `📋 ${MENU_STYLES[first]}`,
          '',
          `Send *${prefix}menu* to preview the new style.`,
        ]));
      }

      // `.setmenu all on|off` — flip every display detail at once.
      if (first === 'all') {
        if (!['on', 'off'].includes(second)) {
          return extra.reply(box([
            '⚠️ Choose *on* or *off*.',
            '',
            `Example: *${prefix}setmenu all off*`,
          ]));
        }
        const enabled = second === 'on';
        const patch = {};
        for (const o of Object.values(DISPLAY_OPTIONS)) patch[o.key] = enabled;
        database.updateMenuSettings(patch);
        return extra.reply(box([
          `✅ *All menu details* are now ${flag(enabled)}.`,
          ...settingsLines(database.getMenuSettings()).slice(2),
          '',
          `Send *${prefix}menu* to preview the change.`,
        ]));
      }

      const option = DISPLAY_OPTIONS[first];
      if (option) {
        let enabled;
        if (second === 'on' || second === 'off') {
          enabled = second === 'on';
        } else if (!second || second === 'toggle') {
          // Bare `.setmenu memory` flips whatever it is now, so you do not
          // have to check the current state before changing it.
          enabled = !database.getMenuSettings()[option.key];
        } else {
          return extra.reply(box([
            `⚠️ Choose *on* or *off* for ${option.label}.`,
            '',
            `Example: *${prefix}setmenu ${first} on*`,
            `Or just *${prefix}setmenu ${first}* to flip it.`,
          ]));
        }

        database.updateMenuSettings({ [option.key]: enabled });
        return extra.reply(box([
          `✅ *${option.label}* is now ${flag(enabled)}.`,
          ...settingsLines(database.getMenuSettings()).slice(2),
          '',
          `Send *${prefix}menu* to preview the change.`,
        ]));
      }

      return extra.reply(box([
        '❌ *Invalid menu setting!*',
        '',
        `Choose a style from *1* to *6*, or use one of:`,
        '*memory*, *uptime*, *plugins* (or *commands*), *progress*, *all*',
      ]));
    } catch (error) {
      console.error('SetMenu command error:', error);
      await extra.reply(box(['❌ *Failed to update menu settings*', '', error.message]));
    }
  },
};
