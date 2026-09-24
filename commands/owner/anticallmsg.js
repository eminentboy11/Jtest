'use strict';
const database = require('../../database');


module.exports = {
  name: 'anticallmsg',
  aliases: ['acmsg', 'anticall-message'],
  category: 'owner',
  ownerOnly: true,
  description: 'Manage anti-call auto-reply messages',
  usage: '.anticallmsg <set|view|reset|off|presets|preset|test>',

  async execute(sock, msg, args, extra) {
    const subcommand = args[0]?.toLowerCase().trim();

    if (!subcommand) {
      return extra.reply(
        '📵 *Anti-Call Message Manager*\n\n' +
        '`.anticallmsg set <text>` - Set custom message\n' +
        '`.anticallmsg view` - View current message\n' +
        '`.anticallmsg reset` - Use default message\n' +
        '`.anticallmsg off` - Disable message sending\n' +
        '`.anticallmsg presets` - Show preset messages\n' +
        '`.anticallmsg preset <id>` - Use a preset\n' +
        '`.anticallmsg test` - Send test message\n\n' +
        '_Example: `.anticallmsg set Sorry, I don\'t take calls!`_\n' +
        '_Aliases: `.acmsg`, `.am`_'
      );
    }


    switch (subcommand) {
      case 'set':
        return handleSet(sock, msg, args, extra);
      case 'view':
        return handleView(sock, msg, extra);
      case 'reset':
        return handleReset(sock, msg, extra);
      case 'off':
        return handleOff(sock, msg, extra);
      case 'presets':
        return handlePresets(sock, msg, extra);
      case 'preset':
        return handlePreset(sock, msg, args, extra);
      case 'test':
        return handleTest(sock, msg, extra);
      default:
        return extra.reply('❌ Unknown subcommand. Use `.anticallmsg` for help.');
    }
  }
};

// Handle: .anticallmsg set <text>
async function handleSet(sock, msg, args, extra) {
  const customMessage = args.slice(1).join(' ').trim();

  if (!customMessage) {
    return extra.reply('❌ Please provide a message.\n\nExample: `.anticallmsg set Sorry, I don\'t accept calls!`');
  }

  if (customMessage.length > 500) {
    return extra.reply('❌ Message is too long. Maximum 500 characters.');
  }

  try {
    const database = require('../../database');
    database.setBotSetting('anticallMessage', customMessage);
    database.setBotSetting('anticallNotify', true);

    return extra.reply(`✅ *Custom message set!*\n\n"${customMessage}"`);
  } catch (err) {
    console.error('[anticallmsg set]', err.message);
    return extra.reply('❌ Failed to update message.');
  }
}

// Handle: .anticallmsg view
async function handleView(sock, msg, extra) {
  const currentMessage = database.getDefaultGroupSettings().anticallMessage;
  const isNotifyEnabled = database.getDefaultGroupSettings().anticallNotify;

  if (!isNotifyEnabled) {
    return extra.reply('📵 *Message sending is disabled.*\n\nUse `.anticallmsg reset` to enable.');
  }

  if (currentMessage) {
    return extra.reply(`📝 *Current Custom Message:*\n\n"${currentMessage}"`);
  }

  const defaultPreset = database.ANTICALL_PRESETS[0];
  return extra.reply(
    `📝 *Current Message (Default Preset):*\n\n` +
    `${defaultPreset.emoji} "${defaultPreset.message}"`
  );
}

// Handle: .anticallmsg reset
async function handleReset(sock, msg, extra) {
  try {
    const database = require('../../database');
    database.setBotSetting('anticallMessage', database.BOT_SETTINGS_DEFAULTS.anticallMessage);
    database.setBotSetting('anticallNotify', database.BOT_SETTINGS_DEFAULTS.anticallNotify);

    return extra.reply(
      '✅ *Message reset to default preset.*\n\n' +
      '📵 "Sorry, I don\'t accept WhatsApp calls. Please send a message."'
    );
  } catch (err) {
    console.error('[anticallmsg reset]', err.message);
    return extra.reply('❌ Failed to reset message.');
  }
}

// Handle: .anticallmsg off
async function handleOff(sock, msg, extra) {
  try {
    const database = require('../../database');
    database.setBotSetting('anticallNotify', false);

    return extra.reply(
      '✅ *Message sending disabled.*\n\n' +
      'Calls will be declined without sending a message.'
    );
  } catch (err) {
    console.error('[anticallmsg off]', err.message);
    return extra.reply('❌ Failed to update settings.');
  }
}

// Handle: .anticallmsg presets
async function handlePresets(sock, msg, extra) {
  const presets = database.ANTICALL_PRESETS;

  let presetList = '📋 *Available Presets:*\n\n';
  presets.forEach((preset) => {
    presetList += `*${preset.id}.* ${preset.emoji} "${preset.message}"\n\n`;
  });

  presetList += '_Use: `.anticallmsg preset <id>`_\n_Example: `.anticallmsg preset 3`_';

  return extra.reply(presetList);
}

// Handle: .anticallmsg preset <id>
async function handlePreset(sock, msg, args, extra) {
  const presetId = parseInt(args[1]);
  const presets = database.ANTICALL_PRESETS;

  if (!presetId || presetId < 1 || presetId > presets.length) {
    return extra.reply(`❌ Invalid preset ID. Choose 1-${presets.length}.`);
  }

  const selectedPreset = presets.find((p) => p.id === presetId);

  try {
    const database = require('../../database');
    database.setBotSetting('anticallMessage', selectedPreset.message);
    database.setBotSetting('anticallNotify', true);

    return extra.reply(
      `✅ *Preset #${presetId} activated!*\n\n` +
      `${selectedPreset.emoji} "${selectedPreset.message}"`
    );
  } catch (err) {
    console.error('[anticallmsg preset]', err.message);
    return extra.reply('❌ Failed to apply preset.');
  }
}

// Handle: .anticallmsg test
async function handleTest(sock, msg, extra) {
  const currentMessage = database.getDefaultGroupSettings().anticallMessage;
  const isNotifyEnabled = database.getDefaultGroupSettings().anticallNotify;

  if (!isNotifyEnabled) {
    return extra.reply(
      '📵 *Message sending is disabled.*\n\n' +
      'Enable it first with `.anticallmsg reset` or `.anticallmsg set`.'
    );
  }

  const testMessage = currentMessage || database.ANTICALL_PRESETS[0].message;

  try {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `🧪 *Test Message Preview:*\n\n"${testMessage}"`
    });

    return extra.reply('✅ Test message sent! Check the chat above.');
  } catch (err) {
    console.error('[anticallmsg test]', err.message);
    return extra.reply('❌ Failed to send test message.');
  }
}
