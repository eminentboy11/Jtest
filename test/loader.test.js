'use strict';

/**
 * The command loader: discovery, alias handling, fault tolerance and hot reload.
 *
 * COMMANDS_PATH is fixed to the repo's commands/ directory, so these tests write
 * real temporary files into it. That is why `npm test` runs with
 * --test-concurrency=1 -- the suites share one filesystem and a stray command
 * file would change the counts another suite asserts on. Every temp file is
 * removed in after(), including when a test fails.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-loader';
const COMMANDS = path.join(H.REPO, 'commands');
const A = 'bot-loader';

let database, handler, loader;
let BASE_COMMANDS = 0;
let BASE_ALIASES = 0;
const created = [];

/** Write a temp command file and remember to delete it. */
function writeCommand(relPath, source) {
  const full = path.join(COMMANDS, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, source);
  created.push(full);
  return full;
}

const cmd = (name, extra = '') => `
module.exports = {
  name: '${name}',
  aliases: [],
  category: 'general',
  description: 'test command',
  usage: '.${name}',
  async execute(sock, msg, args, extra) { ${extra} }
};
`;

before(async () => {
  ({ database, handler } = await H.boot({ dataDir: DATA }));
  loader = require(path.join(H.REPO, 'utils/commandLoader.js'));
  const base = loader.loadCommands();
  BASE_COMMANDS = base.commandCount;
  BASE_ALIASES = base.aliasCount;
});

after(() => {
  for (const f of created) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
  // Leave the tree the way we found it for whatever runs next.
  try { loader.reloadCommands(); } catch (_) {}
  H.teardown(handler, database);
});

describe('discovery', () => {
  test('loads the shipped commands', () => {
    const table = loader.loadCommands();
    assert.ok(table.get('ping'), 'ping must be found');
    assert.ok(table.get('uptime'), 'uptime must be found');
    assert.equal(table.commandCount, BASE_COMMANDS);
    // The shipped set: health, moderation, the restored June X nine, and the
    // three rich-app games. Asserted by name so a surprise command is visible.
    const expected = [
      'ping', 'uptime',
      'antispam', 'antiviewonce', 'antibot', 'antiforward', 'antitagadmins', 'antidelete',
      'menu', 'help', 'sticker', 'save', 'chatbot', 'mygroups',
      'ttt2', 'tod', 'snake',
      // the owner's own additions
      'add', 'all', 'antiall', 'tagall', 'autoreact', 'autorecording',
      'autorecordtype', 'autotyping', 'mode', 'setbotpp', 'setfont', 'setprefix',
      // their vv.js registers under this name, with vv/vv2 as aliases
      'viewonce',
      'deploy',
    ].sort();
    const actual = [...new Set([...table.values()].map((c) => c.name))].sort();
    assert.deepEqual(actual, expected);
  });

  test('commands are found recursively, not just at the top level', () => {
    writeCommand(path.join('general', 'zzdeep.js'), cmd('zzdeep'));
    writeCommand(path.join('admin', 'zznested.js'), cmd('zznested'));
    const table = loader.reloadCommands();
    assert.ok(table.get('zzdeep'));
    assert.ok(table.get('zznested'));
  });

  test('the category is taken from the containing directory', () => {
    const table = loader.reloadCommands();
    assert.equal(table.get('zznested').category, 'admin');
    assert.equal(table.get('zzdeep').category, 'general');
  });

  test('non-.js files are ignored', () => {
    writeCommand(path.join('general', 'zznotes.txt'), 'not javascript at all');
    const table = loader.reloadCommands();
    assert.equal(table.get('zznotes'), undefined);
  });

  test('aliases are registered and resolve to the same command', () => {
    writeCommand(path.join('general', 'zzalias.js'), `
module.exports = {
  name: 'zzalias', aliases: ['zzal', 'zzsecond'], category: 'general',
  description: 'x', usage: '.zzalias', async execute() {}
};`);
    const table = loader.reloadCommands();
    assert.equal(table.get('zzal')?.name, 'zzalias');
    assert.equal(table.get('zzsecond')?.name, 'zzalias');
    assert.equal(table.aliasCount, BASE_ALIASES + 2);
  });

  test('an alias that would bury a real command is skipped', () => {
    writeCommand(path.join('general', 'zzshadow.js'), `
module.exports = {
  name: 'zzshadow', aliases: ['ping'], category: 'general',
  description: 'x', usage: '.zzshadow', async execute() {}
};`);
    const table = loader.reloadCommands();
    assert.equal(table.get('ping').name, 'ping', 'the real ping must still win');
  });
});

describe('fault tolerance', () => {
  test('a command file that throws on load does not take down the rest', () => {
    writeCommand(path.join('general', 'zzbroken.js'), 'throw new Error("deliberate");');
    let table;
    assert.doesNotThrow(() => { table = loader.reloadCommands(); });
    assert.ok(table.get('ping'), 'ping must still load');
    assert.ok(table.get('uptime'), 'uptime must still load');
    assert.equal(table.get('zzbroken'), undefined, 'the broken file must be skipped');
    fs.rmSync(path.join(COMMANDS, 'general', 'zzbroken.js'), { force: true });
  });

  test('a file with no valid export is skipped', () => {
    writeCommand(path.join('general', 'zzempty.js'), 'module.exports = {};');
    const table = loader.reloadCommands();
    assert.equal(table.get('zzempty'), undefined);
    assert.ok(table.get('ping'));
  });
});

describe('counts', () => {
  test('commandCount and aliasCount are real numbers, not Map.size', () => {
    const table = loader.reloadCommands();
    // Map.size would include every alias as a separate entry; commandCount must
    // not.
    assert.ok(table.commandCount < table.size,
      `commandCount ${table.commandCount} should be below Map.size ${table.size}`);
    assert.equal(table.commandCount + table.aliasCount, table.size);
  });

  test('the counts are non-enumerable so they do not leak into iteration', () => {
    const table = loader.reloadCommands();
    assert.ok(!Object.keys(table).includes('commandCount'));
    assert.equal([...table.keys()].includes('commandCount'), false);
  });
});

describe('hot reload', () => {
  test('swapInto recomputes the counts on the table it is given', () => {
    // handler.js holds one long-lived Map, so a reload has to mutate it in
    // place. Plain clear()+set() copies entries only and silently drops the
    // non-enumerable counts, freezing getCommandCount() at its boot value --
    // which is the bug swapInto exists to prevent.
    const live = loader.loadCommands();
    const beforeCount = live.commandCount;
    const beforeAliases = live.aliasCount;

    writeCommand(path.join('general', 'zzhot.js'), `
module.exports = {
  name: 'zzhot', aliases: ['zzhotalias'], category: 'general',
  description: 'x', usage: '.zzhot', async execute() {}
};`);
    loader.swapInto(live, loader.reloadCommands());

    assert.equal(live.commandCount, beforeCount + 1, 'count must be recomputed');
    assert.equal(live.aliasCount, beforeAliases + 1);
    assert.ok(live.get('zzhot'), 'the new command must be present');
    assert.ok(live.get('zzhotalias'), 'and so must its alias');
    assert.equal(live.commandCount + live.aliasCount, live.size);
  });

  test('removing the file drops it on the next reload', () => {
    const f = path.join(COMMANDS, 'general', 'zzhot.js');
    fs.rmSync(f, { force: true });
    created.splice(created.indexOf(f), 1);
    const table = loader.reloadCommands();
    assert.equal(table.get('zzhot'), undefined);
  });

  test("the fs.watch in handler.js picks up a new file without a restart", async () => {
    // Clear the temp files earlier tests left behind and let the watcher settle,
    // otherwise it fires for those too and the delta is meaningless.
    for (const f of created.splice(0)) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
    await H.sleep(1200);

    const before = handler.getCommandCount();
    writeCommand(path.join('general', 'zzwatched.js'), cmd('zzwatched'));
    // watcher debounce is 250ms; allow for filesystem event latency
    await H.sleep(1500);

    assert.equal(handler.getCommandCount(), before + 1,
      `the live dispatch table should have grown by itself (${before} -> ${handler.getCommandCount()})`);
  });
});

describe('dispatch integration', () => {
  test('the hot-reloaded command is reachable through the real handler', async () => {
    // zzwatched.js was picked up by handler.js's own watcher in the test above,
    // so dispatching its name exercises the live table end to end.
    writeCommand(path.join('general', 'zzreply.js'),
      cmd('zzreply', "return extra.reply('ZZ-REPLY-OK');"));
    await H.sleep(1500);   // let the watcher reload

    const sock = H.makeDmSock();
    await H.dispatch(database, handler, A, sock, H.textMsg('.zzreply', { dm: true }));
    await H.sleep(300);
    assert.ok(sock._rec.texts.some((t) => t === 'ZZ-REPLY-OK'),
      JSON.stringify(sock._rec.texts));
  });

  test('a hot-reloaded command that does nothing still dispatches safely', async () => {
    const sock = H.makeDmSock();
    await H.dispatch(database, handler, A, sock, H.textMsg('.zzwatched', { dm: true }));
    await H.sleep(250);
    assert.equal(sock._rec.texts.length, 0, 'the stub execute() sends nothing');
  });
});
