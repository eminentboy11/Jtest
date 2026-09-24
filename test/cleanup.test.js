// CLEANUP HUB TEST — verifies the consolidated janitor in utils/cleanup.js:
//   1. root junk sweep: old pattern-matching media dies, fresh/foreign files survive,
//      directories (incl. session) are never touched
//   2. temp/ sweep: old files die, fresh files survive
//   3. runFileSweep: one pass covers both dirs and DMs the owner ONCE with the total
//   4. runFileSweep(null): silent mode (ENOSPC path) still deletes, no DM
// Uses real temp dirs via mkdtemp — never touches the bot's actual temp/ or root.

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const cleanup = require('../utils/cleanup');

const HOUR = 3600 * 1000;

function makeDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `june-cleanup-${label}-`));
}

function touch(dir, name, ageMs = 0) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'junk');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  ❌ ${label}: ${err.message}`);
  }
}

(async () => {
  // ── 1. Root junk sweep ──────────────────────────────────────────────────────
  console.log('root junk sweep');
  const rootDir = makeDir('root');
  touch(rootDir, 'media_old.mp4', 2 * HOUR);      // old, matches → dies
  touch(rootDir, 'download_old.png', 2 * HOUR);    // old, matches → dies
  touch(rootDir, 'sticker_fresh.gif');             // fresh → survives
  touch(rootDir, 'tmp_x.tmp', 2 * HOUR);           // old, but .tmp not a media ext → survives
  touch(rootDir, 'index.js', 2 * HOUR);            // old, foreign name → survives
  touch(rootDir, 'notes.txt', 2 * HOUR);           // old, foreign name → survives
  fs.mkdirSync(path.join(rootDir, 'session'));     // directory → never touched
  const sessionMarker = path.join(rootDir, 'session', 'creds.json');
  fs.writeFileSync(sessionMarker, '{}');

  const root = cleanup.sweepRootJunk({ rootDir });
  check('old media_old.mp4 removed', () => assert.ok(!exists(rootDir, 'media_old.mp4')));
  check('old download_old.png removed', () => assert.ok(!exists(rootDir, 'download_old.png')));
  check('fresh sticker_fresh.gif survives', () => assert.ok(exists(rootDir, 'sticker_fresh.gif')));
  check('old tmp_x.tmp survives (non-media ext)', () => assert.ok(exists(rootDir, 'tmp_x.tmp')));
  check('old index.js survives (foreign name)', () => assert.ok(exists(rootDir, 'index.js')));
  check('old notes.txt survives (foreign name)', () => assert.ok(exists(rootDir, 'notes.txt')));
  check('session directory untouched', () => assert.ok(fs.existsSync(sessionMarker)));
  check('reports 2 deletions', () => assert.strictEqual(root.deleted, 2));

  // ── 2. temp/ sweep ──────────────────────────────────────────────────────────
  console.log('temp/ sweep');
  const tempDir = makeDir('temp');
  touch(tempDir, 'ptv_in_123.mp4', 1 * HOUR);      // >30min → dies
  touch(tempDir, 'converted_old.ogg', 40 * 60 * 1000); // >30min, no name pattern in temp/ → dies
  touch(tempDir, 'ptv_out_fresh.mp4');              // fresh → survives
  fs.mkdirSync(path.join(tempDir, 'subdir'));       // directory → never touched

  const temp = cleanup.sweepTempDir({ tempDir });
  check('old ptv_in_123.mp4 removed', () => assert.ok(!exists(tempDir, 'ptv_in_123.mp4')));
  check('old converted_old.ogg removed', () => assert.ok(!exists(tempDir, 'converted_old.ogg')));
  check('fresh ptv_out_fresh.mp4 survives', () => assert.ok(exists(tempDir, 'ptv_out_fresh.mp4')));
  check('subdirectory untouched', () => assert.ok(fs.existsSync(path.join(tempDir, 'subdir'))));
  check('reports 2 deletions', () => assert.strictEqual(temp.deleted, 2));

  // ── 3. runFileSweep with live socket → ONE owner DM with the total ──────────
  console.log('runFileSweep (with sock)');
  const rootDir2 = makeDir('root2');
  const tempDir2 = makeDir('temp2');
  touch(rootDir2, 'media_sweep1.mp4', 2 * HOUR);
  touch(tempDir2, 'upload_sweep2.mp3', 1 * HOUR);
  touch(tempDir2, 'fresh_keep.jpg');

  const sent = [];
  const sock = {
    user: { id: '2349127747465:1@s.whatsapp.net', name: 'June Test' },
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; },
  };

  const result = await cleanup.runFileSweep(sock, { rootDir: rootDir2, tempDir: tempDir2 });
  check('root file deleted', () => assert.ok(!exists(rootDir2, 'media_sweep1.mp4')));
  check('temp file deleted', () => assert.ok(!exists(tempDir2, 'upload_sweep2.mp3')));
  check('fresh temp file survives', () => assert.ok(exists(tempDir2, 'fresh_keep.jpg')));
  check('counts: rootDeleted=1 tempDeleted=1', () => {
    assert.strictEqual(result.rootDeleted, 1);
    assert.strictEqual(result.tempDeleted, 1);
  });
  check('owner DM sent exactly once', () => assert.strictEqual(sent.length, 1));
  check('DM goes to bare owner jid', () => assert.strictEqual(sent[0].jid, '2349127747465@s.whatsapp.net'));
  check('DM reports total of 2', () => assert.ok(sent[0].content.text.includes('Removed 2')));

  // ── 4. runFileSweep(null) → silent ENOSPC mode, still deletes ───────────────
  console.log('runFileSweep (null sock)');
  const rootDir3 = makeDir('root3');
  const tempDir3 = makeDir('temp3');
  touch(rootDir3, 'media_enospc.mp4', 3 * HOUR);
  const result3 = await cleanup.runFileSweep(null, { rootDir: rootDir3, tempDir: tempDir3 });
  check('file deleted without a socket', () => assert.ok(!exists(rootDir3, 'media_enospc.mp4')));
  check('counts: rootDeleted=1', () => assert.strictEqual(result3.rootDeleted, 1));

  // ── 5. scheduler start/stop is idempotent and clears its interval ───────────
  console.log('scheduler');
  const before = (global._activeIntervals || []).length;
  global._activeIntervals = global._activeIntervals || [];
  // initialSweep:false → the test never scans the real bot root or temp/
  const id1 = cleanup.startScheduledCleanups(null, { initialSweep: false });
  const id2 = cleanup.startScheduledCleanups(null, { initialSweep: false });
  check('second start is a no-op (same handle)', () => assert.strictEqual(id1, id2));
  check('interval registered in _activeIntervals', () => assert.strictEqual((global._activeIntervals || []).length, before + 1));
  cleanup.stopScheduledCleanups();
  cleanup.stopScheduledCleanups();
  check('stop removes the interval', () => assert.strictEqual((global._activeIntervals || []).length, before));

  // cleanup after self
  for (const d of [rootDir, tempDir, rootDir2, tempDir2, rootDir3, tempDir3]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }

  if (failures > 0) {
    console.error(`\n❌ cleanup hub: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✅ cleanup hub: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('cleanup hub test crashed:', err);
  process.exit(1);
});
