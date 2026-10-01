'use strict';

/**
 * The data warehouse config.
 *
 * Two rules worth pinning down, because getting either wrong is silent:
 *
 *   1. The repo is baked in (eminentboy11/june-web-data) and written as a
 *      GitHub SLUG, but git wants a URL — so a bare slug has to be expanded,
 *      and anything that is already a URL, an ssh remote or a filesystem path
 *      must be left exactly as it is.
 *
 *   2. The TOKEN is the switch. With the repo baked in, gating on the repo
 *      would turn cold storage on for every deployment that never configured
 *      anything — and "on" means cloning and pushing to a GitHub repo.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

/** Fresh module instances — gitSync/coldArchive read env at require time. */
function fresh(env = {}) {
  const saved = { ...process.env };
  for (const key of ['JUNE_DATA_REPO', 'JUNE_DATA_TOKEN', 'GIT_SYNC_REMOTE']) delete process.env[key];
  Object.assign(process.env, env);
  for (const p of ['utils/gitSync.js', 'utils/coldArchive.js']) {
    delete require.cache[require.resolve(path.join(REPO, p))];
  }
  const gitSync = require(path.join(REPO, 'utils/gitSync.js'));
  const coldArchive = require(path.join(REPO, 'utils/coldArchive.js'));
  process.env = saved;
  return { gitSync, coldArchive };
}

describe('the warehouse repo is baked in', () => {
  test('gitSync exports the default slug', () => {
    const { gitSync } = fresh();
    assert.equal(gitSync.DEFAULT_DATA_REPO, 'eminentboy11/june-web-data');
  });

  test('coldArchive defaults to it, so only the token is needed', () => {
    const { coldArchive } = fresh();
    assert.equal(coldArchive.CFG.repo, 'eminentboy11/june-web-data');
  });

  test('JUNE_DATA_REPO still overrides it', () => {
    const { coldArchive } = fresh({ JUNE_DATA_REPO: 'someone/other-repo' });
    assert.equal(coldArchive.CFG.repo, 'someone/other-repo');
  });
});

describe('remoteUrl expands a slug and leaves everything else alone', () => {
  const cases = [
    ['eminentboy11/june-web-data', 'https://github.com/eminentboy11/june-web-data.git'],
    ['someone/other-repo', 'https://github.com/someone/other-repo.git'],
    ['https://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://gitlab.com/a/b.git', 'https://gitlab.com/a/b.git'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
    ['/tmp/local.git', '/tmp/local.git'],
    ['~/warehouse.git', '~/warehouse.git'],
    ['./relative.git', './relative.git'],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      const { gitSync } = fresh();
      assert.equal(gitSync.remoteUrl(input), expected);
    });
  }

  test('an empty remote stays empty rather than becoming a URL', () => {
    const { gitSync } = fresh();
    assert.equal(gitSync.remoteUrl(''), '');
    assert.equal(gitSync.remoteUrl(undefined), '');
  });

  test('a local path is never turned into a github url', () => {
    // the case that matters for local testing and self-hosted remotes
    const { gitSync } = fresh();
    const p = '/tmp/x/warehouse.git';
    assert.equal(gitSync.remoteUrl(p), p);
    assert.equal(gitSync.remoteUrl(p).includes('github.com'), false);
  });
});

describe('the token is the switch', () => {
  test('no token means off, even with the repo baked in', () => {
    const { coldArchive } = fresh();
    assert.equal(coldArchive.CFG.repo, 'eminentboy11/june-web-data', 'repo is still configured');
    assert.equal(coldArchive.enabled(), false, 'but nothing will run');
  });

  test('a token turns it on', () => {
    const { coldArchive } = fresh({ JUNE_DATA_TOKEN: 'ghp_example' });
    assert.equal(coldArchive.enabled(), true);
  });

  test('a local path needs no token — it authenticates itself', () => {
    const { coldArchive } = fresh({ JUNE_DATA_REPO: '/tmp/warehouse.git' });
    assert.equal(coldArchive.enabled(), true);
  });

  test('an ssh remote needs no token either (deploy key)', () => {
    const { coldArchive } = fresh({ JUNE_DATA_REPO: 'git@github.com:someone/warehouse.git' });
    assert.equal(coldArchive.enabled(), true);
  });

  test('another https warehouse still needs one', () => {
    const { coldArchive } = fresh({ JUNE_DATA_REPO: 'https://gitlab.com/someone/warehouse.git' });
    assert.equal(coldArchive.enabled(), false, 'https without credentials would just fail every hour');
  });
});
