'use strict';

// Module-top env, as always: database binds DATA_DIR on first require.
const DATA = '/tmp/jtest-test-cold';
process.env.JUNE_DATA_DIR = DATA;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const database = require('../database');
const coldArchive = require('../utils/coldArchive');

const REMOTE = '/tmp/jtest-test-cold-remote.git';
const REPODIR = '/tmp/jtest-test-coldrepo';
const ROOT = process.cwd();
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const remoteFiles = () =>
  spawnSync('git', ['--git-dir', REMOTE, 'ls-tree', '-r', 'main', '--name-only'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean);

describe('coldArchive: warm → GitHub → warm', () => {
  before(() => {
    for (const d of [DATA, REPODIR]) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(REMOTE, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', '--bare', REMOTE]).status, 0);
    coldArchive.configure({ repo: REMOTE, repoDir: REPODIR, idleDays: 5, host: 'testhost', isActive: () => false });
  });
  after(() => {
    for (const d of [DATA, REPODIR, REMOTE]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('archive: tarball lands on the remote, local bytes disappear', async () => {
    await database.runAsBot('cold-1', async () => { database.setBotSetting('prefix', 'c'); database.setOwners(['2348012345678']); });
    await sleep(400);
    fs.mkdirSync(path.join(ROOT, 'auth', 'cold-1'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'auth', 'cold-1', 'creds.json'), '{}');

    const r = coldArchive.archiveBot('cold-1', 'test');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(database.botDataFile('cold-1')), false, 'data file must be gone locally');
    assert.equal(fs.existsSync(path.join(ROOT, 'auth', 'cold-1')), false, 'auth dir must be gone locally');
    assert.ok(coldArchive.isArchived('cold-1'));
    const files = remoteFiles();
    assert.ok(files.includes('bots/cold-1.tar.gz'), JSON.stringify(files));
    assert.ok(files.includes('meta/hosts/testhost.json'), JSON.stringify(files));
  });

  test('restore: tarball comes back with data AND creds intact', () => {
    assert.equal(coldArchive.restoreBot('cold-1'), true);
    assert.ok(fs.existsSync(database.botDataFile('cold-1')));
    assert.ok(fs.existsSync(path.join(ROOT, 'auth', 'cold-1', 'creds.json')));
    assert.equal(coldArchive.isArchived('cold-1'), false);
    return database.runAsBot('cold-1', async () => {
      assert.equal(database.getBotSetting('prefix'), 'c');
      assert.deepEqual(database.getOwners(), ['2348012345678']);
    });
  });

  test('sweep archives offline+idle bots but never live ones', async () => {
    // cold-2: offline and ancient → must archive
    await database.runAsBot('cold-2', async () => { database.setBotSetting('prefix', 'x'); });
    await sleep(400);
    const stateFile = path.join(DATA, '.archive-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state['cold-2'] = { lastActiveAt: Date.now() - 30 * DAY };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    coldArchive.configure({});   // reload state cache? no — touch path below instead
    // force state cache refresh by going through the module: re-configure resets cache
    coldArchive.configure({ repo: REMOTE, repoDir: REPODIR, idleDays: 5, host: 'testhost', isActive: () => false });

    // cold-3: same age but LIVE socket → must stay warm
    await database.runAsBot('cold-3', async () => { database.setBotSetting('prefix', 'y'); });
    await sleep(400);
    const state2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state2['cold-3'] = { lastActiveAt: Date.now() - 30 * DAY };
    fs.writeFileSync(stateFile, JSON.stringify(state2));
    coldArchive.configure({ repo: REMOTE, repoDir: REPODIR, idleDays: 5, host: 'testhost', isActive: (id) => id === 'cold-3' });

    const archived = coldArchive.sweep();
    assert.ok(archived.includes('cold-2'), JSON.stringify(archived));
    assert.ok(!archived.includes('cold-3'), 'live bot must never be archived');
    assert.equal(fs.existsSync(database.botDataFile('cold-3')), true, 'live bot keeps local files');
    assert.equal(fs.existsSync(database.botDataFile('cold-2')), false);
  });

  test('purge deletes the remote tarball too', () => {
    assert.equal(coldArchive.deleteRemote('cold-2'), true);
    assert.ok(!remoteFiles().includes('bots/cold-2.tar.gz'));
  });

  test('junk pruning removes dead tmp writes', async () => {
    const tmp = path.join(DATA, 'x.json.tmp-1-1');   // writeNow tmps sit beside the data file
    fs.writeFileSync(tmp, '{}');
    const old = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(tmp, old, old);
    const pruned = coldArchive.pruneJunk();
    assert.ok(pruned.some((f) => f.includes('.tmp-')), JSON.stringify(pruned));
    assert.equal(fs.existsSync(tmp), false);
  });
});
