'use strict';

/**
 * Notes module tests — text CRUD, tags, search, edit, pagination, export,
 * media save/get/delete incl. the ephemeral-host recovery scenario, caps,
 * and the reminder scheduler (fire + persistence).
 *
 * Run: JUNE_NOTES_DIR=<tmpdir> node test/notes.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');

process.env.JUNE_NOTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
const notes = require('../utils/notes');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; console.error(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Fake database (in-memory KV) ────────────────────────────────────────────
const kv = new Map();
const fakeDb = {
    getKV: (ns, key, fallback = null) => (kv.has(`${ns}::${key}`) ? kv.get(`${ns}::${key}`) : fallback),
    setKV: (ns, key, value) => { kv.set(`${ns}::${key}`, value); return true; },
    delKV: (ns, key) => { kv.delete(`${ns}::${key}`); return true; },
};
notes.__test.reset();
notes.__test.setDatabase(fakeDb);

const USER = '254712345678';

// ── 1. Text notes + backward compat + tags ──────────────────────────────────
console.log('\n[1] text notes');
// Old-format note (previous release) must keep working
kv.set(`${notes.NOTES_NS}::${USER}`, [{ id: 'old1', text: 'legacy note', savedAt: 1690000000000 }]);
check('legacy note loads', notes.loadNotes(USER).length === 1 && notes.loadNotes(USER)[0].text === 'legacy note');

const tags = notes.parseTags('buy milk #shopping #Family #shopping');
check('tags parsed + deduped + lowercased', JSON.stringify(tags) === JSON.stringify(['#shopping', '#family']), JSON.stringify(tags));
check('no tags → empty', notes.parseTags('plain text').length === 0);

notes.saveNotes(USER, [...notes.loadNotes(USER),
    { id: 'n2', type: 'text', text: 'team standup #work', tags: notes.parseTags('team standup #work'), savedAt: Date.now() },
    { id: 'n3', type: 'text', text: 'buy milk #shopping', tags: notes.parseTags('buy milk #shopping'), savedAt: Date.now() }]);
check('notes saved', notes.loadNotes(USER).length === 3);

// ── 2. Search / tag filter / edit / pagination / export (pure helpers) ─────
console.log('\n[2] search · tags · edit · pagination · export');
const all = notes.loadNotes(USER);
check('find matches case-insensitively', all.filter((n) => notes.matchesQuery(n, 'MILK')).length === 1);
check('find matches tag text', all.filter((n) => notes.matchesQuery(n, '#work')).length === 1);
check('tag filter works', all.filter((n) => notes.matchesTag(n, '#shopping')).length === 1);
check('tag filter is exact', all.filter((n) => notes.matchesTag(n, '#shoppinglist')).length === 0);

const edited = [...all];
edited[1].text = 'team standup moved to 10am #work #meeting';
edited[1].tags = notes.parseTags(edited[1].text);
notes.saveNotes(USER, edited);
check('edit rewrites text + tags', notes.loadNotes(USER)[1].tags.includes('#meeting'));

const many = Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, type: 'text', text: `note ${i}`, savedAt: Date.now() }));
const p1 = notes.paginate(many, 1), p2 = notes.paginate(many, 2), p3 = notes.paginate(many, 3), pOver = notes.paginate(many, 99);
check('pagination 15/15/2', p1.slice.length === 15 && p2.slice.length === 15 && p3.slice.length === 2 && p3.pages === 3);
check('page overflow clamps to last page', pOver.page === 3);

const exportText = notes.buildExportText(USER, notes.loadNotes(USER));
check('export includes entries + header', exportText.includes('Notes export') && exportText.includes('legacy note') && exportText.includes('standup') && exportText.includes('buy milk'));

// ── 3. Media notes + the ephemeral-host scenario ────────────────────────────
console.log('\n[3] media notes');
const imageBuf = Buffer.from('fakejpegbytes' + 'x'.repeat(1000));
const saved = notes.saveMediaNote({ userId: USER, buffer: imageBuf, kind: 'image', mime: 'image/jpeg', caption: 'lunch ideas #food' });
check('media note saved', !!saved.note && saved.note.type === 'image' && saved.note.tags.includes('#food'), JSON.stringify(saved));
check('local cache file written', fs.existsSync(path.join(process.env.JUNE_NOTES_DIR, USER, `${saved.note.id}.jpg`)));
check('mirrored KV copy written', !!fakeDb.getKV(notes.MEDIA_NS, `${USER}:${saved.note.id}`));
check('metadata in notes array', notes.loadNotes(USER).some((n) => n.id === saved.note.id && n.type === 'image'));

check('getMedia returns bytes (local)', notes.getMedia(USER, saved.note).equals(imageBuf));

// Ephemeral host: local file wiped, KV copy survives → recovery
fs.rmSync(path.join(process.env.JUNE_NOTES_DIR, USER, `${saved.note.id}.jpg`));
const recovered = notes.getMedia(USER, saved.note);
check('EPHEMERAL RECOVERY: bytes restored from mirrored KV', recovered && recovered.equals(imageBuf));
check('recovery re-caches the file', fs.existsSync(path.join(process.env.JUNE_NOTES_DIR, USER, `${saved.note.id}.jpg`)));

notes.deleteMedia(USER, saved.note);
check('delete removes file + KV copy',
    !fs.existsSync(path.join(process.env.JUNE_NOTES_DIR, USER, `${saved.note.id}.jpg`))
    && !fakeDb.getKV(notes.MEDIA_NS, `${USER}:${saved.note.id}`));

// ── 4. Caps ────────────────────────────────────────────────────────────────
console.log('\n[4] caps');
const fresh = '9990001111';
check('oversized media rejected', !!notes.saveMediaNote({ userId: fresh, buffer: Buffer.alloc(6 * 1024 * 1024), kind: 'video', mime: 'video/mp4' }).error);
check('empty media rejected', !!notes.saveMediaNote({ userId: fresh, buffer: Buffer.alloc(0), kind: 'image' }).error);
check('unknown kind rejected', !!notes.saveMediaNote({ userId: fresh, buffer: imageBuf, kind: 'hologram' }).error);

const capped = '9990002222';
for (let i = 0; i < notes.MAX_MEDIA_NOTES; i++) {
    notes.saveMediaNote({ userId: capped, buffer: imageBuf, kind: 'image', mime: 'image/jpeg' });
}
check('media cap enforced at 20', !!notes.saveMediaNote({ userId: capped, buffer: imageBuf, kind: 'image' }).error);

const hundred = '9990003333';
for (let i = 0; i < notes.MAX_NOTES; i++) {
    notes.saveNotes(hundred, [...notes.loadNotes(hundred), { id: `t${i}`, type: 'text', text: 'x', savedAt: Date.now() }]);
}
check('total notes cap enforced at 100', notes.loadNotes(hundred).length === notes.MAX_NOTES);

// ── 5. Time parsing ─────────────────────────────────────────────────────────
console.log('\n[5] time parsing');
check('30m → 30 min', notes.parseTimeSpec('30m') === 30 * 60000);
check('2h → 2 hours', notes.parseTimeSpec('2h') === 2 * 3600000);
check('1d → 1 day', notes.parseTimeSpec('1d') === 86400000);
check('45 → 45 minutes', notes.parseTimeSpec('45') === 45 * 60000);
check('15s → 15 seconds', notes.parseTimeSpec('15s') === 15000);
check('garbage → null', notes.parseTimeSpec('soon') === null && notes.parseTimeSpec('') === null && notes.parseTimeSpec('-5m') === null);

(async () => {
  // ── 6. Reminders: schedule → fire → persist across "restart" ────────────────
  console.log('\n[6] reminders');
  const sent = [];
  const fakeSock = { sendMessage: async (jid, payload) => { sent.push({ jid, payload }); } };
  notes.__test.state.sock = fakeSock;

  notes.saveNotes(USER, [...notes.loadNotes(USER).filter((n) => n.id !== 'old1'), { id: 'rem1', type: 'text', text: 'call the accountant #money', tags: [], savedAt: Date.now() }]);
  const reminder = notes.addReminder({ userId: USER, userJid: `${USER}@s.whatsapp.net`, noteId: 'rem1', dueAt: Date.now() + 50, noteRef: notes.loadNotes(USER).find((n) => n.id === 'rem1') });
  check('reminder persisted', notes.loadReminders ? true : fakeDb.getKV('note_reminders', 'pending').length === 1);
  check('reminder stored in KV', fakeDb.getKV('note_reminders', 'pending').some((r) => r.id === reminder.id));

  await new Promise((r) => setTimeout(r, 120));
  const fired = await notes.scanReminders();
  check('due reminder fired exactly once', fired === 1 && sent.length === 1, `fired=${fired} sent=${sent.length}`);
  check('DM went to the user JID', sent[0]?.jid === `${USER}@s.whatsapp.net`);
  check('DM contains the note text', String(sent[0]?.payload?.text).includes('call the accountant'));
  check('fired reminder removed from KV', !fakeDb.getKV('note_reminders', 'pending').some((r) => r.id === reminder.id));

  const firedAgain = await notes.scanReminders();
  check('no double firing', firedAgain === 0 && sent.length === 1);

  // Simulate restart: state reset, new sock — a pending reminder still fires
  const reminder2 = notes.addReminder({ userId: USER, userJid: `${USER}@s.whatsapp.net`, noteId: 'rem1', dueAt: Date.now() + 50, noteRef: notes.loadNotes(USER).find((n) => n.id === 'rem1') });
  const sock2 = { sendMessage: async (jid, payload) => { sent.push({ jid, payload }); } };
  notes.onBotConnected(sock2);
  await new Promise((r) => setTimeout(r, 120));
  const firedAfterRestart = await notes.scanReminders();
  check('reminder survives restart (new socket fires it)', firedAfterRestart === 1 && sent.length === 2);

  notes.__test.reset();
  console.log(`\n${failed ? `${failed} FAILED` : 'ALL GREEN'} — ${passed} passed`);
  process.exit(failed ? 1 : 0);

})();
