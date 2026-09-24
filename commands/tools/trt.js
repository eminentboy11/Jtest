const APIs = require('../../utils/api');

module.exports = {
    name: 'translate',
    aliases: ['tr', 'trans'],  // 'trans' carried over from the retired general/translate.js
    category: 'tools',
    description: 'Translate text',
    usage: '.translate <lang_code> <text>',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from;
        if (args.length < 2) {
            return await sock.sendMessage(chatId, {
                text: 'Usage: .translate <lang_code> <text>\nExample: .translate es Hello there'
            }, { quoted: msg });
        }

        const to = args[0];
        const text = args.slice(1).join(' ');

        try {
            const { translation } = await APIs.translate(text, to);
            await sock.sendMessage(chatId, { text: translation }, { quoted: msg });
        } catch (error) {
            console.error('[translate]', error.message);
            await sock.sendMessage(chatId, { text: '❌ Translation failed.' }, { quoted: msg });
        }
    }
};
