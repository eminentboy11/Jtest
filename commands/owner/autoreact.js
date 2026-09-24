/**
 * Auto-React configuration command.
 * Settings are persisted through the shared SQLite bot_settings infrastructure.
 */
const { load, save } = require('../../utils/autoReact');

function extractSingleEmoji(input) {
  const value = String(input || '').trim();
  const matches = [...value.matchAll(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*?/gu)]
    .map(match => match[0])
    .filter(Boolean);
  // Accept one emoji only, with optional whitespace around it. This prevents an
  // accidental phrase from becoming a stored reaction emoji.
  return matches.length === 1 && value.replace(matches[0], '').trim() === ''
    ? matches[0]
    : null;
}

function formatStatus(settings) {
  const activeReaction = settings.randomMode
    ? [
        'Reaction: *🎲 Random emojis*',
        'To use a fixed emoji:',
        '_.autoreact 🌪️_'
      ]
    : [
        `Reaction: *${settings.fixedEmoji} Fixed emoji*`,
        'To use random emojis:',
        '_.autoreact random_'
      ];

  return [
    '🤖 *AUTO-REACT STATUS*',
    '━━━━━━━━━━━━',
    `Status: *${settings.enabled ? 'ON' : 'OFF'}*`,
    `Source: *${settings.mode === 'bot' ? 'Bot commands only' : 'All messages'}*`,
    `Target: *${settings.target === 'dms' ? 'DMs' : settings.target === 'groups' ? 'Groups' : 'Both'}*`,
    ...activeReaction,
    '━━━━━━━━━━━━',
    '• .autoreact bot | all',
    '• .autoreact dms | groups | both',
    '• .autoreact random | off',
    '• .autoreact <emoji> | status'
  ].join('\n');
}

module.exports = {
  name: 'autoreact',
  category: 'owner',
  description: 'Configure automatic message reactions',
  usage: '.autoreact off | bot | all | dms | groups | both | random | <emoji> | status',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const raw = args.join(' ').trim();
      const option = raw.toLowerCase();

      if (!raw || option === 'status') {
        return extra.reply(formatStatus(load()));
      }

      if (option === 'off') {
        save({ enabled: false });
        return extra.reply('❌ Auto-React disabled.');
      }

      if (option === 'bot' || option === 'all') {
        const settings = save({ mode: option, enabled: true });
        return extra.reply(`✅ Auto-React enabled: *${settings.mode === 'bot' ? 'bot commands only' : 'all messages'}*.`);
      }

      if (option === 'dms' || option === 'groups' || option === 'both') {
        const settings = save({ target: option, enabled: true });
        const label = settings.target === 'dms' ? 'DMs' : settings.target === 'groups' ? 'groups' : 'DMs and groups';
        return extra.reply(`✅ Auto-React enabled for *${label}*.`);
      }

      if (option === 'random') {
        // Random and fixed reactions are mutually exclusive at runtime. The
        // saved fixed emoji remains available as the fixed-mode fallback.
        save({ randomMode: true, enabled: true });
        return extra.reply('✅ Auto-React enabled with random emojis.');
      }

      const emoji = extractSingleEmoji(raw);
      if (emoji) {
        // Selecting a fixed emoji intentionally exits random mode, while
        // preserving enabled/source/target configuration.
        save({ fixedEmoji: emoji, randomMode: false });
        return extra.reply(`✅ Fixed Auto-React emoji set to ${emoji}. Random mode turned OFF.`);
      }

      return extra.reply(
        '⚠️ *Auto-React usage*\n\n' +
        '.autoreact off\n.autoreact bot\n.autoreact all\n' +
        '.autoreact dms\n.autoreact groups\n.autoreact both\n' +
        '.autoreact random\n.autoreact <emoji>\n.autoreact status'
      );
    } catch (error) {
      console.error('[autoreact cmd] error:', error);
      return extra.reply('❌ Error configuring Auto-React.');
    }
  }
};
