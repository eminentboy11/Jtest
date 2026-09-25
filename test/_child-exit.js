'use strict';

/**
 * Child process for database.test.js. Writes with a deliberately long debounce
 * and then calls process.exit(0) without flushing, so the only thing that can
 * save the value is database.js's own 'exit' handler.
 *
 *   node test/_child-exit.js <dataDir>
 */

const path = require('path');

const REPO = path.resolve(__dirname, '..');
const [dataDir] = process.argv.slice(2);
// The Node test runner treats EVERY .js file inside a directory named `test/`
// as a test file, so it also executes this helper directly with no argv. Bail
// out before anything is required: the real invocation comes from
// database.test.js with an explicit dataDir, and running without one would
// resolve JUNE_DATA_DIR to the literal string "undefined" and write a stray
// bot file into the repo.
if (!dataDir) process.exit(0);


// Long enough that the debounce timer can never fire before exit.
process.env.JUNE_DATA_DIR = dataDir;
process.env.JUNE_DB_FLUSH_MS = '30000';
process.chdir(REPO);
if (!module.paths.includes(path.join(REPO, 'node_modules'))) {
  module.paths.unshift(path.join(REPO, 'node_modules'));
}
global.__CORE__ = REPO;
global.__ROOT__ = REPO;

const database = require(path.join(REPO, 'database.js'));

database.ready.then(() => {
  database.runAsBot('bot-alpha', () => database.setBotSetting('exitProbe', 'written-on-exit'));
  process.exit(0);   // no flush() — the exit handler has to catch this
});
