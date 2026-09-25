/**
 * AddNote Command — save a personal note (text OR media)
 *
 *   .addnote <text>              → text note (supports #tags)
 *   .addnote <caption> + media   → attach/reply with an image, voice note,
 *                                  video, audio, document or sticker
 *   .diary                       → same command, warmer name
 *
 * Media notes are stored twice: a local cache file for fast playback AND a
 * base64 copy in the mirrored KV store, so they survive ephemeral redeploys.
 */

const { normalizeMessageContent, downloadMediaMessage } = require('@whiskeysockets/baileys');
const notes = require('../../utils/notes');
const db = require('../../database');

const WA_MEDIA_TYPES = {
    imageMessage: 'image',
    videoMessage: 'video',
    documentMessage: 'document',
    stickerMessage: 'sticker',
};

/** Find media content on this message or the quoted message. */
function extractMedia(msg) {
    const scan = (content, mediaMsg) => {
        if (!content) return null;
        for (const [waType, kind] of Object.entries(WA_MEDIA_TYPES)) {
            if (content[waType]) return { kind, node: content[waType], mediaMsg };
        }
        if (content.audioMessage) {
            return { kind: content.audioMessage.ptt ? 'voice' : 'audio', node: content.audioMessage, mediaMsg };
        }
        return null;
    };

    const content = normalizeMessageContent(msg.message);
    const direct = scan(content, msg);
    if (direct) return direct;

    // Reply flow: the quoted message carries the media
    const ctx = content?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;
    if (quoted) {
        const quotedContent = normalizeMessageContent({ __x: quoted }.__x ? quoted : { conversation: '' }) || quoted;
        const found = scan(quoted, {
            key: {
                remoteJid: msg.key.remoteJid,
                id: ctx.stanzaId,
                participant: ctx.participant,
                fromMe: !ctx.participant,
            },
            message: quoted,
        });
        if (found) return found;
    }
    return null;
}

module.exports = {
    name: 'addnote',
    aliases: ['savenote', 'newnote', 'diary'],
    description: 'Save a personal note (text or media, supports #tags)',
    category: 'notes',

    async execute(sock, m, args, extra) {
        const jid = m.key.remoteJid;
        const prefix = db.getBotSetting('prefix') || '.';
        const caption = (args || []).join(' ').trim();

        try {
            const media = extractMedia(m);

            // ── Media note ────────────────────────────────────────────────
            if (media) {
                if (caption.length > notes.MAX_TEXT) {
                    return sock.sendMessage(jid, { text: `❌ Caption too long (max ${notes.MAX_TEXT} characters).` }, { quoted: m });
                }
                const buffer = await downloadMediaMessage(media.mediaMsg, 'buffer', {});
                if (!buffer || buffer.length === 0) {
                    return sock.sendMessage(jid, { text: '❌ Could not download the media — try again.' }, { quoted: m });
                }
                const userId = notes.getUserId(m);
                const result = notes.saveMediaNote({
                    userId,
                    buffer,
                    kind: media.kind,
                    mime: media.node?.mimetype,
                    filename: media.node?.fileName,
                    caption,
                });
                if (result.error) {
                    return sock.sendMessage(jid, { text: `❌ ${result.error}` }, { quoted: m });
                }
                await sock.sendMessage(jid, { react: { text: notes.KIND_META[media.kind].icon, key: m.key } });
                return sock.sendMessage(jid, {
                    text:
                        `┏━━『 ✅ ${notes.KIND_META[media.kind].label.toUpperCase()} NOTE SAVED 』━━\n` +
                        `➥ Note #     ➜ ${result.index}\n` +
                        `➥ Type       ➜ ${notes.KIND_META[media.kind].icon} ${notes.KIND_META[media.kind].label} (${(buffer.length / 1048576).toFixed(2)}MB)\n` +
                        (caption ? `➥ Caption    ➜ ${caption}\n` : '') +
                        (result.note.tags.length ? `➥ Tags       ➜ ${result.note.tags.join(' ')}\n` : '') +
                        `➥ Total Notes ➜ ${result.index}\n` +
                        `➥ View All   ➜ ${prefix}mynotes · Get ➜ ${prefix}mynotes get ${result.index}\n` +
                        `➥ Powered By ➜ ${db.getBotSetting('botName')}\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Text note ─────────────────────────────────────────────────
            if (!caption) {
                return sock.sendMessage(jid, {
                    text:
                        `┏━━『 📝 ADDNOTE 』━━\n` +
                        `➥ Usage      ➜ ${prefix}addnote <your note>\n` +
                        `➥ Example    ➜ ${prefix}addnote I will come tomorrow #plans\n` +
                        `➥ Media      ➜ send/reply media with caption ${prefix}addnote <caption>\n` +
                        `➥ View       ➜ ${prefix}mynotes\n` +
                        `➥ Powered By ➜ ${db.getBotSetting('botName')}\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            if (caption.length > notes.MAX_TEXT) {
                return sock.sendMessage(jid, { text: `❌ Note too long (max ${notes.MAX_TEXT} characters).` }, { quoted: m });
            }

            const userId = notes.getUserId(m);
            const existing = notes.loadNotes(userId);
            if (existing.length >= notes.MAX_NOTES) {
                return sock.sendMessage(jid, { text: `❌ You already have ${notes.MAX_NOTES} notes. Delete some via *${prefix}mynotes* before adding more.` }, { quoted: m });
            }

            const note = { id: notes.newId(), type: 'text', text: caption, tags: notes.parseTags(caption), savedAt: Date.now() };
            existing.push(note);
            notes.saveNotes(userId, existing);

            await sock.sendMessage(jid, { react: { text: '📝', key: m.key } });
            return sock.sendMessage(jid, {
                text:
                    `┏━━『 ✅ NOTE SAVED 』━━\n` +
                    `➥ Note #     ➜ ${existing.length}\n` +
                    `➥ Text       ➜ ${note.text}\n` +
                    (note.tags.length ? `➥ Tags       ➜ ${note.tags.join(' ')}\n` : '') +
                    `➥ Total Notes ➜ ${existing.length}\n` +
                    `➥ View All   ➜ ${prefix}mynotes\n` +
                    `➥ Powered By ➜ ${db.getBotSetting('botName')}\n` +
                    `┗━━━━━━━━━━━━━━━━`
            }, { quoted: m });
        } catch (err) {
            console.error('❌ [ADDNOTE] Error:', err.message);
            return sock.sendMessage(jid, { text: `❌ Failed to save note: ${err.message}` }, { quoted: m });
        }
    },
};
