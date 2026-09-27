'use strict';

/**
 * coldArchive — the COLD tier of June X's storage ladder.
 *
 *   HOT  RAM   : database.js LRU stores (idle stores unloaded)
 *   WARM disk  : data/bots/<id>.json + auth/<id>/   (active bots)
 *   COLD GitHub: <repo>/bots/<id>.tar.gz            (idle bots, zero local bytes)
 *
 * A bot idle for JUNE_ARCHIVE_IDLE_DAYS (default 5) is tar-gzipped (data file
 * + auth creds), committed to the private data repo through gitSync (git wire
 * protocol — no REST quota at any scale), then deleted locally. Waking it
 * (panel Start / engine.reconnect) pulls and extracts the tarball once.
 *
 * Remote layout (one file per botId, one meta file per host — no shared file
 * is ever written by two hosts, so multi-VPS never merges):
 *   bots/<botId>.tar.gz
 *   meta/hosts/<host>.json   { botId: { archivedAt, bytes, lastActiveAt } }
 *
 * Disabled unless JUNE_DATA_REPO is set — then everything here is a no-op.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const database = require('../database');
const gitSync = require('./gitSync');

const CFG = {
  repo: process.env.JUNE_DATA_REPO || '',
  token: process.env.JUNE_DATA_TOKEN || '',
  idleDays: Number(process.env.JUNE_ARCHIVE_IDLE_DAYS || 5),
  host: process.env.JUNE_HOST_NAME || os.hostname(),
  repoDir: path.join(process.cwd(), '.june-coldrepo'),
  // index.js injects this: a CONNECTED bot is never archived even if silent —
  // archiving removes auth creds, which would take a live bot offline.
  // Only OFFLINE + idle bots go cold.
  isActive: () => false,
};

const DAY = 86_400_000;
const enabled = () => Boolean(CFG.repo);

let stateCache = null;
let stateTimer = null;
const stateFile = () => path.join(database.getDataDir(), '.archive-state.json');

function loadState() {
  if (stateCache) return stateCache;
  try { stateCache = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch (_) { stateCache = {}; }
  return stateCache;
}
function saveState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    try {
      fs.mkdirSync(database.getDataDir(), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(stateCache, null, 2));
    } catch (_) {}
  }, 5000);
  stateTimer.unref?.();
}
function flushState() {
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  try { fs.writeFileSync(stateFile(), JSON.stringify(stateCache || {}, null, 2)); } catch (_) {}
}

/** Called on connect + every handled message: keeps lastActiveAt fresh. */
function touch(botId) {
  const s = loadState();
  const e = s[botId] || (s[botId] = {});
  e.lastActiveAt = Date.now();
  saveState();
}

const isArchived = (botId) => Boolean(loadState()[botId]?.archived);

function configure(opts = {}) {
  Object.assign(CFG, opts);
  stateCache = null;
}

function wire() {
  gitSync.configure({ dir: CFG.repoDir, remote: CFG.repo, token: CFG.token });
}

function metaPath() { return path.join(CFG.repoDir, 'meta', 'hosts', `${CFG.host}.json`); }
function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaPath(), 'utf8')); } catch (_) { return {}; }
}
function writeMeta(meta) {
  fs.mkdirSync(path.dirname(metaPath()), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

function tar(args) {
  const r = spawnSync('tar', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** Warm → cold: tar.gz the bot's data file + auth creds, push, delete local. */
function archiveBot(botId, reason = 'idle') {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  wire();
  const id = String(botId);
  const dataFile = database.botDataFile(id);
  const authDir = path.join(process.cwd(), 'auth', id);
  database.flush();                       // final flush before snapshotting
  if (!fs.existsSync(dataFile) && !fs.existsSync(authDir)) return { ok: false, reason: 'nothing-warm' };

  // Canonical staging layout (data/bots/<id>.json + auth/<id>/) so tarballs are
  // portable across hosts regardless of where their DATA_DIR lives.
  let archivedBytes = 0;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'june-stage-'));
  try {
    if (fs.existsSync(dataFile)) {
      fs.mkdirSync(path.join(stage, 'data', 'bots'), { recursive: true });
      fs.copyFileSync(dataFile, path.join(stage, 'data', 'bots', `${id}.json`));
    }
    if (fs.existsSync(authDir)) {
      fs.cpSync(authDir, path.join(stage, 'auth', id), { recursive: true });
    }
    gitSync.ensure();
    gitSync.pull();
    const tarball = path.join(CFG.repoDir, 'bots', `${id}.tar.gz`);
    fs.mkdirSync(path.dirname(tarball), { recursive: true });
    const tmp = `${tarball}.tmp`;
    const parts = ['data', 'auth'].filter((d) => fs.existsSync(path.join(stage, d)));
    const t = tar(['-czf', tmp, '-C', stage, ...parts]);
    if (!t.ok) return { ok: false, reason: `tar: ${t.out}` };
    fs.renameSync(tmp, tarball);

  const meta = readMeta();
  meta[id] = { archivedAt: Date.now(), bytes: fs.statSync(tarball).size, lastActiveAt: loadState()[id]?.lastActiveAt || null };
  writeMeta(meta);
  archivedBytes = meta[id].bytes;

  const msg = `archive ${id} (${reason})`;
  if (!gitSync.commitAll(msg)) { fs.rmSync(tarball, { force: true }); return { ok: false, reason: 'nothing-to-commit' }; }
  const pushed = gitSync.push(msg);
  if (pushed.status !== 0) return { ok: false, reason: `push: ${pushed.out.slice(0, 200)}` };

  // local bytes go away only after the remote has them
  database.purgeBot(id);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  }
  const s = loadState();
  s[id] = { ...(s[id] || {}), archived: true, archivedAt: Date.now() };
  flushState();
  console.log(`[ ${id} ] ❄️  Archived to GitHub (${reason}) — local copy removed`);
  return { ok: true, bytes: archivedBytes };
}

/** Cold → warm: pull and extract the tarball back into place. */
function restoreBot(botId) {
  if (!enabled()) return false;
  wire();
  const id = String(botId);
  gitSync.ensure();
  gitSync.pull();
  const tarball = path.join(CFG.repoDir, 'bots', `${id}.tar.gz`);
  if (!fs.existsSync(tarball)) return false;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'june-stage-'));
  try {
    const x = tar(['-xzf', tarball, '-C', stage]);
    if (!x.ok) { console.log(`[ ${id} ] Restore failed: ${x.out}`); return false; }
    const srcJson = path.join(stage, 'data', 'bots', `${id}.json`);
    if (fs.existsSync(srcJson)) {
      fs.mkdirSync(database.getDataDir(), { recursive: true });
      fs.copyFileSync(srcJson, database.botDataFile(id));
    }
    const srcAuth = path.join(stage, 'auth', id);
    if (fs.existsSync(srcAuth)) {
      fs.cpSync(srcAuth, path.join(process.cwd(), 'auth', id), { recursive: true });
    }
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  }
  const s = loadState();
  s[id] = { ...(s[id] || {}), archived: false, lastActiveAt: Date.now() };
  flushState();
  console.log(`[ ${id} ] 🔥 Restored from GitHub cold storage`);
  return true;
}

/** Purge everywhere: drop the remote tarball too (best effort). */
function deleteRemote(botId) {
  if (!enabled()) return false;
  wire();
  const id = String(botId);
  try {
    gitSync.ensure();
    gitSync.pull();
    const tarball = path.join(CFG.repoDir, 'bots', `${id}.tar.gz`);
    const meta = readMeta();
    const had = fs.existsSync(tarball) || meta[id];
    if (!had) return false;
    fs.rmSync(tarball, { force: true });
    delete meta[id];
    writeMeta(meta);
    const msg = `purge ${id}`;
    if (gitSync.commitAll(msg)) gitSync.push(msg);
    const s = loadState(); delete s[id]; flushState();
    return true;
  } catch (_) { return false; }
}

/** Hourly job: archive bots idle longer than the threshold; prune junk. */
function sweep(now = Date.now()) {
  const archived = [];
  if (enabled()) {
    const cutoff = now - CFG.idleDays * DAY;
    const s = loadState();
    const warm = new Set();
    try {
      for (const f of fs.readdirSync(database.getDataDir())) {
        if (f.endsWith('.json') && !f.startsWith('.')) warm.add(f.slice(0, -5));
      }
    } catch (_) {}
    for (const id of warm) {
      if (s[id]?.archived) continue;
      if (CFG.isActive(id)) continue;   // live socket: stays warm, silence is not abandonment
      const last = s[id]?.lastActiveAt || safeMtime(database.botDataFile(id)) || now;
      if (last < cutoff) {
        const r = archiveBot(id, `idle>${CFG.idleDays}d`);
        if (r.ok) archived.push(id);
      }
    }
  }
  pruneJunk(now);
  return archived;
}

function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_) { return null; } }

/** Junk pruning: dead tmp writes older than a day, old quarantined files. */
function pruneJunk(now = Date.now()) {
  const pruned = [];
  try {
    for (const f of fs.readdirSync(database.getDataDir())) {
      const p = path.join(database.getDataDir(), f);
      const age = now - (safeMtime(p) || now);
      if (f.includes('.tmp-') && age > DAY) { fs.rmSync(p, { force: true }); pruned.push(f); }
      if (f.includes('.corrupt-') && age > 30 * DAY) { fs.rmSync(p, { force: true }); pruned.push(f); }
    }
  } catch (_) {}
  return pruned;
}

/** Start the hourly sweep + shutdown flush of state. No-op when disabled. */
function start() {
  if (!enabled()) return { stop() {} };
  const t = setInterval(() => {
    try {
      const ids = sweep();
      if (ids.length) console.log(`[ COLD ] Archived ${ids.length} idle bot(s): ${ids.join(', ')}`);
    } catch (e) { console.log(`[ COLD ] sweep error: ${e.message}`); }
  }, 60 * 60_000);
  t.unref?.();
  process.on('SIGTERM', flushState);
  process.on('SIGINT', flushState);
  return { stop: () => clearInterval(t) };
}

module.exports = { CFG, configure, touch, isArchived, archiveBot, restoreBot, deleteRemote, sweep, pruneJunk, start, enabled };
