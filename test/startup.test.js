'use strict';

/**
 * The startup card and the platform string.
 *
 * The card used to be an inline template inside index.js's connection.update
 * handler, where a single missing require (os) killed it silently inside a
 * catch. It now lives in utils/startupCard.js and utils/platform.js, which
 * means it can be tested without pairing a phone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

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
