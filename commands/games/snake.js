/**
 * .snake — live Snake mini-app on the in-chat canvas (same channel as .tetris).
 * June skinned: dark card, green neon. Start on first control tap; swipe the
 * board or use the buttons / arrow keys. Session best score per card.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const APP_HTML = fs.readFileSync(path.join(__dirname, 'snake-app.html'), 'utf8');

module.exports = {
    name: 'snake',
    aliases: ['worm'],
    category: 'games',
    description: 'Play a live Snake canvas mini-app (renders inside WhatsApp)',
    usage: '.snake',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            await sendRichApp(sock, msg, APP_HTML, chatId);
        } catch (error) {
            console.error('[Snake] mini-app unavailable:', error.message);
            await sock.sendMessage(chatId, { text: RICH_FALLBACK('SNAKE') }, { quoted: msg }).catch(() => {});
        }
    }
};
