'use strict';

/**
 * Notes backend — shared by .addnote / .mynotes / .note-remind.
 *
 * Text notes live in the existing 'user_notes' KV namespace (fully backward
 * compatible with notes saved by the previous release).
 *
 * Media notes (option 3 — full mirroring): the bytes are stored BOTH as a
 * local cache file (data/notes/<user>/<id>.<ext>, fast playback) AND as a
 * base64 copy in the 'user_notes_media' KV namespace — which mirrors to the
 * June DB through the existing kv_store resource and restores on boot. Media
 * therefore survives ephemeral redeploys (Render free etc.).
 *
 * Size cap rationale: the June DB API accepts request bodies up to 8MB;
 * base64 inflates by 4/3 plus JSON wrapper → 5MB media is the safe ceiling.
 *
 * Reminders: 'note_reminders' KV + an in-process scheduler (pinger pattern):
 * persisted, rescanned every 30s, DM the user when due. Survives restarts.
 */

const fs = require('fs');
const path = require('path');

const NOTES_NS = 'user_notes';
const MEDIA_NS = 'user_notes_media';
const REMINDERS_NS = 'note_reminders';
const REMINDERS_KEY = 'pending';

const MAX_NOTES = 100;                    // total notes per user (text + media)
const MAX_TEXT = 1000;                    // characters per text note / caption
const MAX_MEDIA_NOTES = 20;               // media notes per user
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;  // 5MB (June DB body limit is 8MB)
const PAGE_SIZE = 15;

const KIND_META = {
    image: { icon: '🖼️', label: 'Image' },
    sticker: { icon: '🌟', label: 'Sticker' },
    video: { icon: '🎬', label: 'Video' },
    voice: { icon: '🎤', label: 'Voice note' },
    audio: { icon: '🎵', label: 'Audio' },
    document: { icon: '📄', label: 'Document' },
};

const state = {
    db: null,      // injectable database module (tests)
    sock: null,    // current socket for reminder DMs
    timer: null,   // reminder scanner
};

function db() {
    if (state.db) return state.db;
    return require(path.join(global.__CORE__ || process.cwd(), 'database'));
}

function mediaDir() {
    return process.env.JUNE_NOTES_DIR
        ? path.resolve(process.env.JUNE_NOTES_DIR)
        : path.join(process.cwd(), 'data', 'notes');
}

// ─── Identity + notes CRUD ───────────────────────────────────────────────────

function getUserId(m) {
    const jid = (m && m.key && (m.key.participant || m.key.remoteJid)) || '';
    return String(jid).split(':')[0].split('@')[0];
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadNotes(userId) {
    const notes = db().getKV(NOTES_NS, userId, []);
    return Array.isArray(notes) ? notes.filter(Boolean) : [];
}

function saveNotes(userId, notes) {
    db().setKV(NOTES_NS, userId, notes);
}

// ─── Tags + time (pure, exported for tests) ─────────────────────────────────

function parseTags(text) {
    const tags = String(text || '').match(/#[a-zA-Z0-9_-]{1,24}/g) || [];
    return [...new Set(tags.map((t) => t.toLowerCase()))];
}

function fmtTimestamp(ts) {
    try {
        return new Date(ts).toLocaleString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        });
    } catch (_) {
        return '';
    }
}

/** Parse '30m' / '2h' / '1d' / '45' (minutes) / '90s' → ms, or null. */
function parseTimeSpec(spec) {
    const m = String(spec || '').trim().match(/^(\d{1,4})(s|m|h|d)?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = (m[2] || 'm').toLowerCase();
    const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
    return n * ms;
}

function describeDueAt(dueAt) {
    const ms = dueAt - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hr`;
    return `${Math.round(hours / 24)} days`;
}

// ─── Media storage ───────────────────────────────────────────────────────────

function mediaFile(userId, note, ext) {
    return path.join(mediaDir(), String(userId), `${note.id}.${ext || 'bin'}`);
}

/** Save a media note: local cache file + mirrored KV copy + metadata row. */
function saveMediaNote({ userId, buffer, kind, mime, filename, caption, savedAt = Date.now() }) {
    if (!KIND_META[kind]) return { error: `Unsupported media type: ${kind}` };
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { error: 'Empty media' };
    if (buffer.length > MAX_MEDIA_BYTES) {
        return { error: `Media too large (${(buffer.length / 1048576).toFixed(1)}MB) — the limit is ${MAX_MEDIA_BYTES / 1048576}MB per media note` };
    }
    const notes = loadNotes(userId);
    if (notes.length >= MAX_NOTES) return { error: `You already have ${MAX_NOTES} notes. Delete some via .mynotes first.` };
    if (notes.filter((n) => n.type && n.type !== 'text').length >= MAX_MEDIA_NOTES) {
        return { error: `You already have ${MAX_MEDIA_NOTES} media notes. Delete some via .mynotes first.` };
    }

    const note = {
        id: newId(),
        type: kind,
        mime: mime || 'application/octet-stream',
        filename: filename || null,
        caption: String(caption || '').slice(0, MAX_TEXT) || null,
        size: buffer.length,
        tags: parseTags(caption || ''),
        savedAt,
    };

    // Local cache file (fast playback)
    try {
        fs.mkdirSync(path.join(mediaDir(), String(userId)), { recursive: true });
        fs.writeFileSync(mediaFile(userId, note, extFor(note)), buffer);
    } catch (_) { /* KV copy below is the durable one */ }

    // Mirrored KV copy (survives ephemeral redeploys)
    try {
        db().setKV(MEDIA_NS, `${userId}:${note.id}`, {
            kind, mime: note.mime, filename: note.filename, b64: buffer.toString('base64'),
        });
    } catch (_) { /* local file still works; mirroring is best-effort */ }

    notes.push(note);
    saveNotes(userId, notes);
    return { note, index: notes.length };
}

function extFor(note) {
    const mime = String(note.mime || '');
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
        'application/pdf': 'pdf',
    };
    if (map[mime]) return map[mime];
    if (note.filename && /\.[a-zA-Z0-9]{1,8}$/.test(note.filename)) return note.filename.split('.').pop();
    return 'bin';
}

/**
 * Get media bytes: local cache first; if the file is gone (ephemeral host),
 * recover from the mirrored KV copy and re-cache to disk. null = lost.
 */
function getMedia(userId, note) {
    if (!note || note.type === 'text' || !note.id) return null;
    const file = mediaFile(userId, note, extFor(note));
    try {
        if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch (_) { /* fall through to KV */ }
    try {
        const row = db().getKV(MEDIA_NS, `${userId}:${note.id}`, null);
        if (row && row.b64) {
            const buffer = Buffer.from(row.b64, 'base64');
            try {
                fs.mkdirSync(path.join(mediaDir(), String(userId)), { recursive: true });
                fs.writeFileSync(file, buffer); // re-cache
            } catch (_) { /* cache is optional */ }
            return buffer;
        }
    } catch (_) { /* gone */ }
    return null;
}

function deleteMedia(userId, note) {
    if (!note || note.type === 'text' || !note.id) return;
    try { if (fs.existsSync(mediaFile(userId, note, extFor(note)))) fs.rmSync(mediaFile(userId, note, extFor(note)), { force: true }); } catch (_) {}
    try { db().delKV(MEDIA_NS, `${userId}:${note.id}`); } catch (_) {}
}

/** Delete every media file + KV copy belonging to a user's notes. */
function deleteAllMedia(userId) {
    for (const note of loadNotes(userId)) deleteMedia(userId, note);
}

// ─── Listing helpers (pure, exported for tests) ─────────────────────────────

function noteIcon(note) {
    return (note.type && note.type !== 'text' && KIND_META[note.type]) ? KIND_META[note.type].icon : '📝';
}

function noteText(note) {
    // Legacy notes (pre-media release) have no type field — they are text.
    const isText = !note.type || note.type === 'text';
    return isText ? note.text : (note.caption || '');
}

function matchesQuery(note, word) {
    const w = String(word || '').toLowerCase();
    if (!w) return false;
    return noteText(note).toLowerCase().includes(w)
        || (note.filename || '').toLowerCase().includes(w)
        || (note.tags || []).some((t) => t.includes(w));
}

function matchesTag(note, tag) {
    const t = String(tag || '').toLowerCase();
    return (note.tags || []).includes(t);
}

function paginate(notes, page) {
    const total = notes.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(Math.max(1, page || 1), pages);
    return { slice: notes.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), page: p, pages, total };
}

function renderLine(note, index) {
    const ts = note.savedAt ? fmtTimestamp(note.savedAt) : '';
    const tags = (note.tags && note.tags.length) ? ` ${note.tags.join(' ')}` : '';
    const media = note.type && note.type !== 'text'
        ? ` _(${KIND_META[note.type].label}${note.filename ? `: ${note.filename}` : ''})_` : '';
    return `➥ *${index}.* ${noteIcon(note)} ${noteText(note) || ''}${media}${ts ? `  _[${ts}]_` : ''}${tags}`;
}

function buildExportText(userId, notes) {
    const lines = [`📝 Notes export — ${notes.length} note(s)`, `👤 User ${userId}`, `📅 ${fmtTimestamp(Date.now())}`, ''];
    notes.forEach((note, i) => {
        const media = note.type && note.type !== 'text'
            ? `[${KIND_META[note.type].label}${note.filename ? `: ${note.filename}` : ''}] ` : '';
        lines.push(`${i + 1}. ${media}${noteText(note)}${note.savedAt ? `  (${fmtTimestamp(note.savedAt)})` : ''}`);
    });
    return lines.join('\n');
}

// ─── Reminders ───────────────────────────────────────────────────────────────

function loadReminders() {
    const list = db().getKV(REMINDERS_NS, REMINDERS_KEY, []);
    return Array.isArray(list) ? list.filter(Boolean) : [];
}

function saveReminders(list) {
    db().setKV(REMINDERS_NS, REMINDERS_KEY, list);
}

function addReminder({ userId, userJid, noteId, dueAt, noteRef }) {
    const list = loadReminders();
    const reminder = {
        id: newId(), userId, userJid: userJid || `${userId}@s.whatsapp.net`,
        noteId, dueAt, createdAt: Date.now(),
        // Denormalized snapshot so the DM works even if the note is deleted later
        text: noteRef ? noteText(noteRef) : '',
        type: noteRef ? noteRef.type : 'text',
    };
    list.push(reminder);
    saveReminders(list);
    ensureTimer();
    return reminder;
}

function cancelReminder(reminderId) {
    const list = loadReminders();
    const next = list.filter((r) => r.id !== reminderId);
    saveReminders(next);
    return next.length !== list.length;
}

async function scanReminders() {
    const now = Date.now();
    const list = loadReminders();
    const due = list.filter((r) => r.dueAt <= now);
    if (!due.length) return 0;
    saveReminders(list.filter((r) => r.dueAt > now));
    for (const r of due) {
        try {
            const notes = loadNotes(r.userId);
            const note = notes.find((n) => n.id === r.noteId);
            const text = note ? noteText(note) : r.text;
            const label = note && note.type && note.type !== 'text' ? KIND_META[note.type].label : null;
            let message = `⏰ *Note reminder*\n\n${noteIcon(note || r)} ${text || '(empty note)'}`;
            if (label) message += `\n\n_${label} attached below._`;
            if (state.sock) {
                await state.sock.sendMessage(r.userJid, { text: message });
                if (note && note.type && note.type !== 'text') {
                    const buffer = getMedia(r.userId, note);
                    if (buffer) await sendMediaByKind(state.sock, r.userJid, note, buffer);
                }
            }
        } catch (_) { /* one failed DM must never stop the others */ }
    }
    return due.length;
}

function sendMediaByKind(sock, jid, note, buffer) {
    const base = { caption: note.caption || undefined };
    switch (note.type) {
        case 'image': return sock.sendMessage(jid, { ...base, image: buffer, mimetype: note.mime });
        case 'sticker': return sock.sendMessage(jid, { sticker: buffer, mimetype: note.mime });
        case 'video': return sock.sendMessage(jid, { ...base, video: buffer, mimetype: note.mime, ptv: note.ptv || undefined });
        case 'voice': return sock.sendMessage(jid, { audio: buffer, ptt: true, mimetype: note.mime || 'audio/ogg; codecs=opus' });
        case 'audio': return sock.sendMessage(jid, { audio: buffer, mimetype: note.mime });
        default: return sock.sendMessage(jid, { document: buffer, mimetype: note.mime, fileName: note.filename || 'note' });
    }
}

function ensureTimer() {
    if (state.timer) return;
    state.timer = setInterval(() => { void scanReminders().catch(() => {}); }, 30 * 1000);
    if (global._activeIntervals) global._activeIntervals.push(state.timer);
}

/** index.js hook (pinger pattern): socket for reminder DMs + start scanner. */
function onBotConnected(sock) {
    if (sock) state.sock = sock;
    if (loadReminders().length) ensureTimer();
    return true;
}

module.exports = {
    // constants
    MAX_NOTES, MAX_TEXT, MAX_MEDIA_NOTES, MAX_MEDIA_BYTES, PAGE_SIZE, KIND_META,
    NOTES_NS, MEDIA_NS,
    // identity + notes
    getUserId, newId, loadNotes, saveNotes,
    // media
    saveMediaNote, getMedia, deleteMedia, deleteAllMedia, sendMediaByKind,
    // pure helpers
    parseTags, fmtTimestamp, parseTimeSpec, describeDueAt,
    noteIcon, noteText, matchesQuery, matchesTag, paginate, renderLine, buildExportText,
    // reminders
    addReminder, cancelReminder, scanReminders, onBotConnected,
    __test: { state, setDatabase: (m) => { state.db = m; }, reset: () => { if (state.timer) clearInterval(state.timer); state.timer = null; state.sock = null; state.db = null; } },
};
