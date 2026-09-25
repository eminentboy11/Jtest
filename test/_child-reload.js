'use strict';

/**
 * Child process for database.test.js. Loads the store from a given data
 * directory in a brand new process and reports what one bot sees, which is how
 * the suite proves persistence across a restart and recovery from a corrupt
 * file. Not a test file itself — the leading underscore keeps it out of
 * `node --test`'s *.test.js pattern.
 *
 *   node test/_child-reload.js <dataDir> <botId>
 */

const path = require('path');

const REPO = path.resolve(__dirname, '..');
const [dataDir, botId] = process.argv.slice(2);
// The Node test runner treats EVERY .js file inside a directory named `test/`
// as a test file, so it also executes this helper directly with no argv. Bail
// out before anything is required: the real invocation comes from
// database.test.js with an explicit dataDir, and running without one would
// resolve JUNE_DATA_DIR to the literal string "undefined" and write a stray
// bot file into the repo.
if (!dataDir) process.exit(0);


process.env.JUNE_DATA_DIR = dataDir;
process.chdir(REPO);
if (!module.paths.includes(path.join(REPO, 'node_modules'))) {
  module.paths.unshift(path.join(REPO, 'node_modules'));
}
global.__CORE__ = REPO;
global.__ROOT__ = REPO;

const database = require(path.join(REPO, 'database.js'));

database.ready
  .then(() => {
    const GROUP = '120363000000000000@g.us';
    const out = database.runAsBot(botId, () => ({
      botName: database.getBotSetting('botName'),
      mode: database.getBotMode(),
      owners: database.getOwners(),
      welcome: database.getGroupSettings(GROUP).welcome,
      lid: database.getLidMap('lidToPn', '1234@lid'),
      stat: database.getGroupStat(GROUP, '2026-01-01'),
      bots: database.listBotIds().sort(),
    }));
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  })
  .catch((e) => {
    process.stdout.write(JSON.stringify({ err: e.message }));
    process.exit(1);
  });
