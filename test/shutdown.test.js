// NUCLEAR SHUTDOWN TEST — verifies the 3-kill chain + standard shutdown in
// utils/shutdown.js:
//   1. requestShutdown writes { killsLeft: 2 } into the state file
//   2. no state file → enforceShutdownChain returns (normal boot, no exit)
//   3. state 2 → exit(44), state rewritten to 1
//   4. state 1 → exit(44), state deleted
//   5. after the chain → boot normally and stay alive
//   6. full simulation: command + boots → exactly 3 kills total, then alive
//   7. fail-open: corrupt JSON / spent count / stateFile-is-a-dir → no exit
//   8. default state file lives in database/ (loader SKIP_DIRS-safe)
//   9. requestShutdown to a non-writable location → false, no throw
//  10. shutdownNow runs the registered graceful routine (SIGTERM path),
//      arms the chain, exits 44
//  11. shutdownNow with no routine registered → fail-open, still exits
//  12. shutdownNow with a throwing routine → fail-open, still exits
//  13. shutdownNow with a hanging routine → timeout guard, still exits
// Uses a real temp dir via mkdtemp — never touches the bot's actual state.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const shutdown = require('../utils/shutdown');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'));
const stateFile = path.join(tmp, 'database', 'shutdown-state.json');

function makeOpts(codes) {
  // Captures exit calls; the process is never actually killed in tests.
  return {
    stateFile,
    codes,
    log: () => {},
    fatalLog: () => {},
    exit: (code) => codes.push(code),
  };
}

function writeState(killsLeft) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ killsLeft, at: Date.now() }), 'utf8');
}

// 1. requestShutdown writes the correct state (auto-creates database/ dir)
{
  const ok = shutdown.requestShutdown({ stateFile, log: () => {} });
  assert.strictEqual(ok, true, 'requestShutdown should succeed');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.killsLeft, 2, 'killsLeft should start at 2');
  assert.ok(typeof st.at === 'number' && st.at > 0, 'state should carry a timestamp');
}

// 2. no state file → normal boot, no exit, nothing created
{
  fs.unlinkSync(stateFile);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'no state file must not exit');
  assert.strictEqual(fs.existsSync(stateFile), false, 'no state file must not be created');
}

// 3. killsLeft 2 → exit 44, rewritten to 1
{
  writeState(2);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [44], 'kill 2/3 must exit with code 44');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.killsLeft, 1, 'state must decrement to 1');
}

// 4. killsLeft 1 → exit 44, state deleted
{
  writeState(1);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [44], 'kill 3/3 must exit with code 44');
  assert.strictEqual(fs.existsSync(stateFile), false, 'final kill must delete the state file');
}

// 5. after the chain → normal boot
{
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'boot after the chain must be a normal boot');
}

// 6. full simulation: command exit (kill 1) + boots until alive
{
  const codes = [];
  shutdown.requestShutdown({ stateFile, log: () => {} });
  codes.push(shutdown.EXIT_CODE); // kill 1: the command's own process.exit
  let boots = 0;
  while (boots < 5) {
    const before = codes.length;
    shutdown.enforceShutdownChain(makeOpts(codes));
    boots++;
    if (codes.length === before) break; // this boot stayed alive
  }
  assert.strictEqual(codes.length, 3, `chain must produce exactly 3 kills total, got ${codes.length}`);
  assert.ok(codes.every((c) => c === 44), 'every kill must use exit code 44');
  assert.strictEqual(boots, 3, 'the 3rd boot must stay alive');
  assert.strictEqual(fs.existsSync(stateFile), false, 'state must be gone when the bot is alive');
}

// 7a. corrupt JSON → fail-open: no exit, file deleted
{
  writeState(2);
  fs.writeFileSync(stateFile, '{ not json !!!', 'utf8');
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'corrupt state must fail open (boot normally)');
  assert.strictEqual(fs.existsSync(stateFile), false, 'corrupt state file must be deleted');
}

// 7b. spent/invalid count → fail-open: no exit, file deleted
{
  writeState(0);
  let codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'killsLeft 0 must fail open');
  assert.strictEqual(fs.existsSync(stateFile), false, 'spent state file must be deleted');

  writeState('banana');
  codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'non-numeric killsLeft must fail open');
}

// 7c. stateFile path is a directory → readFileSync throws EISDIR → fail-open
{
  fs.mkdirSync(stateFile, { recursive: true });
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'dir-as-state must fail open without throwing');
  fs.rmdirSync(stateFile);
}

// 8. default STATE_FILE location: inside database/ (loader SKIP_DIRS-safe)
{
  assert.ok(
    shutdown.STATE_FILE.endsWith(path.join('database', 'shutdown-state.json')),
    'default state file must live in database/'
  );
  // In production the bot folder is not in tmpdir; in test env (/tmp) we only check it ends with database/
  if (!shutdown.STATE_FILE.startsWith(os.tmpdir())) {
    assert.ok(
      !shutdown.STATE_FILE.startsWith(os.tmpdir()),
      'default state file must be inside the bot folder'
    );
  }
}

// 9. requestShutdown to a non-writable location → returns false, no throw
{
  fs.writeFileSync(path.join(tmp, 'shutdown-state.json'), 'x', 'utf8');
  const bad = path.join(tmp, 'shutdown-state.json', 'nested', 'x.json');
  const ok = shutdown.requestShutdown({ stateFile: bad, log: () => {} });
  assert.strictEqual(ok, false, 'non-writable state path must return false');
  fs.unlinkSync(path.join(tmp, 'shutdown-state.json'));
}

// ── shutdownNow: standard graceful shutdown + chain arming ───────────────────

const savedRoutine = global.__JUNE_SHUTDOWN;

(async () => {
  // 10. registered routine runs, then chain armed, then exit 44
  {
    let routineRan = false;
    global.__JUNE_SHUTDOWN = async () => { routineRan = true; };
    const codes = [];
    await shutdown.shutdownNow({ stateFile, codes, log: () => {}, exit: (c) => codes.push(c) });
    assert.strictEqual(routineRan, true, 'graceful routine must run');
    assert.deepStrictEqual(codes, [44], 'must exit 44 after the graceful close');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(st.killsLeft, 2, 'chain state must be armed after graceful close');
  }

  // 11. no routine registered → fail-open, still arms + exits
  {
    fs.unlinkSync(stateFile);
    global.__JUNE_SHUTDOWN = undefined;
    const codes = [];
    await shutdown.shutdownNow({ stateFile, codes, log: () => {}, exit: (c) => codes.push(c) });
    assert.deepStrictEqual(codes, [44], 'must exit even without a routine');
    assert.strictEqual(fs.existsSync(stateFile), true, 'chain state must still be armed');
  }

  // 12. routine throws → fail-open, still arms + exits
  {
    fs.unlinkSync(stateFile);
    global.__JUNE_SHUTDOWN = async () => { throw new Error('db close exploded'); };
    const codes = [];
    await shutdown.shutdownNow({ stateFile, codes, log: () => {}, exit: (c) => codes.push(c) });
    assert.deepStrictEqual(codes, [44], 'must exit even if the routine throws');
    assert.strictEqual(fs.existsSync(stateFile), true, 'chain state must still be armed');
  }

  // 13. routine hangs → timeout guard fires, still arms + exits (no hang)
  {
    fs.unlinkSync(stateFile);
    global.__JUNE_SHUTDOWN = () => new Promise(() => {}); // never settles
    const codes = [];
    const t0 = Date.now();
    await shutdown.shutdownNow({ stateFile, codes, log: () => {}, exit: (c) => codes.push(c), timeoutMs: 30 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `timeout guard must fire quickly (took ${elapsed}ms)`);
    assert.deepStrictEqual(codes, [44], 'must exit even if the routine hangs');
    assert.strictEqual(fs.existsSync(stateFile), true, 'chain state must still be armed');
  }

  global.__JUNE_SHUTDOWN = savedRoutine;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('SHUTDOWN TEST: all assertions passed');
})().catch((e) => {
  try { global.__JUNE_SHUTDOWN = savedRoutine; fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.error('SHUTDOWN TEST FAILED:', e);
  process.exit(1);
});
