/**
 * MyNotes Command — view and manage your saved notes
 *
 *   .mynotes                    → list (page 1) — icons, timestamps, tags
 *   .mynotes 2                  → page 2 (15 per page)
 *   .mynotes find <word>        → search text, captions, filenames, tags
 *   .mynotes #tag               → filter by tag
 *   .mynotes get <num>          → re-send a media note
 *   .mynotes edit <num> <text>  → edit a note's text/caption
 *   .mynotes remind <num> <time>→ DM me when this note is due (30m / 2h / 1d)
 *   .mynotes del <num>          → delete one
 *   .mynotes clear              → delete all
 *   .mynotes export             → all notes as a .txt file
 *   .mydiary                    → same command, warmer name
 */

const notes = require('../../utils/notes');
const db = require('../../database');

module.exports = {
    name: 'mynotes',
    aliases: ['notes', 'listnotes', 'shownotes', 'mydiary'],
    description: 'View and manage your saved notes',
    category: 'notes',

    async execute(sock, m, args, extra) {
        const jid = m.key.remoteJid;
        const prefix = db.getBotSetting('prefix') || '.';
        const userId = notes.getUserId(m);
        const all = notes.loadNotes(userId);
        const sub = (args[0] || '').toLowerCase();

        const fail = (text) => sock.sendMessage(jid, { text }, { quoted: m });
        const usage =
            `➥ List      ➜ ${prefix}mynotes [page]\n` +
            `➥ Search    ➜ ${prefix}mynotes find <word> · Tag ➜ ${prefix}mynotes #tag\n` +
            `➥ Media     ➜ ${prefix}mynotes get <num>\n` +
            `➥ Edit      ➜ ${prefix}mynotes edit <num> <text>\n` +
            `➥ Remind    ➜ ${prefix}mynotes remind <num> <30m|2h|1d>\n` +
            `➥ Delete    ➜ ${prefix}mynotes del <num> · Clear ➜ ${prefix}mynotes clear\n` +
            `➥ Export    ➜ ${prefix}mynotes export`;

        try {
            // ── Search ─────────────────────────────────────────────────────
            if (sub === 'find' || sub === 'search') {
                const word = args.slice(1).join(' ').trim();
                if (!word) return fail(`🔍 *Usage:* ${prefix}mynotes find <word>`);
                const hits = all.map((n, i) => ({ n, i: i + 1 })).filter((x) => notes.matchesQuery(x.n, word));
                if (!hits.length) return fail(`🔍 No notes match *${word}*.`);
                return sock.sendMessage(jid, {
                    text: `┏━━『 🔍 FOUND ${hits.length} 』━━\n` +
                        hits.slice(0, 25).map((x) => notes.renderLine(x.n, x.i)).join('\n') +
                        (hits.length > 25 ? `\n➥ …and ${hits.length - 25} more` : '') +
                        `\n┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Tag filter ─────────────────────────────────────────────────
            if (sub.startsWith('#')) {
                const hits = all.map((n, i) => ({ n, i: i + 1 })).filter((x) => notes.matchesTag(x.n, sub));
                if (!hits.length) return fail(`🏷️ No notes with *${sub}*.`);
                return sock.sendMessage(jid, {
                    text: `┏━━『 🏷️ ${sub} · ${hits.length} NOTE(S) 』━━\n` +
                        hits.map((x) => notes.renderLine(x.n, x.i)).join('\n') +
                        `\n┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Get (media playback) ───────────────────────────────────────
            if (sub === 'get') {
                const idx = parseInt(args[1], 10);
                if (!idx || idx < 1 || idx > all.length) return fail(`❌ Invalid number.\n*Usage:* ${prefix}mynotes get <num>`);
                const note = all[idx - 1];
                if (!note.type || note.type === 'text') {
                    return fail(`📝 Note *${idx}* is a text note:\n\n${notes.noteText(note)}`);
                }
                const buffer = notes.getMedia(userId, note);
                if (!buffer) {
                    return fail(`⚠️ The media for note *${idx}* is no longer available (host redeploy may have wiped it). The text notes always survive.`);
                }
                await notes.sendMediaByKind(sock, jid, note, buffer);
                return sock.sendMessage(jid, { text: `📄 Note *${idx}*${note.caption ? ` — ${note.caption}` : ''}` }, { quoted: m });
            }

            // ── Edit ───────────────────────────────────────────────────────
            if (sub === 'edit') {
                const idx = parseInt(args[1], 10);
                const text = args.slice(2).join(' ').trim();
                if (!idx || idx < 1 || idx > all.length || !text) {
                    return fail(`✏️ *Usage:* ${prefix}mynotes edit <num> <new text>`);
                }
                if (text.length > notes.MAX_TEXT) return fail(`❌ Too long (max ${notes.MAX_TEXT} characters).`);
                const note = all[idx - 1];
                if (note.type === 'text') note.text = text; else note.caption = text;
                note.tags = notes.parseTags(text);
                notes.saveNotes(userId, all);
                await sock.sendMessage(jid, { react: { text: '✏️', key: m.key } });
                return sock.sendMessage(jid, {
                    text: `┏━━『 ✏️ NOTE EDITED 』━━\n` +
                        `➥ Note    ➜ ${idx}\n` +
                        `➥ New text ➜ ${text}\n` +
                        (note.tags.length ? `➥ Tags    ➜ ${note.tags.join(' ')}\n` : '') +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Remind ─────────────────────────────────────────────────────
            if (sub === 'remind') {
                const idx = parseInt(args[1], 10);
                const ms = notes.parseTimeSpec(args[2]);
                if (!idx || idx < 1 || idx > all.length || !ms) {
                    return fail(`⏰ *Usage:* ${prefix}mynotes remind <num> <30m|2h|1d>`);
                }
                const note = all[idx - 1];
                const reminder = notes.addReminder({
                    userId,
                    userJid: `${userId}@s.whatsapp.net`,
                    noteId: note.id,
                    dueAt: Date.now() + ms,
                    noteRef: note,
                });
                return sock.sendMessage(jid, {
                    text: `┏━━『 ⏰ REMINDER SET 』━━\n` +
                        `➥ Note   ➜ ${idx} · ${notes.noteIcon(note)} ${notes.noteText(note) || '(media note)'}\n` +
                        `➥ I'll DM you in ➜ ${notes.describeDueAt(reminder.dueAt)}\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Delete one ─────────────────────────────────────────────────
            if (sub === 'del' || sub === 'delete' || sub === 'rm') {
                const idx = parseInt(args[1], 10);
                if (!idx || idx < 1 || idx > all.length) {
                    return fail(`❌ Invalid number.\n*Usage:* ${prefix}mynotes del <number>`);
                }
                const removed = all.splice(idx - 1, 1)[0];
                notes.deleteMedia(userId, removed);
                notes.saveNotes(userId, all);
                await sock.sendMessage(jid, { react: { text: '🗑️', key: m.key } });
                return sock.sendMessage(jid, {
                    text:
                        `┏━━『 🗑️ NOTE DELETED 』━━\n` +
                        `➥ Note      ➜ ${notes.noteIcon(removed)} ${notes.noteText(removed) || `(${removed.type})`}\n` +
                        `➥ Remaining ➜ ${all.length}\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Clear all ──────────────────────────────────────────────────
            if (sub === 'clear' || sub === 'clearall' || sub === 'wipe') {
                if (!all.length) return fail('📝 You have no notes to clear.');
                const count = all.length;
                notes.deleteAllMedia(userId);
                notes.saveNotes(userId, []);
                await sock.sendMessage(jid, { react: { text: '🧹', key: m.key } });
                return sock.sendMessage(jid, {
                    text: `┏━━『 🧹 NOTES CLEARED 』━━\n➥ Removed ➜ ${count} notes\n┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            // ── Export ─────────────────────────────────────────────────────
            if (sub === 'export') {
                if (!all.length) return fail('📝 You have no notes to export.');
                const text = notes.buildExportText(userId, all);
                return sock.sendMessage(jid, {
                    document: Buffer.from(text, 'utf8'),
                    mimetype: 'text/plain',
                    fileName: 'my-notes.txt',
                    caption: `📝 ${all.length} note(s) exported`,
                }, { quoted: m });
            }

            // ── List (with optional page number) ───────────────────────────
            if (!all.length) {
                return sock.sendMessage(jid, {
                    text:
                        `┏━━『 📝 MY NOTES 』━━\n` +
                        `➥ You have no saved notes.\n` +
                        `➥ Add one ➜ ${prefix}addnote <text> (or send media with a caption)\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            const page = parseInt(args[0], 10) || 1;
            const { slice, page: p, pages, total } = notes.paginate(all, page);
            const start = (p - 1) * notes.PAGE_SIZE;
            const mediaCount = all.filter((n) => n.type && n.type !== 'text').length;
            return sock.sendMessage(jid, {
                text:
                    `┏━━『 📝 MY NOTES 』━━\n` +
                    `➥ Total ➜ ${total}${mediaCount ? ` (${mediaCount} media)` : ''} · Page ${p}/${pages}\n` +
                    slice.map((n, i) => notes.renderLine(n, start + i + 1)).join('\n') + '\n' +
                    `➥ ${usage}\n` +
                    `┗━━━━━━━━━━━━━━━━`
            }, { quoted: m });
        } catch (err) {
            console.error('❌ [MYNOTES] Error:', err.message);
            return fail(`❌ Failed to load notes: ${err.message}`);
        }
    },
};
