'use strict';

/**
 * gitSync: the shapes that used to fail forever.
 *
 * The reported symptom was a push rejected every interval with
 *   ! [rejected]  HEAD -> main (non-fast-forward)
 *   hint: Updates were rejected because the tip of your current branch is
 *         behind its remote counterpart
 * and a retry that reproduced it instead of healing it.
 *
 * Two causes, both pinned here:
 *
 *   1. It fetched `origin HEAD` but pushed `HEAD:main`. When the remote's
 *      default branch is not main — or HEAD points at a branch that does not
 *      exist yet — the fetch brings back nothing, so the retry re-runs the same
 *      rejection. A repo whose .git was opened by an earlier version on
 *      `master` is the same bug from the other end.
 *
 *   2. A data directory is never empty, so `git clone <url> <datadir>` always
 *      failed and the repo opened with its OWN root commit. A history that
 *      shares no ancestor with the warehouse can never fast-forward.
 *
 * Third rule, which is about not destroying data while fixing the first two:
 * the warehouse branch has more than one writer (the bot's cold archive pushes
 * bots/ and meta/ from its own clone). A sync from the loader's working tree,
 * which does not have those files, must not stage them as deletions.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = '/tmp/jtest-gitsync';
const REMOTE = path.join(ROOT, 'warehouse.git');
const DATA = path.join(ROOT, 'data', 'bots');
const ARCHIVE = path.join(ROOT, 'coldrepo');   // stands in for coldArchive's clone

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ok = (args, cwd) => {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} → ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
};
const remoteTree = (branch = 'main') =>
  ok(['--git-dir', REMOTE, 'ls-tree', '-r', branch, '--name-only']).split('\n').filter(Boolean);
const remoteLog = () => ok(['--git-dir', REMOTE, 'log', '--format=%s', 'main']).split('\n').filter(Boolean).map((s) => s.split(' @ ')[0]);

/** A fresh module instance: gitSync reads CFG at state level, so reset it. */
function freshSync(dir) {
  delete require.cache[require.resolve(path.join(REPO, 'utils/gitSync.js'))];
  const gitSync = require(path.join(REPO, 'utils/gitSync.js'));
  gitSync.configure({ dir, remote: REMOTE, token: '', intervalMin: 5, snapshot: false });
  return gitSync;
}

/** A warehouse that looks like one created on GitHub with a README. */
function freshWarehouse({ defaultBranch = 'main', withMain = false } = {}) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  ok(['init', '-q', '--bare', REMOTE], ROOT);
  ok(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], REMOTE);
  const seed = path.join(ROOT, 'seed');
  ok(['clone', '-q', REMOTE, seed], ROOT);
  ok(['config', 'user.email', 'seed@test'], seed);
  ok(['config', 'user.name', 'seed'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# june data warehouse\n');
  ok(['add', '-A'], seed);
  ok(['commit', '-m', 'Initial commit'], seed);
  ok(['push', '-q', 'origin', `HEAD:${defaultBranch}`], seed);
  if (withMain && defaultBranch !== 'main') ok(['push', '-q', 'origin', 'HEAD:main'], seed);
  fs.rmSync(seed, { recursive: true, force: true });
  return remoteTree(defaultBranch);
}

/** A writer whose history was opened somewhere else entirely (its own root). */
function unrelatedWriterPush(files, branch = 'main') {
  const dir = path.join(ROOT, 'other-root');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ok(['init', '-q', '-b', branch, dir], ROOT);
  ok(['config', 'user.email', 'bot@test'], dir);
  ok(['config', 'user.name', 'bot'], dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  ok(['add', '-A'], dir);
  ok(['commit', '-m', 'bot root'], dir);
  ok(['remote', 'add', 'origin', REMOTE], dir);
  ok(['push', '-q', 'origin', `HEAD:${branch}`], dir);
}

/** Another writer (the bot's cold archive) pushes from its own working tree. */
function otherWriterPush(files, dir = ARCHIVE) {
  const ARCHIVE_DIR = dir;
  if (!fs.existsSync(path.join(ARCHIVE_DIR, '.git'))) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    ok(['clone', '-q', REMOTE, ARCHIVE_DIR], ROOT);
  }
  ok(['config', 'user.email', 'archive@test'], ARCHIVE_DIR);
  ok(['config', 'user.name', 'archive'], ARCHIVE_DIR);
  ok(['fetch', 'origin', 'main'], ARCHIVE_DIR);
  ok(['reset', '--hard', 'origin/main'], ARCHIVE_DIR);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ARCHIVE_DIR, name)), { recursive: true });
    fs.writeFileSync(path.join(ARCHIVE_DIR, name), body);
  }
  ok(['add', '-A'], ARCHIVE_DIR);
  ok(['commit', '-m', 'archive'], ARCHIVE_DIR);
  ok(['push', '-q', 'origin', 'main:main'], ARCHIVE_DIR);
}

describe('gitSync heals the failure that used to repeat', () => {
  before(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });
  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  test('a data directory that already has files still shares the warehouse history', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');

    const gitSync = freshSync(DATA);
    const r = gitSync.sync('boot');
    assert.equal(r.pushed, true, JSON.stringify(r));
    assert.equal(r.healed, false, 'a clean first sync is not a repair');

    const tree = remoteTree();
    assert.ok(tree.includes('2348154853640.json'), JSON.stringify(tree));
    assert.ok(tree.includes('README.md'), 'the warehouse keeps what it already had');
    // Two commits, not a replacement: the README is an ancestor of our sync.
    assert.deepEqual(remoteLog(), ['sync: boot', 'Initial commit']);
  });

  test('a repo left behind on master with its own root commit is repaired', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    // Exactly the broken state: init'd here (git default branch), committed
    // locally, its first push rejected, every retry identical.
    ok(['init', '-q', DATA]);
    ok(['checkout', '-q', '-b', 'master'], DATA);
    ok(['config', 'user.email', 'bot@test'], DATA);
    ok(['config', 'user.name', 'bot'], DATA);
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":2}');
    ok(['add', '-A'], DATA);
    ok(['commit', '-m', 'local only'], DATA);
    ok(['remote', 'add', 'origin', REMOTE], DATA);
    const rejected = git(['push', 'origin', 'HEAD:main'], DATA);
    assert.notEqual(rejected.status, 0, 'the reported state is a rejected push');
    assert.match(`${rejected.stdout}${rejected.stderr}`, /rejected/);

    const gitSync = freshSync(DATA);
    const r = gitSync.sync('interval');
    assert.equal(r.pushed, true, JSON.stringify(r));
    assert.equal(r.healed, true, 'and the sync says it repaired the branch');

    const tree = remoteTree();
    assert.ok(tree.includes('2348154853640.json'), JSON.stringify(tree));
    assert.ok(tree.includes('README.md'));
    assert.deepEqual(remoteLog(), ['sync: interval', 'Initial commit']);

    // The repair is not a one-off: the next cycle is an ordinary fast-forward.
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":3}');
    const next = gitSync.sync('interval');
    assert.equal(next.pushed, true);
    assert.equal(next.healed, false);
    assert.deepEqual(remoteLog(), ['sync: interval', 'sync: interval', 'Initial commit']);
  });

  test('the reported loop: data on main, HEAD pointing at another branch', () => {
    // The warehouse was created with a README on master (an account old enough
    // to still default there), and the bot has since pushed its own history to
    // main. The loader opens with its own root commit, so:
    //   - `origin HEAD` fetches master, the branch nobody is pushing
    //   - the push to main is a non-fast-forward
    //   - the retry re-fetches master and reproduces the same rejection,
    //     every interval, forever.
    freshWarehouse({ defaultBranch: 'master' });
    unrelatedWriterPush({ 'bots/cold-1.tar.gz': 'ARCHIVE' });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');

    const gitSync = freshSync(DATA);
    const r = gitSync.sync('boot');
    assert.equal(r.pushed, true, JSON.stringify(r));

    const tree = remoteTree();
    assert.ok(tree.includes('2348154853640.json'), JSON.stringify(tree));
    assert.ok(tree.includes('bots/cold-1.tar.gz'), 'and the bot\'s own branch is kept');
    assert.deepEqual(remoteLog(), ['sync: boot', 'bot root']);
  });

  test('a sync never deletes what another writer put in the warehouse', () => {
    freshWarehouse();
    otherWriterPush({ 'bots/cold-1.tar.gz': 'ARCHIVE', 'meta/hosts/vps1.json': '{"cold-1":{}}' });

    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');

    const gitSync = freshSync(DATA);
    assert.equal(gitSync.sync('interval').pushed, true);

    const tree = remoteTree();
    assert.ok(tree.includes('2348154853640.json'), JSON.stringify(tree));
    assert.ok(tree.includes('bots/cold-1.tar.gz'), 'the archive tarball survives');
    assert.ok(tree.includes('meta/hosts/vps1.json'), 'so does its meta file');
    assert.ok(tree.includes('README.md'));
  });

  test('a sync leaves the live data directory alone', () => {
    freshWarehouse();
    otherWriterPush({ 'bots/cold-1.tar.gz': 'ARCHIVE' });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');
    fs.writeFileSync(path.join(DATA, 'gone.json'), '{"deleted":true}');

    const gitSync = freshSync(DATA);
    assert.equal(gitSync.sync('boot').pushed, true);
    assert.equal(gitSync.sync('interval').pushed, false, 'nothing to push twice in a row');

    // No warehouse file is checked out into the data directory, and a file the
    // loader deleted locally is not resurrected into it.
    fs.rmSync(path.join(DATA, 'gone.json'));
    assert.equal(gitSync.sync('interval').pushed, false);
    assert.deepEqual(
      fs.readdirSync(DATA).filter((f) => f !== '.git').sort(),
      ['.gitignore', '2348154853640.json'],
      'only the loader\'s own stores (and the guard file it writes)'
    );
    assert.equal(fs.existsSync(path.join(DATA, 'README.md')), false);
    assert.equal(fs.existsSync(path.join(DATA, 'bots')), false);
  });

  test('a push that loses a race adopts the winner and retries as a fast-forward', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');
    const gitSync = freshSync(DATA);
    assert.equal(gitSync.sync('boot').pushed, true);

    // Local work, committed but not yet pushed. Whatever the warehouse has and
    // this data directory does not (its README) has to be held back, exactly as
    // sync() does, or the commit would read it as a deletion.
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":2}');
    const absent = ok(['ls-files', '--deleted'], DATA).split('\n').filter(Boolean);
    assert.ok(absent.includes('README.md'), JSON.stringify(absent));
    assert.equal(gitSync.commitAll('sync: interval', absent), true);
    // ...while the other writer lands its own commit first.
    otherWriterPush({ 'bots/cold-2.tar.gz': 'ARCHIVE2' });

    const r = gitSync.push('sync: interval');
    assert.equal(r.status, 0, r.out);
    const tree = remoteTree();
    assert.ok(tree.includes('bots/cold-2.tar.gz'), 'the winner keeps its commit');
    assert.ok(tree.includes('2348154853640.json'));
    const content = ok(['--git-dir', REMOTE, 'show', 'main:2348154853640.json']);
    assert.equal(content, '{"msgs":2}', 'and our change is on top of it');
  });

  test('the token still never reaches .git/config', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{}');
    const gitSync = freshSync(DATA);
    gitSync.configure({ token: 'ghp_TOPSECRET' });
    gitSync.sync('boot');
    const config = fs.readFileSync(path.join(DATA, '.git', 'config'), 'utf8');
    assert.equal(config.includes('ghp_TOPSECRET'), false);
    assert.equal(config.includes('x-access-token'), false);
  });

  test('the cold archive clone still materializes the files it reads back', () => {
    // restoreBot() pulls, then reads bots/<id>.tar.gz out of its own clone, so
    // its pull must put missing files on disk — the loader's must not.
    freshWarehouse();
    otherWriterPush({ 'bots/cold-1.tar.gz': 'ARCHIVE' });
    // A genuinely empty clone directory. (Deleting only .git would leave the
    // tarball sitting on disk from the writer above and prove nothing.)
    fs.rmSync(ARCHIVE, { recursive: true, force: true });
    fs.mkdirSync(ARCHIVE, { recursive: true });

    const gitSync = freshSync(ARCHIVE);
    gitSync.ensure();
    const r = gitSync.pull();
    assert.equal(
      fs.readFileSync(path.join(ARCHIVE, 'bots', 'cold-1.tar.gz'), 'utf8'),
      'ARCHIVE',
      'the tarball is checked out into the archive clone'
    );
    assert.ok(r.restored >= 1, JSON.stringify(r));
  });

  test('a clone that is behind the tip still gets files another writer added', () => {
    // The multi-host case: VPS-A archives a bot, VPS-B's clone has never seen
    // that tarball. Its HEAD is behind, and against a stale index nothing looks
    // missing — so materialising has to happen after the index moves to the tip.
    freshWarehouse();
    fs.mkdirSync(ARCHIVE, { recursive: true });
    ok(['clone', '-q', REMOTE, ARCHIVE], ROOT);       // full clone, level with the tip
    // ...and then a DIFFERENT directory pushes, so ARCHIVE is now behind.
    otherWriterPush({ 'bots/cold-9.tar.gz': 'LATE' }, path.join(ROOT, 'writer3'));

    const gitSync = freshSync(ARCHIVE);
    const r = gitSync.pull();
    assert.equal(fs.readFileSync(path.join(ARCHIVE, 'bots', 'cold-9.tar.gz'), 'utf8'), 'LATE');
    assert.equal(r.restored, 1, JSON.stringify(r));
  });

  test('restore refills a wiped data directory, minus the archive trees', () => {
    freshWarehouse();
    otherWriterPush({ 'bots/cold-1.tar.gz': 'ARCHIVE', 'meta/hosts/vps1.json': '{}' });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"owners":["2348154853640"]}');
    const writer = freshSync(DATA);
    assert.equal(writer.sync('boot').pushed, true);

    // ── the Replit case: fresh container, nothing on disk ────────────────────
    fs.rmSync(DATA, { recursive: true, force: true });

    const gitSync = freshSync(DATA);
    const r = gitSync.restore({ except: ['bots', 'meta'] });
    // Every non-archive tracked file, and the warehouse carries a README too.
    assert.ok(r.restored >= 1, JSON.stringify(r));
    assert.equal(r.skipped, null);
    assert.equal(
      fs.readFileSync(path.join(DATA, '2348154853640.json'), 'utf8'),
      '{"owners":["2348154853640"]}',
      'the store came back'
    );
    assert.equal(fs.existsSync(path.join(DATA, 'bots')), false, 'no tarballs in the live data dir');
    assert.equal(fs.existsSync(path.join(DATA, 'meta')), false, 'no host metadata either');

    // And the next ordinary sync has nothing to add: the restore left the tree
    // level with the warehouse.
    assert.equal(gitSync.sync('interval').pushed, false);
  });

  test('restore leaves a data directory that has anything of its own alone', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"owners":["x"]}');
    const writer = freshSync(DATA);
    assert.equal(writer.sync('boot').pushed, true);

    // A purged bot is a file the warehouse still has and this tree does not.
    // Restoring it here would bring the purged bot back from the dead.
    fs.rmSync(path.join(DATA, '2348154853640.json'));
    fs.writeFileSync(path.join(DATA, 'other.json'), '{"live":true}');

    const gitSync = freshSync(DATA);
    const r = gitSync.restore({ except: ['bots', 'meta'] });
    assert.equal(r.restored, 0, JSON.stringify(r));
    assert.equal(r.skipped, 'not-a-fresh-directory');
    assert.equal(fs.existsSync(path.join(DATA, '2348154853640.json')), false, 'the purged store stays purged');
    assert.equal(fs.readFileSync(path.join(DATA, 'other.json'), 'utf8'), '{"live":true}', 'live data untouched');
  });

  test('restore never overwrites a file the bot is writing', () => {
    freshWarehouse();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":1}');
    const writer = freshSync(DATA);
    assert.equal(writer.sync('boot').pushed, true);

    // Wiped except for one file the bot has already rewritten locally.
    for (const f of fs.readdirSync(DATA)) {
      if (f !== '.git' && f !== '2348154853640.json') fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(DATA, '2348154853640.json'), '{"msgs":99,"fresh":true}');

    const gitSync = freshSync(DATA);
    assert.equal(gitSync.restore({ except: ['bots', 'meta'] }).restored, 0);
    assert.equal(fs.readFileSync(path.join(DATA, '2348154853640.json'), 'utf8'), '{"msgs":99,"fresh":true}');
  });
});
