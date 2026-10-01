'use strict';

const log = require('./log');

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
 *   - fetch, push and the branch HEAD points at all name BRANCH, so a rejected
 *     push is re-based on the winner's commit and retried as a fast-forward
 *   - a sync never deletes a path this working tree does not have, so one
 *     writer can never wipe another's files out of the warehouse
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

/**
 * The data warehouse repo, baked in. The operator supplies only the token
 * (JUNE_DATA_TOKEN) — the repo name is not something a deployment should have
 * to get right, and a typo there silently backs up nothing.
 */
const DEFAULT_DATA_REPO = 'eminentboy11/june-web-data';

/**
 * The ONE branch this module reads and writes.
 *
 * It used to fetch `origin HEAD` while pushing `HEAD:main`, and the two come
 * apart the moment the remote's default branch is not `main` — or points at a
 * branch that does not exist yet. The fetch then brings back nothing, the push
 * is rejected as a non-fast-forward, and the retry reproduces the same
 * rejection every interval, forever, while the log fills up with
 * "tip of your current branch is behind its remote counterpart".
 */
const BRANCH = 'main';

const AUTHOR = ['-c', 'user.name=June X Sync', '-c', 'user.email=sync@junex.local'];
const IGNORE = 'auth/\n.env\n.env.*\n*.token\nsecrets/\nnode_modules/\n';

/**
 * The remote as git needs to see it.
 *
 * JUNE_DATA_REPO carries a GitHub SLUG ("owner/repo" — that is what the docs
 * and .env.example show), but git wants a URL, so a bare slug is expanded here.
 * Anything that is already a URL, an ssh remote, or a filesystem path is left
 * alone — that last case matters for local testing and for anyone syncing to a
 * path or a self-hosted remote.
 */
function remoteUrl(remote = CFG.remote) {
  const r = String(remote || '').trim();
  if (!r) return '';
  if (r.includes('://')) return r;                       // https://, ssh://, file://
  if (r.startsWith('git@')) return r;                    // scp-style ssh
  if (/^[~/.]/.test(r)) return r;                        // absolute or relative path
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}.git`;
  return r;
}

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
  const url = remoteUrl();
  if (!fs.existsSync(path.join(CFG.dir, '.git'))) {
    // `git clone` refuses a destination that already holds files, and the data
    // directory always holds files — the bot stores ARE the point. So the clone
    // happens beside it and only its .git is adopted: the local repo shares the
    // warehouse's history from the start instead of opening with an unrelated
    // root commit, which is the other half of the non-fast-forward loop.
    //
    // --no-checkout: the warehouse's files are read out of the index, never
    // written into a live data directory.
    const parent = path.dirname(path.resolve(CFG.dir));
    const scratch = fs.mkdtempSync(path.join(parent, '.june-clone-'));
    const cloned = git(['clone', '--no-checkout', '--branch', BRANCH, url, scratch], parent);
    if (cloned.status === 0) {
      fs.renameSync(path.join(scratch, '.git'), path.join(CFG.dir, '.git'));
    } else {
      // No such branch on the remote (a brand-new warehouse): start the history
      // here and let the first push create it.
      git(['init', '-b', BRANCH]);
      git(['remote', 'add', 'origin', url]);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  git(['remote', 'set-url', 'origin', url]);   // remote stays token-free
  // HEAD must name the branch we push. A repo initialised by an older git — or
  // by an earlier version of this file — can be sitting on `master` while every
  // push goes to `main`, and then nothing this process does ever lands. Rename
  // rather than repoint when there are commits, so the branch the sync is about
  // to adopt the warehouse tip over stays reachable and can be reported.
  const named = `refs/heads/${BRANCH}`;
  const head = git(['symbolic-ref', '--quiet', 'HEAD']).out.trim();
  if (head && head !== named && git(['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0) {
    git(['branch', '-m', BRANCH]);
  }
  git(['symbolic-ref', 'HEAD', named]);
  const ig = path.join(CFG.dir, '.gitignore');
  if (!fs.existsSync(ig)) fs.writeFileSync(ig, IGNORE);
}

/** Tracked paths this working tree does not have. */
function missingPaths() {
  const listed = spawnSync('git', ['ls-files', '--deleted', '-z'], { cwd: CFG.dir, encoding: 'utf8' });
  return String(listed.stdout || '').split('\0').filter(Boolean);
}

/**
 * Put back the tracked files this tree is missing — and only those. A file that
 * is present is never touched: it may hold a write that has not been committed
 * yet, and the working tree here is live bot data.
 */
function checkoutMissing() {
  const missing = missingPaths();
  if (missing.length) git(['checkout', '--', ...missing]);
  return missing;
}

/**
 * Move the local branch onto the warehouse tip, leaving the working tree alone.
 *
 * `pull --rebase origin HEAD` was wrong twice over here: it fetched whatever
 * the remote calls HEAD rather than the branch being pushed, and it rewrote the
 * working tree, which in this repo is live data rather than a checkout. Adopting
 * the tip and re-committing on top is what a mirror needs — it cannot produce a
 * merge conflict, it never rewrites a file the bot is still writing, and the
 * push that follows is always a fast-forward.
 *
 * `materialize` decides what happens to files the branch has and this tree does
 * not: the cold archive wants them (it reads tarballs back out of its clone),
 * the loader does not (its working tree is the live data directory).
 */
function pull({ materialize = true } = {}) {
  const ref = `origin/${BRANCH}`;
  const fetched = git(['fetch', 'origin', BRANCH]);
  const have = git(['rev-parse', '--verify', '--quiet', ref]);
  if (fetched.status !== 0 || have.status !== 0) {
    return { status: 0, out: 'no remote branch yet', healed: false, moved: false };
  }

  const before = git(['rev-parse', '--verify', '--quiet', 'HEAD']).out.trim();
  if (materialize) checkoutMissing();                 // before the reset clears the list
  const reset = git(['reset', '--mixed', ref]);
  const after = git(['rev-parse', '--verify', '--quiet', 'HEAD']).out.trim();

  // A branch that is not an ancestor of the warehouse tip was not based on it:
  // the local repo opened with its own root commit and could never fast-forward
  // out of that, which is what this sync just repaired.
  const based = before !== '' && git(['merge-base', '--is-ancestor', before, ref]).status === 0;
  return {
    status: reset.status,
    out: reset.out,
    moved: before !== after,
    healed: before !== '' && !based,
  };
}

/** `add -A`, minus paths the caller says this working tree was never given. */
function stageAll(exclude = []) {
  const args = ['add', '-A', '--', '.'];
  for (const p of exclude) args.push(`:(exclude,literal)${p}`);
  return git(args);
}

function commitAll(msg, exclude = []) {
  stageAll(exclude);
  if (git(['diff', '--cached', '--quiet']).status === 0) return false;  // nothing changed
  return git([...AUTHOR, 'commit', '-m', msg]).status === 0;
}

function push(msg = 'sync') {
  if (CFG.snapshot) {
    // orphan snapshot: history = always 1 commit, repo size = current data only
    git(['checkout', '--orphan', 'snap-tmp']);
    git(['add', '-A']);
    git([...AUTHOR, 'commit', '-m', msg]);
    git(['branch', '-D', BRANCH]);
    git(['branch', '-m', BRANCH]);
    return git(['push', '--force', 'origin', BRANCH]);
  }
  let r = git(['push', 'origin', `${BRANCH}:${BRANCH}`]);
  if (r.status !== 0) {
    // Another writer landed a commit between our fetch and our push. Take its
    // tip as the base and re-commit on top, so the retry is a fast-forward
    // instead of the same rejection a second time.
    if (pull({ materialize: false }).status === 0) {
      // Re-measure what this tree does not have before re-staging: the winner's
      // commit may have added files of its own, and staging against a stale
      // list would read those as deletions.
      r = commitAll(msg, missingPaths())
        ? git(['push', 'origin', `${BRANCH}:${BRANCH}`])
        : { status: 0, out: 'already in the warehouse after adopting the remote tip' };
    }
  }
  return r;
}

/**
 * One full sync cycle: ensure repo → adopt the tip → commit changes → push.
 *
 * The exclusion list is the loader's one safeguard, and it is why this path
 * differs from a bare `commitAll`: this working tree is the live data
 * directory, while the branch also carries the bot's cold archive (bots/ and
 * meta/), which is written from a clone somewhere else entirely. Those paths
 * are tracked but not present here, and a plain `add -A` would stage every one
 * of them as a deletion and wipe them out of the warehouse. Whatever is absent
 * when the sync starts is therefore held back, so a push from here can only
 * ever add to the warehouse — the price being that deleting a store locally
 * leaves the warehouse's copy of it alone, which is what a data warehouse is
 * for.
 */
function sync(reason = 'sync') {
  if (!CFG.dir || !CFG.remote) throw new Error('GIT_SYNC_DIR and GIT_SYNC_REMOTE are required');
  ensure();
  const adopted = pull({ materialize: false });
  const absent = missingPaths();
  const note = adopted.healed ? 'repaired local branch onto the warehouse tip; ' : '';
  const msg = `sync: ${reason} @ ${new Date().toISOString()}`;
  if (!commitAll(msg, absent)) return { pushed: false, restored: true, healed: adopted.healed, out: `${note}no local changes` };
  const r = push(msg);
  return {
    pushed: r.status === 0,
    restored: true,
    healed: adopted.healed,
    out: `${note}${r.out}`.slice(0, 300),
  };
}

/**
 * Interval sync + flush-on-shutdown. Returns handles for embedding.
 *
 * The shutdown handler flushes and NOTHING ELSE — it must not call
 * process.exit(). Two reasons:
 *
 *   1. index.js owns process shutdown. Its own SIGTERM/SIGINT handler closes
 *      every bot socket, flushes the store and closes the HTTP server before
 *      exiting. A second handler that force-exits would win that race and skip
 *      the graceful close — in a process running up to 100 bots, that is 100
 *      dropped sockets to save a data-push.
 *   2. gitSync is embedded (coldArchive drives it), so it has no business
 *      deciding when the process dies.
 *
 * This path is currently unreachable anyway — coldArchive.start() registers its
 * own handlers and never calls this function — which is exactly why it was
 * worth defusing before someone wires it up.
 */
function start(onLog = () => {}) {
  const tick = () => {
    try { const r = sync('interval'); onLog(r.pushed ? 'pushed' : 'idle', r.out); }
    catch (e) { onLog('error', e.message); }
  };
  const t = setInterval(tick, CFG.intervalMin * 60_000);
  t.unref?.();
  const bye = () => { try { sync('shutdown'); } catch (_) {} };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  return { sync, stop: () => clearInterval(t) };
}

/** Embedder config (coldArchive uses this instead of env). */
function configure(opts = {}) { Object.assign(CFG, opts); }

module.exports = { sync, start, pull, git, CFG, BRANCH, DEFAULT_DATA_REPO, remoteUrl, configure, ensure, commitAll, push };

if (require.main === module) {
  const r = sync(process.argv[2] || 'manual');
  log.debug(`[gitSync] ${r.pushed ? 'PUSHED' : 'no push needed'} — ${r.out}`);
}
