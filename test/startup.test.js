'use strict';

/**
 * The startup card and the platform string.
 *
 * The card used to be an inline template inside index.js's connection.update
 * handler, where a single missing require (os) killed it silently inside a
 * catch. It now lives in utils/startupCard.js and utils/platform.js, which
 * means it can be tested without pairing a phone.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Must be set before ANY test runs: buildStartupCard -> applyFont ->
// fontConverter requires database.js lazily on first use, and database binds
// its directory from JUNE_DATA_DIR at first require. Setting this later (in a
// before hook) is too late -- the module is already cached on the default dir,
// which is exactly how this file once wrote test bots into the repo's data/.
const DATA = '/tmp/jtest-test-startup';
process.env.JUNE_DATA_DIR = DATA;

test('the startup card carries prefix, owner, platform and counts', () => {
  const { buildStartupCard } = require(path.join(REPO, 'utils', 'startupCard.js'));
  const card = buildStartupCard({
    botName: 'TestBot',
    prefix: '#',
    ownerName: 'Eminent',
    platform: '🐧 Linux',
    time: '2026-09-25 12:00:00',
    commandCount: 30,
    botId: 'web-test-1',
    accountNumber: '2348012345678',
  });
  for (const needle of ['TestBot', '[ # ]', 'Eminent', '🐧 Linux', '30', 'web-test-1', '2348012345678']) {
    assert.ok(card.includes(needle), `card must show ${needle}: ${card}`);
  }
  assert.ok(card.includes('Prefix'), 'card must label the prefix');
  assert.ok(card.includes('Owner'), 'card must label the owner');
});

test('the card survives an empty prefix (shown as "none", not blank)', () => {
  const { buildStartupCard } = require(path.join(REPO, 'utils', 'startupCard.js'));
  const card = buildStartupCard({
    botName: 'B', prefix: 'none', ownerName: 'O', platform: 'P',
    time: 't', commandCount: 1, botId: 'id', accountNumber: '1',
  });
  assert.ok(card.includes('[ none ]'), card);
});

test('platform detection returns a label and never throws', () => {
  const detectPlatform = require(path.join(REPO, 'utils', 'platform.js'));
  const label = detectPlatform();
  assert.equal(typeof label, 'string');
  assert.ok(label.trim().length > 0);
});

test('platform detection recognises hosting env markers', () => {
  const cp = require('child_process');
  const script = `console.log(require(${JSON.stringify(path.join(REPO, 'utils', 'platform.js'))})())`;
  const run = (env) => cp.execFileSync(process.execPath, ['-e', script],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim();
  assert.equal(run({ DYNO: 'web.1' }), '☁️ Heroku');
  assert.equal(run({ RAILWAY_ENVIRONMENT: 'production' }), '🚉 Railway');
  assert.ok(run({}).length > 0);
});

test('index.js sets global.platform once, before any bot boots', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8');
  const setAt = src.indexOf('global.platform = detectPlatform()');
  const bootAt = src.indexOf('async function bootBot');
  assert.ok(setAt > -1, 'index.js must set global.platform');
  assert.ok(bootAt > -1);
  assert.ok(setAt < bootAt, 'global.platform must exist before the first bot boots');
  // The duplicate inline detector that needed an un-required os is gone.
  assert.equal(src.includes('function detectPlatform()'), false,
    'index.js must use utils/platform.js, not its own copy');
});

test('menu reads global.platform instead of detecting its own', () => {
  const src = fs.readFileSync(path.join(REPO, 'commands', 'general', 'menu.js'), 'utf8');
  assert.ok(src.includes('global.platform ||'), 'menu must prefer global.platform');
  assert.equal(src.includes('function detectPlatform()'), false,
    'menu must not carry a second platform detector');
});

describe('fields resolve from the right bot', () => {
  // The first card read the DEFAULT bot's settings because connection.update
  // fires outside any runAsBot context. These pin the per-bot behaviour.
  let database;

  before(async () => {
    const fs2 = require('fs');
    fs2.rmSync(DATA, { recursive: true, force: true });
    fs2.mkdirSync(DATA, { recursive: true });
    process.env.JUNE_DATA_DIR = DATA;
    process.env.JUNE_DB_FLUSH_MS = '40';
    database = require(path.join(REPO, 'database.js'));
    await database.ready;
  });

  after(() => { try { database.shutdownDatabase(); } catch (_) {} });

  test('database bound to the test dir, never the repo data dir', () => {
    // Guards the lazy-require trap: fontConverter pulls database in on first
    // applyFont, so JUNE_DATA_DIR must be set before any test body runs.
    assert.equal(path.resolve(database.getDataDir()), path.resolve(DATA));
  });

  test('the bot\'s own prefix wins over the default bot\'s', async () => {
    await database.runAsBot('web-zuxu', async () => database.setBotSetting('prefix', 'i'));
    // default bot keeps a different prefix on purpose
    await database.runAsBot('main', async () => database.setBotSetting('prefix', '.'));

    const { resolveStartupFields } = require(path.join(REPO, 'utils', 'startupCard.js'));
    const sock = { user: { name: 'Glo 40' } };
    const f = await resolveStartupFields({
      database, sock, bot: { id: 'web-zuxu', accountNumber: '2348154853640' }, commandCount: 30,
    });
    assert.equal(f.prefix, 'i', 'must show THIS bot\'s prefix, not the default bot\'s');
    assert.equal(f.botId, 'web-zuxu');
  });

  test('owner falls back to the paired account name, and persists', async () => {
    const { resolveStartupFields } = require(path.join(REPO, 'utils', 'startupCard.js'));
    const sock = { user: { name: 'Glo 40' } };
    const f = await resolveStartupFields({
      database, sock, bot: { id: 'web-zuxu', accountNumber: '2348154853640' }, commandCount: 30,
    });
    assert.equal(f.ownerName, 'Glo 40', 'no stored owner and no owners list -> account display name');

    const stored = await database.runAsBot('web-zuxu', async () => database.getOwnerNames());
    assert.deepEqual(stored, ['Glo 40'], 'the resolved name must persist so the menu agrees');
  });

  test('an explicitly stored owner name is never overwritten', async () => {
    const { resolveStartupFields } = require(path.join(REPO, 'utils', 'startupCard.js'));
    await database.runAsBot('web-zuxu', async () => database.setOwnerNames(['Eminent']));
    const sock = { user: { name: 'Glo 40' } };
    const f = await resolveStartupFields({
      database, sock, bot: { id: 'web-zuxu', accountNumber: '2348154853640' }, commandCount: 30,
    });
    assert.equal(f.ownerName, 'Eminent');
  });

  test('the rendered card shows the real prefix and owner', async () => {
    const { buildStartupCard, resolveStartupFields } = require(path.join(REPO, 'utils', 'startupCard.js'));
    const sock = { user: { name: 'Glo 40' } };
    const f = await resolveStartupFields({
      database, sock, bot: { id: 'web-zuxu', accountNumber: '2348154853640' }, commandCount: 30,
    });
    const card = buildStartupCard(f);
    assert.ok(card.includes('[ i ]'), card);
    assert.ok(card.includes('Eminent'), card);
    assert.ok(!card.includes('Bot Owner'), 'placeholder must not survive a resolved name');
  });
});
