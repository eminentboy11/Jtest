'use strict';

/**
 * Per-bot isolation for the JSON store.
 *
 * The design this replaced gave every bot its own SQLite file but had 181
 * modules capture the default handle at require() time, so all bots silently
 * shared one database. These tests assert the property that actually had to
 * change: two bots running concurrently must not see each other's data.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const H = require('./helpers');

const DATA = '/tmp/jtest-test-database';
const A = 'bot-alpha';
const B = 'bot-beta';

let database, handler;

before(async () => {
  // No `owners` option here: that would write to the default bot and create a
  // main.json, which the on-disk layout test asserts is absent. This file sets
  // each bot's owners explicitly instead.
  ({ database, handler } = await H.boot({ dataDir: DATA }));
});

after(() => H.teardown(handler, database));

describe('bot settings', () => {
  test('each bot keeps its own values', async () => {
    await database.runAsBot(A, async () => {
      database.setBotSetting('botName', 'Alpha Bot');
      database.setBotSetting('prefix', '!');
      database.setBotMode('private');
      database.setOwners(['111@s.whatsapp.net']);
    });
    await database.runAsBot(B, async () => {
      database.setBotSetting('botName', 'Beta Bot');
      database.setBotSetting('prefix', '#');
    });
    database.flush();

    assert.equal(database.runAsBot(A, () => database.getBotSetting('botName')), 'Alpha Bot');
    assert.equal(database.runAsBot(B, () => database.getBotSetting('botName')), 'Beta Bot');
    assert.equal(database.runAsBot(A, () => database.getBotSetting('prefix')), '!');
    assert.equal(database.runAsBot(B, () => database.getBotSetting('prefix')), '#');
    assert.equal(database.runAsBot(A, () => database.getBotMode()), 'private');
    assert.equal(database.runAsBot(B, () => database.getBotMode()), 'public',
      'B must fall back to its own default, not inherit A');
  });

  test('owners are per bot and normalised to digits', async () => {
    assert.deepEqual(database.runAsBot(A, () => database.getOwners()), ['111']);
    assert.deepEqual(database.runAsBot(B, () => database.getOwners()), [],
      'B must not inherit A owner list');
  });

  test('unset keys fall back to the default template', () => {
    assert.equal(
      database.runAsBot(B, () => database.getBotSetting('timezone')),
      database.BOT_SETTINGS_DEFAULTS.timezone);
  });

  test('mode aliases normalise and invalid modes are rejected', () => {
    database.runAsBot(B, () => database.setBotMode('grp'));
    assert.equal(database.runAsBot(B, () => database.getBotMode()), 'group');
    assert.throws(() => database.runAsBot(B, () => database.setBotMode('not-a-mode')));
    database.runAsBot(B, () => database.setBotMode('public'));
  });

  test('the store is sparse: only written keys are persisted', () => {
    const rawB = H.readBotFile(DATA, B);
    assert.equal(rawB.settings.mode, undefined,
      'B never wrote a mode, so none should be on disk');
  });

  test('reads return copies, so a caller cannot corrupt the store', () => {
    const s = database.runAsBot(A, () => database.getGroupSettings(H.GROUP));
    s.welcome = 'MUTATED';
    assert.notEqual(database.runAsBot(A, () => database.getGroupSettings(H.GROUP)).welcome, 'MUTATED');
  });
});

describe('group settings', () => {
  test('the same group JID is independent per bot', async () => {
    await database.runAsBot(A, async () => {
      database.updateGroupSettings(H.GROUP, { welcome: true, antilink: true, antilinkAction: 'kick' });
    });
    await database.runAsBot(B, async () => {
      database.updateGroupSettings(H.GROUP, { welcome: false });
    });
    database.flush();

    const ga = database.runAsBot(A, () => database.getGroupSettings(H.GROUP));
    const gb = database.runAsBot(B, () => database.getGroupSettings(H.GROUP));
    assert.equal(ga.welcome, true);
    assert.equal(gb.welcome, false);
    assert.equal(ga.antilink, true);
    assert.equal(gb.antilink, false, 'A antilink must not leak into B');
    assert.equal(ga.antilinkAction, 'kick');
  });

  test('updateGroupSettings patches rather than replaces', () => {
    database.runAsBot(A, () => database.updateGroupSettings(H.GROUP, { goodbye: true }));
    const g = database.runAsBot(A, () => database.getGroupSettings(H.GROUP));
    assert.equal(g.welcome, true, 'an unrelated key must survive a patch');
    assert.equal(g.goodbye, true);
  });

  test('isAntiAllEnabled reads the right bot', () => {
    database.runAsBot(A, () => database.setAntiAllEnabled(H.GROUP, true));
    assert.equal(database.runAsBot(A, () => database.isAntiAllEnabled(H.GROUP)), true);
    assert.equal(database.runAsBot(B, () => database.isAntiAllEnabled(H.GROUP)), false);
    database.flush();
  });
});

describe('users, warnings, moderators, mutes', () => {
  before(async () => {
    await database.runAsBot(A, async () => {
      database.updateUser(H.MEMBER, { name: 'Alpha User' });
      database.addWarning(H.GROUP, H.MEMBER, 'spam');
      database.addWarning(H.GROUP, H.MEMBER, 'spam again');
      database.addModerator(H.MEMBER);
      database.muteUser(H.GROUP, H.MEMBER, 60);
    });
    database.flush();
  });

  test('warning counts are per bot', () => {
    assert.equal(database.runAsBot(A, () => database.getWarnings(H.GROUP, H.MEMBER)).count, 2);
    assert.equal(database.runAsBot(B, () => database.getWarnings(H.GROUP, H.MEMBER)).count, 0);
  });

  test('getWarnings exposes entries[] and addWarning returns the new count', () => {
    const w = database.runAsBot(A, () => database.getWarnings(H.GROUP, H.MEMBER));
    assert.ok(Array.isArray(w.entries));
    assert.equal(database.runAsBot(A, () => database.addWarning(H.GROUP, H.MEMBER, 'third')), 3);
    assert.equal(database.runAsBot(A, () => database.getWarnings(H.GROUP, H.MEMBER)).count, 3);
  });

  test('removeWarning decrements and clearWarnings scopes to one user', () => {
    database.runAsBot(A, () => {
      database.addWarning(H.GROUP, H.ADMIN, 'x');
      database.removeWarning(H.GROUP, H.MEMBER);
    });
    assert.equal(database.runAsBot(A, () => database.getWarnings(H.GROUP, H.MEMBER)).count, 2);
    database.runAsBot(A, () => database.clearWarnings(H.GROUP, H.MEMBER));
    assert.equal(database.runAsBot(A, () => database.getWarnings(H.GROUP, H.MEMBER)).count, 0);
    assert.equal(database.runAsBot(A, () => database.getWarnings(H.GROUP, H.ADMIN)).count, 1,
      'clearing one user must not wipe the group');
    database.runAsBot(A, () => database.clearWarnings(H.GROUP));
  });

  test('user records are per bot', () => {
    assert.equal(database.runAsBot(A, () => database.getUser(H.MEMBER))?.name, 'Alpha User');
    assert.equal(database.runAsBot(B, () => database.getUser(H.MEMBER))?.name, undefined);
  });

  test('moderator and mute flags are per bot', () => {
    assert.equal(database.runAsBot(A, () => database.isModerator(H.MEMBER)), true);
    assert.equal(database.runAsBot(B, () => database.isModerator(H.MEMBER)), false);
    assert.equal(database.runAsBot(A, () => database.isUserMuted(H.GROUP, H.MEMBER)), true);
    assert.equal(database.runAsBot(B, () => database.isUserMuted(H.GROUP, H.MEMBER)), false);
    database.runAsBot(A, () => database.unmuteUser(H.GROUP, H.MEMBER));
    assert.equal(database.runAsBot(A, () => database.isUserMuted(H.GROUP, H.MEMBER)), false);
  });
});

describe('lid mapping', () => {
  const LID = '1234@lid';

  test('both directions round-trip and stay per bot', async () => {
    await database.runAsBot(A, async () => {
      database.saveLidMap('lidToPn', LID, H.MEMBER);
      database.saveLidMap('pnToLid', H.MEMBER, LID);
    });
    database.flush();

    assert.equal(database.runAsBot(A, () => database.getLidMap('lidToPn', LID)), H.MEMBER);
    assert.equal(database.runAsBot(A, () => database.getLidMap('pnToLid', H.MEMBER)), LID);
    assert.equal(database.runAsBot(B, () => database.getLidMap('lidToPn', LID)), null);
  });

  test('getLidMaps flattens both directions with timestamps', () => {
    const maps = database.runAsBot(A, () => database.getLidMaps());
    assert.ok(maps.length >= 2);
    assert.ok(maps.some((m) => m.direction === 'lidToPn' && m.user === LID && m.value === H.MEMBER));
    assert.ok(maps.some((m) => m.direction === 'pnToLid' && m.user === H.MEMBER && m.value === LID));
    assert.ok(maps.every((m) => typeof m.updatedAt === 'number'));
  });
});

describe('group stats', () => {
  test('direct reads and writes are per bot', async () => {
    const stat = { total: 7, users: { [H.MEMBER]: 7 }, hours: { '3': 7 } };
    await database.runAsBot(A, async () => database.saveGroupStat(H.GROUP, '2026-01-01', stat));
    database.flush();

    assert.equal(database.runAsBot(A, () => database.getGroupStat(H.GROUP, '2026-01-01'))?.total, 7);
    assert.equal(database.runAsBot(B, () => database.getGroupStat(H.GROUP, '2026-01-01')), null);

    const all = database.runAsBot(A, () => database.getAllGroupStats(H.GROUP));
    assert.ok(Array.isArray(all));
    assert.ok(all.every((r) => 'date' in r && 'data' in r), 'shape must be [{date,data}]');
  });

  test('the groupstats utility routes through the owning bot', async () => {
    const gs = require(path.join(H.REPO, 'utils/groupstats.js'));
    const today = new Date().toISOString().slice(0, 10);

    await database.runAsBot(A, async () => {
      gs.addMessage(H.GROUP, H.MEMBER);
      gs.addMessage(H.GROUP, H.MEMBER);
    });
    await database.runAsBot(B, async () => gs.addMessage(H.GROUP, H.SPAMMER));

    // The flush timer has no ambient bot context. Without re-entering it, every
    // bot's counters would land in the default bot's file.
    gs.flush();
    database.flush();
    await H.sleep(80);

    assert.equal(H.readBotFile(DATA, A)?.groupStats?.[H.GROUP]?.[today]?.total, 2);
    assert.equal(H.readBotFile(DATA, B)?.groupStats?.[H.GROUP]?.[today]?.total, 1);
    assert.equal(H.readBotFile(DATA, 'main')?.groupStats?.[H.GROUP], undefined,
      'the default bot must not be polluted by the flush timer');

    const activeA = database.runAsBot(A, () => gs.getActiveUsers(H.GROUP, 5)).map((x) => x.jid);
    const activeB = database.runAsBot(B, () => gs.getActiveUsers(H.GROUP, 5)).map((x) => x.jid);
    assert.ok(activeA.includes(H.MEMBER) && !activeA.includes(H.SPAMMER));
    assert.ok(activeB.includes(H.SPAMMER) && !activeB.includes(H.MEMBER));
  });
});

describe('concurrency', () => {
  test('two bots interleaving 40 writes each keep their own context', async () => {
    const before = database.runAsBot(A, () => database.getBotSetting('botName'));
    await Promise.all([
      database.runAsBot(A, async () => {
        for (let i = 0; i < 40; i++) {
          database.setBotSetting('counter', i);
          await new Promise((r) => setImmediate(r));
          assert.equal(database.getBotSetting('counter'), i, `A iteration ${i}`);
        }
      }),
      database.runAsBot(B, async () => {
        for (let i = 0; i < 40; i++) {
          database.setBotSetting('counter', 1000 + i);
          await new Promise((r) => setImmediate(r));
          assert.equal(database.getBotSetting('counter'), 1000 + i, `B iteration ${i}`);
        }
      }),
    ]);
    assert.equal(database.runAsBot(A, () => database.getBotSetting('counter')), 39);
    assert.equal(database.runAsBot(B, () => database.getBotSetting('counter')), 1039);
    assert.equal(database.runAsBot(A, () => database.getBotSetting('botName')), before);
  });

  test('50 interleaved group messages split cleanly between two bots', async () => {
    const gs = require(path.join(H.REPO, 'utils/groupstats.js'));
    const today = new Date().toISOString().slice(0, 10);
    const sockA = H.makeSock({ selfId: H.BOT });
    const sockB = H.makeSock({ selfId: H.ADMIN });
    const read = (id) => H.readBotFile(DATA, id)?.groupStats?.[H.GROUP]?.[today]?.total || 0;
    const beforeA = read(A), beforeB = read(B);

    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) =>
        H.dispatch(database, handler, A, sockA, H.textMsg(`a${i}`, { sender: H.MEMBER }))),
      ...Array.from({ length: 25 }, (_, i) =>
        H.dispatch(database, handler, B, sockB, H.textMsg(`b${i}`, { sender: H.MEMBER }))),
    ]);
    await H.sleep(250);
    gs.flush();
    database.flush();
    await H.sleep(120);

    assert.equal(read(A), beforeA + 25, 'A must have gained exactly its own 25');
    assert.equal(read(B), beforeB + 25, 'B must have gained exactly its own 25');
  });
});

describe('on-disk layout', () => {
  test('one valid JSON file per bot, no temp files left behind', () => {
    database.flush();
    const files = fs.readdirSync(DATA);
    assert.ok(files.includes(`${A}.json`) && files.includes(`${B}.json`));
    assert.ok(!files.some((f) => f.includes('.tmp-')), files.join(', '));
    for (const f of files) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')), f);
    }
  });

  test('listBotIds and botDataFile agree with the directory', () => {
    assert.deepEqual(database.listBotIds().sort(), [A, B].sort());
    assert.equal(database.botDataFile(A), path.join(DATA, `${A}.json`));
  });

  test('botDataFile cannot be made to escape the data directory', () => {
    const dir = path.resolve(database.getDataDir());
    for (const hostile of ['weird/../id', '..', '/', 'a/b/c', '..%2f..', 'x'.repeat(300)]) {
      const f = path.resolve(database.botDataFile(hostile));
      assert.ok(f.startsWith(dir + path.sep), `${hostile} -> ${f}`);
      assert.ok(f.endsWith('.json'));
    }
    assert.equal(database.botDataFile(''), database.botDataFile(database.DEFAULT_BOT_ID));
  });
});

describe('failure recovery', () => {
  test('a corrupt bot file is quarantined, not fatal', () => {
    fs.writeFileSync(path.join(DATA, 'bot-corrupt.json'), '{"settings": {"botName": "trunc');
    const out = cp.execFileSync(process.execPath, [path.join(__dirname, '_child-reload.js'), DATA, 'bot-corrupt'],
      { encoding: 'utf8', timeout: 20000 });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.ok(!r.err, r.err);
    assert.equal(r.botName, database.BOT_SETTINGS_DEFAULTS.botName,
      'a corrupt store must start fresh on defaults');
    assert.ok(fs.readdirSync(DATA).some((f) => f.startsWith('bot-corrupt.json.corrupt-')),
      'the bad file must be renamed aside for inspection');
  });

  test('a write still pending in the debounce window survives process.exit()', () => {
    cp.execFileSync(process.execPath, [path.join(__dirname, '_child-exit.js'), DATA],
      { encoding: 'utf8', timeout: 20000 });
    assert.equal(H.readBotFile(DATA, A)?.settings?.exitProbe, 'written-on-exit');
  });
});

describe('persistence across a restart', () => {
  test('a fresh process reads back exactly what each bot wrote', () => {
    database.flush();
    const out = cp.execFileSync(process.execPath,
      [path.join(__dirname, '_child-reload.js'), DATA, A],
      { encoding: 'utf8', timeout: 20000 });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.ok(!r.err, r.err);
    assert.equal(r.botName, 'Alpha Bot');
    assert.equal(r.mode, 'private');
    assert.equal(r.welcome, true);
    assert.equal(r.lid, H.MEMBER);
    assert.deepEqual(r.owners, ['111']);
    assert.ok(Array.isArray(r.bots) && r.bots.includes(A) && r.bots.includes(B));
  });
});

describe('removed surface', () => {
  test('no SQLite handle is exported', () => {
    assert.equal(database._db, undefined);
  });

  test('the old remote layer is gone', () => {
    assert.ok(!fs.existsSync(path.join(H.REPO, 'utils/juneDb')));
    const pkg = JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8'));
    for (const d of ['better-sqlite3', 'sql.js', 'pg', 'mongodb']) {
      assert.equal(pkg.dependencies[d], undefined, `${d} should not be declared`);
    }
  });

  test('no hardcoded credentials remain in the database module', () => {
    const src = fs.readFileSync(path.join(H.REPO, 'database.js'), 'utf8');
    assert.ok(!/\d{8,10}:AA[0-9A-Za-z_-]{30,}/.test(src), 'Telegram bot token pattern found');
  });
});
