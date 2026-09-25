/**
 * Note-Remind Command — save a note AND schedule a DM reminder in one step
 *
 *   .note-remind 30m Call mum
 *   .note-remind 2h Team standup notes #work
 *   .note-remind 1d Weekly review
 *
 * Time: 30s / 30m / 2h / 1d (a plain number means minutes). The note is
 * saved like any other; the reminder DMs you when due and survives restarts.
 */

const notes = require('../../utils/notes');
const db = require('../../database');

module.exports = {
    name: 'note-remind',
    aliases: ['noteremind', 'remind-note', 'diaryremind'],
    description: 'Save a note and get a DM reminder (e.g. .note-remind 30m Call mum)',
    category: 'notes',

    async execute(sock, m, args, extra) {
        const jid = m.key.remoteJid;
        const prefix = db.getBotSetting('prefix') || '.';

        try {
            const ms = notes.parseTimeSpec(args[0]);
            const text = args.slice(1).join(' ').trim();

            if (!ms || !text) {
                return sock.sendMessage(jid, {
                    text:
                        `┏━━『 ⏰ NOTE-REMIND 』━━\n` +
                        `➥ Usage   ➜ ${prefix}note-remind <time> <note>\n` +
                        `➥ Time    ➜ 30s · 30m · 2h · 1d (plain number = minutes)\n` +
                        `➥ Example ➜ ${prefix}note-remind 30m Call mum #family\n` +
                        `➥ On an existing note ➜ ${prefix}mynotes remind <num> <time>\n` +
                        `┗━━━━━━━━━━━━━━━━`
                }, { quoted: m });
            }

            if (text.length > notes.MAX_TEXT) {
                return sock.sendMessage(jid, { text: `❌ Note too long (max ${notes.MAX_TEXT} characters).` }, { quoted: m });
            }

            const userId = notes.getUserId(m);
            const existing = notes.loadNotes(userId);
            if (existing.length >= notes.MAX_NOTES) {
                return sock.sendMessage(jid, { text: `❌ You already have ${notes.MAX_NOTES} notes. Delete some first via *${prefix}mynotes*.` }, { quoted: m });
            }

            const note = { id: notes.newId(), type: 'text', text, tags: notes.parseTags(text), savedAt: Date.now() };
            existing.push(note);
            notes.saveNotes(userId, existing);

            const reminder = notes.addReminder({
                userId,
                userJid: `${userId}@s.whatsapp.net`,
                noteId: note.id,
                dueAt: Date.now() + ms,
                noteRef: note,
            });

            await sock.sendMessage(jid, { react: { text: '⏰', key: m.key } });
            return sock.sendMessage(jid, {
                text:
                    `┏━━『 ⏰ NOTE + REMINDER SET 』━━\n` +
                    `➥ Note #   ➜ ${existing.length}\n` +
                    `➥ Text     ➜ ${note.text}\n` +
                    (note.tags.length ? `➥ Tags     ➜ ${note.tags.join(' ')}\n` : '') +
                    `➥ I'll DM you in ➜ ${notes.describeDueAt(reminder.dueAt)}\n` +
                    `➥ View     ➜ ${prefix}mynotes\n` +
                    `┗━━━━━━━━━━━━━━━━`
            }, { quoted: m });
        } catch (err) {
            console.error('❌ [NOTE-REMIND] Error:', err.message);
            return sock.sendMessage(jid, { text: `❌ Failed to set reminder: ${err.message}` }, { quoted: m });
        }
    },
};
