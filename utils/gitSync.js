'use strict';

/**
 * gitSync — mirror a data directory to a git remote using ONLY the git wire
 * protocol (clone / fetch / push). REST API quota consumed: ZERO.
 *
 * Why: GitHub's 5,000 req/hr budget meters api.github.com calls only. Git
 * data transfer (push/pull over HTTPS or SSH) is a different service with no
 * counted quota — just heuristic abuse guards that a sane cadence
 * (>= 1 min between pushes) never trips. So user-data backups that push
 * commits cost nothing, forever, at any volume.
 *
 * Env config:
 *   GIT_SYNC_DIR           directory to mirror (required)
 *   GIT_SYNC_REMOTE        repo url, https or ssh (required)
 *   GIT_SYNC_TOKEN         fine-grained PAT, Contents:RW on THAT REPO ONLY.
 *                          Omit entirely when the remote is SSH / deploy-key.
 *   GIT_SYNC_INTERVAL_MIN  push cadence for start(), default 5
 *   GIT_SYNC_SNAPSHOT      'true' = orphan-commit force-push each sync, so the
 *                          repo history stays 1 commit and size stays constant
 *
 * Safety rules baked in:
 *   - the token never lands in .git/config, argv-visible remotes, or logs
 *     (it is handed per-command via a credential helper reading the env)
 *   - a .gitignore guard keeps auth/, .env and token files out of commits
 *   - push rejects are healed with pull --rebase then retry (single-writer OK)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = {
  dir: process.env.GIT_SYNC_DIR || '',
  remote: process.env.GIT_SYNC_REMOTE || '',
  token: process.env.GIT_SYNC_TOKEN || '',
  intervalMin: Number(process.env.GIT_SYNC_INTERVAL_MIN || 5),
  snapshot: String(process.env.GIT_SYNC_SNAPSHOT || '').toLowerCase() === 'true',
};

const AUTHOR = ['-c', 'user.name=June X Sync', '-c', 'user.email=sync@junex.local'];
const IGNORE = 'auth/\n.env\n.env.*\n*.token\nsecrets/\nnode_modules/\n';

function git(args, cwd = CFG.dir) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let full = args;
  if (CFG.token) {
    env.GIT_SYNC_TOKEN = CFG.token;
    full = ['-c', 'credential.helper=!f() { echo username=x-access-token; echo password="$GIT_SYNC_TOKEN"; }; f', ...args];
  }
  const r = spawnSync('git', full, { cwd, env, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { status: r.status, out: CFG.token ? out.split(CFG.token).join('***') : out };
}

function ensure() {
  fs.mkdirSync(CFG.dir, { recursive: true });
  if (!fs.existsSync(path.join(CFG.dir, '.git'))) {
    const cloned = git(['clone', '--depth', '1', CFG.remote, CFG.dir], path.dirname(CFG.dir) || '.');
    if (cloned.status !== 0) {                 // empty remote: start fresh
      git(['init', '-b', 'main']);
      git(['remote', 'add', 'origin', CFG.remote]);
    }
  }
  git(['remote', 'set-url', 'origin', CFG.remote]);   // remote stays token-free
  const ig = path.join(CFG.dir, '.gitignore');
  if (!fs.existsSync(ig)) fs.writeFileSync(ig, IGNORE);
}

function pull() {
  const r = git(['pull', '--rebase', '--autostash', 'origin', 'HEAD']);
  if (r.status !== 0) git(['rebase', '--abort']);
  return r;
}

function commitAll(msg) {
  git(['add', '-A']);
  if (git(['diff', '--cached', '--quiet']).status === 0) return false;  // nothing changed
  return git([...AUTHOR, 'commit', '-m', msg]).status === 0;
}

function push(msg) {
  if (CFG.snapshot) {
    // orphan snapshot: history = always 1 commit, repo size = current data only
    git(['checkout', '--orphan', 'snap-tmp']);
    git(['add', '-A']);
    git([...AUTHOR, 'commit', '-m', msg]);
    git(['branch', '-D', 'main']);
    git(['branch', '-m', 'main']);
    return git(['push', '--force', 'origin', 'main']);
  }
  let r = git(['push', 'origin', 'HEAD:main']);
  if (r.status !== 0) { pull(); r = git(['push', 'origin', 'HEAD:main']); }
  return r;
}

/** One full sync cycle: ensure repo → pull → commit changes → push. */
function sync(reason = 'sync') {
  if (!CFG.dir || !CFG.remote) throw new Error('GIT_SYNC_DIR and GIT_SYNC_REMOTE are required');
  ensure();
  pull();
  const msg = `sync: ${reason} @ ${new Date().toISOString()}`;
  if (!commitAll(msg)) return { pushed: false, restored: true, out: 'no local changes' };
  const r = push(msg);
  return { pushed: r.status === 0, restored: true, out: r.out.slice(0, 300) };
}

/** Interval sync + flush-on-shutdown. Returns handles for embedding. */
function start(onLog = () => {}) {
  const tick = () => {
    try { const r = sync('interval'); onLog(r.pushed ? 'pushed' : 'idle', r.out); }
    catch (e) { onLog('error', e.message); }
  };
  const t = setInterval(tick, CFG.intervalMin * 60_000);
  t.unref?.();
  const bye = () => { try { sync('shutdown'); } catch (_) {} process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  return { sync, stop: () => clearInterval(t) };
}

/** Embedder config (coldArchive uses this instead of env). */
function configure(opts = {}) { Object.assign(CFG, opts); }

module.exports = { sync, start, pull, git, CFG, configure, ensure, commitAll, push };

if (require.main === module) {
  const r = sync(process.argv[2] || 'manual');
  console.log(`[gitSync] ${r.pushed ? 'PUSHED' : 'no push needed'} — ${r.out}`);
}
