'use strict';

/**
 * The console policy.
 *
 * Jtest used to print a line per inbound message and per command invocation,
 * which is why a bot doing nothing still filled the panel. The rule now: the
 * console is for what a human must ACT on — the startup box, errors, a bot
 * connecting, pairing codes, and the three commands that end the process.
 * Everything else needs DEBUG=true.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

/** Run a snippet against the real logger, with DEBUG set or unset. */
function runLogger(snippet, env = {}) {
  const script = `
    const log = require(${JSON.stringify(path.join(REPO, 'utils/log.js'))});
    ${snippet}
  `;
  const child = { ...process.env };
  delete child.DEBUG;
  delete child.JUNE_ANTIDELETE_DEBUG;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', cwd: REPO, env: { ...child, ...env },
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
/** Comments stripped — prose about console.log is not a call to console.log. */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('utils/log.js', () => {
  test('debug is silent unless DEBUG=true', () => {
    const quiet = runLogger("log.debug('CHATTER'); log.info('LOUD'); log.error('BAD');");
    assert.equal(quiet.out.includes('CHATTER'), false, 'debug must be silent by default');
    assert.equal(quiet.out.includes('LOUD'), true, 'info always prints');
    assert.equal(quiet.err.includes('BAD'), true, 'errors always print');
    assert.equal(quiet.status, 0);
  });

  test('DEBUG=true turns debug back on', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      const loud = runLogger("log.debug('CHATTER');", { DEBUG: value });
      assert.equal(loud.out.includes('CHATTER'), true, `DEBUG=${value} should enable it`);
    }
  });

  test('DEBUG=false and junk values stay quiet', () => {
    for (const value of ['false', '0', '', 'no', 'maybe']) {
      const quiet = runLogger("log.debug('CHATTER');", { DEBUG: value });
      assert.equal(quiet.out.includes('CHATTER'), false, `DEBUG=${value} must stay quiet`);
    }
  });

  test('enabled() reports the same answer as the logger', () => {
    assert.equal(runLogger("console.log(log.enabled());").out.trim(), 'false');
    assert.equal(runLogger("console.log(log.enabled());", { DEBUG: 'true' }).out.trim(), 'true');
  });

  test('error goes to stderr so it cannot be lost in stdout filtering', () => {
    const r = runLogger("log.error('ONLY-STDERR');");
    assert.equal(r.err.includes('ONLY-STDERR'), true);
    assert.equal(r.out.includes('ONLY-STDERR'), false);
  });
});

describe('the hot paths use it', () => {
  test('the per-message line is debug, not console.log', () => {
    const src = code('handler.js');
    assert.match(src, /log\.debug\(`\[\$\{new Date\(\)\.toTimeString\(\)/,
      'the incoming-message line must be debug');
    assert.equal(/console\.log\(`\[\$\{new Date\(\)\.toTimeString\(\)/.test(src), false,
      'a raw console.log there is what filled the panel');
  });

  test('the command log is visible for process commands only', () => {
    const src = code('handler.js');
    assert.match(src, /PROCESS_COMMANDS\s*=\s*\[[^\]]*'upgrade'[^\]]*'shutdown'[^\]]*'restart'/,
      'upgrade, shutdown and restart must be listed as process commands');
    assert.match(src, /if \(PROCESS_COMMANDS\.includes\(.*\)\) log\.info\(_cmdLine\);/);
    assert.match(src, /else log\.debug\(_cmdLine\);/);
  });

  test('a bot connecting and a pairing code stay visible', () => {
    const src = code('index.js');
    assert.match(src, /log\.info\(`\[ \$\{bot\.id\} \] ✅ Connected as/);
    assert.match(src, /log\.info\(`\[ \$\{bot\.id\} \] 🔑 Pairing code/);
  });

  test('the startup box and the shutdown line stay visible', () => {
    const src = code('index.js');
    assert.match(src, /console\.log\(bar \+ '\\n'\)/, 'the banner is printed directly');
    assert.match(src, /log\.info\('\\n\[ SHUTDOWN \] Stopping\.\.\.'\)/);
  });

  test('no error path was routed into debug', () => {
    // Anything that says "failed", "error" or "cannot" must not sit behind a
    // debug gate — that is how a real failure goes unseen.
    const files = ['index.js', 'handler.js', 'platform/sessions.js',
      'utils/coldArchive.js', 'utils/commandLoader.js'];
    // The one documented exception: the startup CARD is cosmetic — the bot is
    // already connected and working when it fails, so nothing is actionable.
    const COSMETIC = /Startup msg failed/;

    const offenders = [];
    for (const f of files) {
      for (const line of code(f).split('\n')) {
        if (!/log\.debug\(/.test(line)) continue;
        if (COSMETIC.test(line)) continue;
        if (/(failed|Failed|cannot|Cannot|refused|Refused)/.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
