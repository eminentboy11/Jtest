/**
 * Mode Command — the one command that controls how the bot behaves.
 * Absorbed stealthmode: `.mode stealth` (or `.stealth on`) hides the bot
 * completely — no presence, no read receipts, appears offline, owner-only.
 */
'use strict';
const botMode = require('../../utils/botMode');

module.exports = {
  name: 'mode',
  aliases: ['botmode', 'setmode', 'stealth', 'stealthmode', 'ghost', 'ghostmode'],
  description: 'Set bot mode (public / private / group / pm / stealth)',
  usage: '.mode <public|private|group|pm|stealth>',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const current = botMode.getMode();

      // `.stealth on` / `.ghost off` compatibility from the old command
      const calledAs = extra.command || '';
      const first = (args[0] || '').toLowerCase().trim();
      if (['stealth', 'stealthmode', 'ghost', 'ghostmode'].includes(calledAs)) {
        if (first === 'on' || !first) return setAndAnnounce(sock, extra, 'stealth', current);
        if (first === 'off') return setAndAnnounce(sock, extra, 'private', current);
      }

      if (!first) {
        return extra.reply(
          `🤖 *Bot Mode*\n\n` +
          `Current Mode: *${botMode.getModeLabel()}*\n\n` +
          `*Available Modes:*\n` +
          `  🌐 *.mode public*  — everyone can use commands\n` +
          `  🔒 *.mode private* — only owner & sudo can use commands\n` +
          `  👥 *.mode group*   — commands work in groups only\n` +
          `  💬 *.mode pm*      — commands work in private chats only\n` +
          `  👻 *.mode stealth* — invisible: owner-only + no presence, no read receipts, appears offline\n\n` +
          `_Tip: *.stealth on/off* also works._`
        );
      }

      const mode = botMode.VALID_MODES.includes(first) ? first : null;
      if (!mode) {
        return extra.reply(
          `❌ *Invalid mode:* _${first}_\n\n` +
          `Choose one of: *public, private, group, pm, stealth*`
        );
      }

      if (mode === current) {
        return extra.reply(`ℹ️ Bot is already in *${botMode.getModeLabel()}* mode.`);
      }

      return setAndAnnounce(sock, extra, mode, current);

    } catch (error) {
      console.error('Mode command error:', error);
      await extra.reply('❌ Error changing bot mode.');
    }
  }
};

async function setAndAnnounce(sock, extra, mode, previous) {
  botMode.setMode(mode);

  // Instant visibility effect — 'unavailable' is exactly the appear-offline
  // signal the stealth socket wrapper lets through; 'available' restores.
  try {
    if (mode === 'stealth') await sock.sendPresenceUpdate('unavailable');
    else if (previous === 'stealth') await sock.sendPresenceUpdate('available');
  } catch (_) {}

  const descriptions = {
    public:  'Everyone can use commands in groups and DMs.',
    private: 'Only owner & sudo users can use commands.',
    group:   'Commands only work inside groups.',
    pm:      'Commands only work in private/DM chats.',
    stealth: 'Owner-only, invisible: no typing/online indicators, no read receipts, bot appears offline. autotyping/autoread settings are kept but muted until you leave stealth.',
  };
  const icons = { public: '🌐', private: '🔒', group: '👥', pm: '💬', stealth: '👻' };
  const extraNote = previous === 'stealth' && mode !== 'stealth'
    ? `\n\n👻 _Stealth off — presence and read receipts are live again._`
    : '';

  return extra.reply(
    `${icons[mode]} *Bot mode changed to ${mode.toUpperCase()}*\n\n` +
    `${descriptions[mode]}${extraNote}`
  );
}
