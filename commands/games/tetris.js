/**
 * .tetris — live Tetris canvas mini-app.
 *
 * Restored from peace-amani/norah (commands/games/tetris.js) — that file was
 * string-obfuscated; this is the fully decoded, de-obfuscated port to June-X
 * Ultra's command shape (CommonJS + execute(sock, msg, args, extra)).
 *
 * HOW IT WORKS: the bot ships a small self-contained HTML5 Tetris game
 * (commands/games/tetris-app.html) inside WhatsApp's rich "GenAI unified
 * response" message primitive — the same in-chat canvas Meta AI uses. The
 * HTML is wrapped in a base64 JSON payload, sent as a botForwardedMessage /
 * richResponseMessage, and supported WhatsApp clients render it LIVE in the
 * chat: a playable Tetris with on-screen buttons + keyboard controls.
 *
 * On clients that cannot render the primitive (or if the relay fails), the
 * user gets the boxed "could not render" notice instead — same as norah.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');

const APP_HTML = fs.readFileSync(path.join(__dirname, 'tetris-app.html'), 'utf8');

const FALLBACK_TEXT =
    '╭─❏ 「 TETRIS 」\n' +
    '│ This mini-app could not render on this client.\n' +
    '╰───────────────';

/** Wrap the HTML app in WhatsApp's GenAI unified-response payload. */
function buildPayload(html) {
    return {
        __typename: 'GenAIUnifiedResponse',
        response_id: randomUUID(),
        sections: [
            {
                __typename: 'GenAIUnifiedResponseSection',
                view_model: {
                    __typename: 'GenAISingleLayoutViewModel',
                    primitive: {
                        __typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
                        trusted_sources: [],
                        payload: String(html).trim(),
                    },
                },
            },
        ],
    };
}

/** Build the relayable botForwardedMessage for one jid. */
function buildMessage(jid) {
    const data = Buffer.from(JSON.stringify(buildPayload(APP_HTML))).toString('base64');
    return generateWAMessageFromContent(
        jid,
        {
            botForwardedMessage: {
                message: {
                    richResponseMessage: {
                        messageType: 1,
                        unifiedResponse: { data },
                        contextInfo: { isForwarded: true, forwardOrigin: 4 },
                    },
                },
            },
        },
        {}
    );
}

module.exports = {
    name: 'tetris',
    aliases: ['blocks', 'brickgame'],
    category: 'games',
    description: 'Play a live Tetris canvas mini-app (renders inside WhatsApp)',
    usage: '.tetris',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            let jid = chatId;
            let built = buildMessage(jid);
            try {
                await sock.relayMessage(jid, built.message, { messageId: built.key.id });
            } catch (relayError) {
                // LID chats sometimes refuse the raw @lid jid — retry on the alt.
                const alt = msg.key.remoteJidAlt;
                if (!alt || alt === jid) throw relayError;
                jid = alt;
                built = buildMessage(jid);
                await sock.relayMessage(jid, built.message, { messageId: built.key.id });
            }
        } catch (error) {
            console.error('[Tetris] HTML app unavailable:', error.message);
            await sock.sendMessage(chatId, { text: FALLBACK_TEXT }, { quoted: msg }).catch(() => {});
        }
    }
};
