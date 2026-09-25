const database = require('../../database');
/**
 * Owner Command - Sends bot owner's contact card (vCard)
 */


module.exports = {
    name: 'owner',
    aliases: ['creator', 'dev', 'botowner'],
    category: 'general',
    description: 'Show bot owner contact information',
    usage: '.owner',
    ownerOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const chatId = extra.from;

            // Owner numbers array -> convert each to a vCard
            const ownerNames = Array.isArray(database.getOwnerNames()) ? database.getOwnerNames() : [database.getOwnerNames()];
            // Sending a contacts message with zero vCards makes Baileys throw
            // "require atleast 1 contact". Can happen before the paired
            // account is claimed at connection.open.
            if (!database.getOwners().length) {
                return extra.reply(
                    '👑 *No owner is set yet.*\n\n' +
                    'The paired account is claimed automatically when the bot connects.\n' +
                    'If this persists, set one with:\n_.setownernumber <number>_'
                );
            }

            const vCards = database.getOwners().map((num, index) => {
                const name = ownerNames[index] || ownerNames[0] || 'Bot Owner';
                return {
                    vcard: `
BEGIN:VCARD
VERSION:3.0
FN:${name}
TEL;waid=${num}:${num}
END:VCARD
                    `.trim()
                };
            });

            const displayName = ownerNames[0] || database.getOwnerNames() || 'Bot Owner';

            await sock.sendMessage(chatId, {
                contacts: {
                    displayName: displayName,
                    contacts: vCards
                }
            });

            await extra.reply('👑 Here is the contact of my *Owner*.');

        } catch (error) {
            console.error('Owner command error:', error);
            await extra.reply(`❌ Error: ${error.message}`);
        }
    }
};
