/**
 * .disable / .enable — turn commands off and back on at runtime.
 * Persisted in SQLite bot_settings via utils/commandToggle, so the list
 * survives restarts. Owner and sudo always bypass the block (enforced in
 * handler.js), so you can never lock yourself out.
 */
'use strict';
const commandToggle = require('../../utils/commandToggle');

function buildStatusLine() {
  const list = commandToggle.getAll();
  return list.length
    ? `🚫 *Disabled commands (${list.length}):*\n${list.map(c => `• ${c}`).join('\n')}`
    : '✅ No commands are disabled.';
}

const makeHandler = (turningOn) => async (sock, msg, args, extra) => {
  try {
    const raw = (args[0] || '').toLowerCase().replace(/^\.+/, '').trim();

    // No argument (or "list") → show the current list
    if (!raw || raw === 'list') {
      return extra.reply(
        `${turningOn ? '✅' : '🚫'} *Command Toggle*\n\n${buildStatusLine()}\n\n` +
        `*Usage:*\n` +
        `  .${turningOn ? 'enable' : 'disable'} <command>\n` +
        (turningOn ? `  .enable all → re-enable everything\n` : '') +
        `\n_Owner & sudo can always use every command._`
      );
    }

    if (turningOn && raw === 'all') {
      const n = commandToggle.enableAll();
      return extra.reply(
        n
          ? `✅ Re-enabled *${n}* command${n === 1 ? '' : 's'}.`
          : '✅ No commands were disabled.'
      );
    }

    // Validate against the live command map when it is available
    const known = extra.commands ? extra.commands.get(raw) : null;
    if (extra.commands && !known) {
      return extra.reply(`❓ No command named *${raw}*. Check the spelling (type \`.menu\` to see all commands).`);
    }
    const canonical = String(known?.name || raw).toLowerCase();

    if (!turningOn && commandToggle.isProtected(canonical)) {
      return extra.reply(`🛡️ *${canonical}* can't be disabled — you'd have no way to re-enable it from chat.`);
    }

    if (turningOn) {
      const wasOff = commandToggle.isDisabled(canonical);
      commandToggle.enable(canonical);
      return extra.reply(
        wasOff
          ? `✅ Command *${canonical}* is now *enabled*.`
          : `✅ Command *${canonical}* was not disabled — nothing to do.`
      );
    }

    const wasOff = commandToggle.isDisabled(canonical);
    commandToggle.disable(canonical);
    return extra.reply(
      wasOff
        ? `🚫 Command *${canonical}* is already disabled.`
        : `🚫 Command *${canonical}* is now *disabled* for everyone except owner/sudo.\nUse \`.enable ${canonical}\` to bring it back.`
    );
  } catch (err) {
    await extra.reply(`❌ Error: ${err.message}`);
  }
};

module.exports = [
  {
    name: 'disable',
    aliases: ['cmdoff'],
    category: 'owner',
    ownerOnly: true,
    description: 'Disable a command at runtime (owner/sudo keep access)',
    usage: '.disable <command | list>',
    execute: makeHandler(false),
  },
  {
    name: 'enable',
    aliases: ['cmdon'],
    category: 'owner',
    ownerOnly: true,
    description: 'Re-enable a disabled command',
    usage: '.enable <command | all | list>',
    execute: makeHandler(true),
  },
];
