/**
 * NSFW Command — gate adult-content links in this group
 *
 * The `nsfw` group setting already existed in DEFAULT_GROUP_SETTINGS but nothing
 * in the codebase ever read it, so any toggle would have been a dead switch.
 * This command flips it, and handler.js now enforces it in the same
 * content-protection chain as antilink:
 *
 *   nsfw OFF (default) -> messages containing adult-content links are deleted
 *   nsfw ON            -> those links are allowed through
 *
 * The domain list lives in utils/contentGates.js so this command and the
 * handler cannot drift apart.
 *
 * Usage: .nsfw on | off | status
 */

const database = require('../../database');
const { NSFW_DOMAINS } = require('../../utils/contentGates');

module.exports = {
  name: 'nsfw',
  aliases: ['adultfilter', 'antinsfw'],
  category: 'admin',
  description: 'Allow or block adult-content links in this group',
  usage: '.nsfw on|off|status',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    try {
      const option = String(args[0] || '').toLowerCase();
      const current = database.getGroupSettings(extra.from).nsfw === true;

      const statusLine = `Status: *${current ? 'ON (adult links allowed)' : 'OFF (adult links blocked)'}*`;

      if (!option) {
        return extra.reply(
          `📌 *NSFW Filter*\n\n` +
          `${statusLine}\n\n` +
          `While *OFF*, messages containing links to adult sites are removed.\n` +
          `While *ON*, they are allowed through.\n\n` +
          `Tracking ${NSFW_DOMAINS.length} known adult domains.\n\n` +
          `Usage:\n  .nsfw on\n  .nsfw off\n  .nsfw status`
        );
      }

      if (option === 'status') {
        return extra.reply(`📌 *NSFW Filter*\n\n${statusLine}`);
      }

      if (option === 'on') {
        if (current) return extra.reply('*NSFW filter is already ON* — adult links are allowed.');
        database.updateGroupSettings(extra.from, { nsfw: true });
        return extra.reply(
          '✅ *NSFW filter turned ON*\n\nAdult-content links are now allowed in this group.'
        );
      }

      if (option === 'off') {
        if (!current) return extra.reply('*NSFW filter is already OFF* — adult links are blocked.');
        database.updateGroupSettings(extra.from, { nsfw: false });
        return extra.reply(
          '🔞 *NSFW filter turned OFF*\n\nAdult-content links will now be deleted. ' +
          'The bot must be an admin for removal to work.'
        );
      }

      return extra.reply('❌ Invalid option.\nUsage: .nsfw on|off|status');
    } catch (error) {
      console.error('[nsfw]', error.message);
      await extra.reply('❌ Could not update the NSFW setting.');
    }
  },
};
