/**
 * .tod — Truth or Dare wheel (TEST VERSION) on the in-chat mini-app channel.
 * Spin the wheel → lands on 💙 Truth or 💗 Dare → shows a random prompt.
 * Beautiful purple/pink carnival palette. Text versions (.dare/.truth) are
 * untouched — if this test version is approved we retire those.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const APP_HTML = fs.readFileSync(path.join(__dirname, 'tod-app.html'), 'utf8');

module.exports = {
    name: 'tod',
    aliases: ['truthordare', 'spin'],
    category: 'games',
    description: 'TEST: Truth or Dare wheel — mini-app version (render in chat)',
    usage: '.tod',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            await sendRichApp(sock, msg, APP_HTML, chatId);
        } catch (error) {
            console.error('[ToD] mini-app unavailable:', error.message);
            await sock.sendMessage(chatId, { text: RICH_FALLBACK('TRUTH OR DARE') }, { quoted: msg }).catch(() => {});
        }
    }
};
