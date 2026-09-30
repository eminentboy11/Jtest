/**
 * Detect Command — gate deceptive / scam links in this group
 *
 * The `detect` group setting already existed in DEFAULT_GROUP_SETTINGS but
 * nothing in the codebase ever read it, so any toggle would have been a dead
 * switch. This command flips it, and handler.js now enforces it in the same
 * content-protection chain as antilink:
 *
 *   detect OFF (default) -> no scanning
 *   detect ON            -> messages containing deceptive links are deleted
 *
 * What counts as deceptive (see utils/contentGates.js):
 *   · a raw IP address where a domain should be
 *   · a punycode / look-alike domain  (xn--… homograph tricks)
 *   · a link shortener that hides the real destination
 *   · a TLD with a very high scam ratio (.zip .top .tk .ml …)
 *
 * This is deliberately NOT a second antibot. `.antibot` detects bot *accounts*
 * and kicks them; `.detect` scans link *content* and removes the message. They
 * answer different questions and do not overlap.
 *
 * Usage: .detect on | off | status
 */

const database = require('../../database');
const { RISKY_TLDS } = require('../../utils/contentGates');

module.exports = {
  name: 'detect',
  aliases: ['scamguard', 'linkdetect', 'antiscam'],
  category: 'admin',
  description: 'Scan for and remove deceptive/scam links in this group',
  usage: '.detect on|off|status',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    try {
      const option = String(args[0] || '').toLowerCase();
      const current = database.getGroupSettings(extra.from).detect === true;

      const statusLine = `Status: *${current ? 'ON (scanning)' : 'OFF'}*`;

      if (!option) {
        return extra.reply(
          `📌 *Scam Link Detection*\n\n` +
          `${statusLine}\n\n` +
          `While *ON*, messages containing deceptive links are removed:\n` +
          `  · raw IP addresses instead of domains\n` +
          `  · look-alike (punycode) domains\n` +
          `  · link shorteners hiding the destination\n` +
          `  · high-risk TLDs (.${RISKY_TLDS.slice(0, 5).join(' .')} …)\n\n` +
          `Usage:\n  .detect on\n  .detect off\n  .detect status`
        );
      }

      if (option === 'status') {
        return extra.reply(`📌 *Scam Link Detection*\n\n${statusLine}`);
      }

      if (option === 'on') {
        if (current) return extra.reply('*Scam detection is already ON*.');
        database.updateGroupSettings(extra.from, { detect: true });
        return extra.reply(
          '✅ *Scam link detection turned ON*\n\nDeceptive links will now be removed. ' +
          'The bot must be an admin for removal to work.'
        );
      }

      if (option === 'off') {
        if (!current) return extra.reply('*Scam detection is already OFF*.');
        database.updateGroupSettings(extra.from, { detect: false });
        return extra.reply('🛑 *Scam link detection turned OFF*\n\nLinks are no longer scanned.');
      }

      return extra.reply('❌ Invalid option.\nUsage: .detect on|off|status');
    } catch (error) {
      console.error('[detect]', error.message);
      await extra.reply('❌ Could not update the detection setting.');
    }
  },
};
