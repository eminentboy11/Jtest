'use strict';

/**
 * .menu — plain-text list of what THIS bot can actually do.
 *
 * Built from the live command table at send time, so it can never advertise a
 * command that is not loaded. The tappable rich-card version is .help.
 */

const { loadCommands } = require('../../utils/commandLoader');
const database = require('../../database');

module.exports = {
  name: 'menu',
  aliases: ['commands', 'cmds'],
  category: 'general',
  description: 'List every command this bot currently has loaded',
  usage: '.menu [category]',

  async execute(sock, msg, args, extra) {
    const table = loadCommands() || new Map();
    const seen = new Set();
    const cats = {};
    for (const [, cmd] of table) {
      if (!cmd?.name || seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const cat = String(cmd.category || 'other').toLowerCase();
      (cats[cat] = cats[cat] || []).push(cmd);
    }

    const filter = String(args[0] || '').toLowerCase();
    const all = Object.keys(cats).sort();
    const names = filter ? all.filter((c) => c === filter) : all;

    const botName = database.getBotSetting('botName') || 'JTEST';
    const lines = [`*${botName} — ${seen.size} commands loaded*`, ''];

    if (!names.length) {
      lines.push(`No category "${filter}".`, `Categories: ${all.join(', ')}`);
    } else {
      for (const cat of names) {
        lines.push(`*${cat.toUpperCase()}*`);
        for (const cmd of cats[cat].sort((a, b) => a.name.localeCompare(b.name))) {
          const al = (cmd.aliases || []).slice(0, 3).map((a) => `.${a}`).join(' ');
          lines.push(`  .${cmd.name}${al ? `  (${al})` : ''}`);
          if (cmd.description) lines.push(`      ${String(cmd.description).slice(0, 80)}`);
        }
        lines.push('');
      }
      lines.push('_.help sends the tappable card version._');
    }

    await sock.sendMessage(extra?.from || msg.key.remoteJid,
      { text: lines.join('\n').trim() }, { quoted: msg });
  },
};
