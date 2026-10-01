/**
 * `.devinfo` — the dev console.
 *
 * Everything an operator needs in one reply: whether the data backup is alive
 * or dead, what the loader is doing, the process and its bots, and which
 * switches are on. Built for the question "is it actually working?" — so every
 * line is a fact read from disk or from the live process, never a guess.
 *
 * DEV NUMBERS ONLY, AND SILENTLY SO. Anyone else gets no reply, no reaction,
 * nothing — same rule as `.upgrade` and `.shutdown`. Not marked `ownerOnly`
 * because the handler answers that flag with a message, and the spec is total
 * silence.
 *
 * THE BACKUP IS NOT IN THIS PROCESS. gitSync runs in the LOADER (the loader is
 * the parent process and outlives every bot restart), so this command reads the
 * status file the loader writes and passes down in JUNE_SYNC_STATUS. That file
 * is the only honest source: the bot cannot see the loader's timers, but it can
 * see the last time the loader said it ran.
 */

const fs = require('fs');
const path = require('path');
const database = require('../../database');
const sessionService = require('../../platform/sessionService');
const loader = require('../../platform/loader');
const uptime = require('../../utils/uptime');
const { isDev } = require('../../utils/devs');

const STATUS_PATH = () => process.env.JUNE_SYNC_STATUS || '';

/** A backup older than this many intervals is not running, whatever it claims. */
const STALE_INTERVALS = 3;

const fmtMs = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, (sec || (!d && !h && !m)) && `${sec}s`]
    .filter(Boolean).join(' ');
};

const ago = (iso, now = Date.now()) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? { at: t, ms: Math.max(0, now - t) } : null;
};

/**
 * The backup section — the headline answer.
 *
 * Status comes from the loader's file. Three things are checked, in order:
 * is the file there at all, does it describe a running backup, and has it been
 * touched recently. A file that claims `enabled: true` but has not been updated
 * in three intervals is reported as STALLED, not as healthy — that is the
 * failure mode this command exists to catch.
 */
function backupReport(now = Date.now()) {
  const file = STATUS_PATH();

  if (!file) {
    return {
      state: 'unknown',
      detail: 'JUNE_SYNC_STATUS is not set — this bot was not launched by the loader, ' +
              'so the backup status cannot be read from here.',
    };
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      state: 'unknown',
      file,
      detail: fs.existsSync(file)
        ? `status file is unreadable: ${error.message}`
        : 'status file does not exist — the loader never started a backup, or this is a fresh boot.',
    };
  }

  const intervalMs = Number(status.intervalMin) > 0 ? Number(status.intervalMin) * 60_000 : 5 * 60_000;
  const last = ago(status.lastRunAt, now);
  const started = ago(status.startedAt, now);

  if (!status.enabled) {
    return { state: 'off', file, status, detail: reasonText(status.reason) };
  }

  const staleness = last ? last.ms : Infinity;
  if (!last) {
    return {
      state: 'armed',
      file, status,
      detail: started
        ? `armed ${fmtMs(started.ms)} ago, first run still pending`
        : 'armed, no run recorded yet',
    };
  }
  if (staleness > intervalMs * STALE_INTERVALS) {
    return {
      state: 'stalled',
      file, status,
      detail: `last run ${fmtMs(staleness)} ago — more than ${STALE_INTERVALS} intervals ` +
              `(${status.intervalMin}m each). The backup looks dead.`,
    };
  }

  return {
    state: status.lastResult === 'error' ? 'error' : 'running',
    file, status,
    detail: `last run ${fmtMs(staleness)} ago — ${status.lastResult || 'ok'}`,
  };
}

const reasonText = (reason) => ({
  'no-token': 'off: JUNE_DATA_TOKEN is not set in the loader\'s environment (the token is the switch)',
  'no-data-dir': 'off: the data directory the loader looked for does not exist',
  'gitsync-unloadable': 'off: the loader could not load gitSync from the extracted tree',
}[reason] || `off: ${reason || 'no reason recorded'}`);

/** The live process, its bots, and the switches that are on. */
function processReport(now = Date.now()) {
  let bots = [];
  try { bots = sessionService.configured() ? sessionService.list() : []; } catch (_) {}

  const states = {};
  let stale = 0;
  for (const entry of bots) {
    const live = sessionService.get(entry.id) || entry;
    const state = live.state || 'unknown';
    states[state] = (states[state] || 0) + 1;
    if (state === 'connected' && live.connectedAt && now - live.connectedAt > 0) {
      const snap = uptime.snapshot(entry.id, now);
      if (snap && !snap.online) stale++;
    }
  }

  const mem = process.memoryUsage();
  return {
    bots,
    states,
    stale,
    uptimeMs: process.uptime() * 1000,
    memUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
    memTotal: (mem.heapTotal / 1024 / 1024).toFixed(1),
    rss: (mem.rss / 1024 / 1024).toFixed(1),
  };
}

module.exports = {
  name: 'devinfo',
  aliases: ['devstat', 'devstatus'],
  category: 'owner',
  description: 'Dev console: backup status, loader, process and switches (devs only)',
  usage: '.devinfo',

  // No ownerOnly — see the header.
  async execute(sock, msg, args, extra) {
    try {
      if (!isDev(msg, extra)) return;   // total silence for everyone else

      const now = Date.now();
      const backup = backupReport(now);
      const proc = processReport(now);

      const icon = { running: '🟢', stalled: '🔴', error: '🟠', armed: '🟡', off: '⚪', unknown: '⚪' }[backup.state];

      const lines = [];
      lines.push('🛠️ *DEV INFO*');
      lines.push('');

      // ── the backup ────────────────────────────────────────────────────────
      lines.push(`${icon} *DATA BACKUP — ${backup.state.toUpperCase()}*`);
      lines.push(`↳ ${backup.detail}`);
      if (backup.status) {
        const s = backup.status;
        if (s.remote) lines.push(`↳ Repo: ${s.remote}`);
        if (s.dir) lines.push(`↳ Dir: ${s.dir}`);
        if (s.intervalMin) lines.push(`↳ Interval: ${s.intervalMin}m`);
        if (s.lastRunAt) lines.push(`↳ Last: ${s.lastRunAt}`);
        if (s.lastError) lines.push(`↳ Error: ${s.lastError}`);
        if (s.restoredFiles) {
          lines.push(`↳ Restored ${s.restoredFiles} file(s) at boot${s.restoredAt ? ` (${s.restoredAt})` : ''}`);
        }
        if (s.pid) lines.push(`↳ Loader pid: ${s.pid}${s.pid === process.ppid ? ' (this bot\'s parent ✓)' : ''}`);
      }

      // ── the loader ────────────────────────────────────────────────────────
      lines.push('');
      const loaderUp = fs.existsSync(path.join(process.cwd(), '..', '..')) &&
        String(process.cwd()).includes('node_platform');
      lines.push('📦 *LOADER*');
      lines.push(`↳ Detected: ${loaderUp ? 'yes' : 'no'} (cwd: ${process.cwd()})`);
      lines.push(`↳ Exit contract: ${loader.QUICK_RESTART} = re-sync+relaunch, ${loader.STAY_DOWN} = stay down`);
      lines.push(`↳ Parent pid: ${process.ppid}`);

      // ── the process ───────────────────────────────────────────────────────
      lines.push('');
      lines.push('⚙️ *PROCESS*');
      lines.push(`↳ Up: ${fmtMs(proc.uptimeMs)} | Memory: ${proc.memUsed}MB / ${proc.memTotal}MB | RSS: ${proc.rss}MB`);
      lines.push(`↳ Bots: ${proc.bots.length} (${Object.entries(proc.states).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'})`);
      if (proc.stale) lines.push(`↳ ⚠️ ${proc.stale} bot(s) show connected but have a stale uptime heartbeat`);

      // ── the switches ──────────────────────────────────────────────────────
      lines.push('');
      lines.push('🎚️ *SWITCHES*');
      lines.push(`↳ DEBUG: ${require('../../utils/log').enabled() ? 'ON (loud)' : 'off (quiet console)'}`);
      lines.push(`↳ Commands: ${require('../../handler').getCommandCount?.() ?? '?'}`);
      try {
        const cold = require('../../utils/coldArchive');
        lines.push(`↳ Cold archive: ${cold.enabled() ? `on → ${cold.CFG.repo}` : 'off'}`);
      } catch (_) {}
      lines.push(`↳ Data dir: ${database.getDataDir()}`);
      lines.push(`↳ Node: ${process.version}`);

      await extra.reply(lines.join('\n'));

    } catch (error) {
      console.error('[devinfo]', error);
      await extra.reply(`❌ devinfo failed: ${error.message}`);
    }
  },

  // exported for tests
  _internals: { backupReport, processReport, reasonText, STATUS_PATH, STALE_INTERVALS, fmtMs },
};
