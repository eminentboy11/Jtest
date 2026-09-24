/**
 * Rich mini-app sender — the proven Tetris channel (WhatsApp GenAI unified
 * response HTML primitive) extracted so other commands can reuse it.
 *
 * sendRichApp(sock, msg, html) wraps a self-contained HTML page in the
 * botForwardedMessage/richResponseMessage envelope and relays it. Callers
 * handle their own fallback text on failure (relay errors THROW here; the
 * "client can't render" case is undetectable bot-side — the send succeeds).
 */
'use strict';

const { randomUUID } = require('crypto');
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');

function buildRichMessage(jid, html) {
    const data = Buffer.from(JSON.stringify({
        __typename: 'GenAIUnifiedResponse',
        response_id: randomUUID(),
        sections: [{
            __typename: 'GenAIUnifiedResponseSection',
            view_model: {
                __typename: 'GenAISingleLayoutViewModel',
                primitive: {
                    __typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
                    trusted_sources: [],
                    payload: String(html).trim(),
                },
            },
        }],
    })).toString('base64');

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

/**
 * Relay a mini-app to the given chat. Retries once on the alt jid for
 * LID chats. Resolves true on success; THROWS on failure.
 */
async function sendRichApp(sock, msg, html, chatId) {
    const target = chatId || msg.key.remoteJid;
    let jid = target;
    let built = buildRichMessage(jid, html);
    try {
        await sock.relayMessage(jid, built.message, { messageId: built.key.id });
        return true;
    } catch (relayError) {
        const alt = msg.key.remoteJidAlt;
        if (!alt || alt === jid) throw relayError;
        jid = alt;
        built = buildRichMessage(jid, html);
        await sock.relayMessage(jid, built.message, { messageId: built.key.id });
        return true;
    }
}

/** Boxed notice for clients that cannot render the primitive. */
const RICH_FALLBACK = (title) =>
    `╭─❏ 「 ${title} 」\n` +
    '│ This mini-app could not render on this client.\n' +
    '╰───────────────';

module.exports = { buildRichMessage, sendRichApp, RICH_FALLBACK };
