'use strict';

/**
 * Whole-repo structural invariants.
 *
 * These are the checks that would have caught the problems this cleanup fixed:
 * an npm script pointing at a file that does not exist, a require() of a module
 * that was deleted, dead code accumulating out of reach of the entry points, and
 * a secret committed to a public repo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', 'data', 'auth', 'test']);

/** Every JS file in the repo, excluding deps, VCS and runtime data. */
function repoFiles(ext = '.js') {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  })(REPO);
  return out;
}

const rel = (p) => path.relative(REPO, p);
const read = (p) => fs.readFileSync(p, 'utf8');

/** Strip comments so identifiers mentioned in prose are not mistaken for code. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return null;
}

describe('syntax', () => {
  // The suite itself is parsed as well; test/ stays out of the module graph
  // below because nothing in the application requires it.
  const files = [...repoFiles(), ...fs.readdirSync(__dirname)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(__dirname, n))];

  test('every JavaScript file parses', () => {
    const broken = [];
    for (const f of files) {
      try { new vm.Script(read(f), { filename: f }); } catch (e) { broken.push(`${rel(f)}: ${e.message}`); }
    }
    assert.deepEqual(broken, []);
  });

  test('every JSON file parses', () => {
    const broken = [];
    for (const f of repoFiles('.json')) {
      try { JSON.parse(read(f)); } catch (e) { broken.push(`${rel(f)}: ${e.message}`); }
    }
    assert.deepEqual(broken, []);
  });
});

describe('npm scripts', () => {
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));

  test('every script that names a file points at one that exists', () => {
    // This is the regression that `npm run build` and `npm test` hit: both
    // referenced paths that were not in the repo.
    const broken = [];
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const m of script.matchAll(/(?:^|\s)(?:node|nodemon)\s+(?!-)([\w./-]+\.\w+)/g)) {
        const target = path.join(REPO, m[1]);
        if (!fs.existsSync(target)) broken.push(`${name} -> ${m[1]}`);
      }
      for (const m of script.matchAll(/--test\s+([\w./-]+)\//g)) {
        const target = path.join(REPO, m[1]);
        if (!fs.existsSync(target)) broken.push(`${name} -> ${m[1]}/`);
      }
    }
    assert.deepEqual(broken, []);
  });

  test('main points at an existing file', () => {
    assert.ok(fs.existsSync(path.join(REPO, pkg.main)), pkg.main);
  });

  test('there is no build step naming a missing tool', () => {
    assert.equal(pkg.scripts.build, undefined,
      'the obfuscator build was removed; do not reintroduce it without obfuscator.js');
  });

  test('the test script targets the test directory', () => {
    assert.match(pkg.scripts.test, /--test\b.*\btest\//);
    assert.ok(fs.existsSync(path.join(REPO, 'test')));
  });
});

describe('dependencies', () => {
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));

  test('no database engine is declared', () => {
    for (const d of ['better-sqlite3', 'sql.js', 'pg', 'mongodb', 'sqlite3', 'sequelize', 'knex']) {
      assert.equal(pkg.dependencies[d], undefined, d);
      assert.equal(pkg.devDependencies?.[d], undefined, d);
    }
  });

  test('the heavy media tooling stays out', () => {
    for (const d of ['ffmpeg-static', 'fluent-ffmpeg', 'webp-converter', 'sharp']) {
      assert.equal(pkg.dependencies[d], undefined, d);
    }
  });

  test('every declared dependency is installed', () => {
    const missing = Object.keys(pkg.dependencies)
      .filter((d) => !fs.existsSync(path.join(REPO, 'node_modules', d)));
    assert.deepEqual(missing, []);
  });

  test('every declared dependency is required by live code', () => {
    const src = repoFiles().map(read).join('\n');
    const unused = Object.keys(pkg.dependencies).filter((d) =>
      !new RegExp(`require\\(['"]${d.replace('/', '\\/')}['"]\\)`).test(src));
    assert.deepEqual(unused, [], 'declared but never required: drop it or use it');
  });
});

describe('module graph', () => {
  const files = repoFiles();
  const REQ = /require\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

  const graph = new Map();
  for (const f of files) {
    const deps = new Set();
    for (const m of stripComments(read(f)).matchAll(REQ)) {
      const r = resolveSpec(f, m[2]);
      if (r) deps.add(r);
    }
    graph.set(f, deps);
  }

  // index.js is package.json main. commands/** are pulled in dynamically by the
  // loader at runtime, so they are roots too.
  const entries = files.filter((f) => rel(f) === 'index.js' || rel(f).startsWith(`commands${path.sep}`));

  const reachable = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const d of graph.get(f) || []) if (!reachable.has(d)) stack.push(d);
  }

  test('entry points were found', () => {
    assert.ok(entries.some((f) => rel(f) === 'index.js'));
    assert.ok(entries.length >= 3, `expected index.js plus commands, got ${entries.length}`);
  });

  test('no file is unreachable from the entry points', () => {
    // A reference count gets this wrong: ffmpegPath.js had four referrers and
    // looked alive, but all four were themselves unreachable.
    const dead = files.filter((f) => !reachable.has(f)).map(rel);
    assert.deepEqual(dead, []);
  });

  test('no relative require points at a file that does not exist', () => {
    const broken = [];
    for (const f of files) {
      for (const m of stripComments(read(f)).matchAll(REQ)) {
        const spec = m[2];
        if (!spec.startsWith('.')) continue;
        if (!resolveSpec(f, spec)) broken.push(`${rel(f)} -> ${spec}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  test('only the two documented places require by computed path', () => {
    const dynamic = [];
    for (const f of files) {
      const src = stripComments(read(f));
      if (/require\(\s*[^'")\s]/.test(src)) dynamic.push(rel(f));
    }
    // Exactly two, and both are deliberate:
    //   utils/commandLoader.js - requires the command files it discovers on disk
    //   handler.js             - optionalModule() for commands/fun/ttt2,
    //                            which may not exist
    // Anything else doing this would defeat the static graph above.
    assert.deepEqual(dynamic.sort(), [
      'handler.js',
      path.join('utils', 'commandLoader.js'),
    ].sort());
  });

  test('the optional game modules are the only requires allowed to be missing', () => {
    const src = stripComments(read(path.join(REPO, 'handler.js')));
    const optional = [...src.matchAll(/optionalModule\(\s*'([^']+)'/g)].map((m) => m[1]);
    // Only the rich-app games are optional modules; bomb and tictactoe were
    // plain-text games and are not part of this edition.
    assert.deepEqual(optional, ['./commands/fun/ttt2']);
    // They are resolved through optionalModule() rather than a bare require()
    // inside the message handler, so an absent file costs nothing per message.
    assert.equal(/require\(\s*'\.\/commands\/fun\//.test(src), false,
      'game modules must not be require()d directly');
  });
});

describe('database API surface', () => {
  const files = repoFiles();

  test('every database.* access in live code resolves to a real export', () => {
    process.env.JUNE_DATA_DIR = '/tmp/jtest-test-structure';
    const database = require(path.join(REPO, 'database.js'));
    const exported = new Set(Object.keys(database));

    const missing = [];
    for (const f of files) {
      if (rel(f) === 'database.js') continue;
      const src = stripComments(read(f));
      const locals = new Set();
      for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\((['"])[^'"]*database\2\)/g)) {
        locals.add(m[1]);
      }
      if (!locals.size) continue;
      const re = new RegExp(`\\b(${[...locals].join('|')})\\.(\\w+)`, 'g');
      for (const m of src.matchAll(re)) {
        if (!exported.has(m[2])) missing.push(`${rel(f)}: ${m[1]}.${m[2]}`);
      }
    }
    // getBadWords() was called by handler.js for years without ever existing;
    // the throw was swallowed by a try/catch, so antibadword silently never ran.
    assert.deepEqual(missing, []);
    try { database.shutdownDatabase(); } catch (_) {}
  });

  test('the five moderation hooks have the database functions they call', () => {
    const database = require(path.join(REPO, 'database.js'));
    const needed = [
      'getGroupSettings', 'updateGroupSettings', 'getOwners',
      'getAntiTagAdminsSettings', 'setAntiTagAdminsSettings',
      'getAntiforwardSettings', 'updateAntiforwardSettings',
      'addAntiforwardWarning', 'clearAllAntiforwardWarnings',
    ];
    for (const fn of needed) {
      assert.equal(typeof database[fn], 'function', `${fn} missing from database.js`);
    }
  });

  test('antiforward settings expose the keys the command reads', () => {
    const database = require(path.join(REPO, 'database.js'));
    const cfg = database.runAsBot('structure-probe', () => database.getAntiforwardSettings('1@g.us'));
    for (const key of ['antiforward', 'antiforwardAction', 'antiforwardMaxWarnings', 'enabled', 'warnLimit']) {
      assert.ok(key in cfg, `${key} missing — this mismatch is what left antiforward dead`);
    }
    database.runAsBot('structure-probe', () => database.resetBotData('structure-probe'));
  });

  test('every group setting the hooks read has a default', () => {
    const database = require(path.join(REPO, 'database.js'));
    const d = database.DEFAULT_GROUP_SETTINGS;
    for (const key of ['antiSpam', 'antiSpamLimit', 'antiSpamWindow', 'antiSpamAction',
      'antiviewonce', 'antibot', 'antitagadmins', 'antitagadminsAction',
      'antiforward', 'antiforwardAction', 'antiforwardLimit']) {
      assert.ok(key in d, `${key} has no default`);
    }
  });
});

describe('secrets', () => {
  test('no credential-shaped strings are committed', () => {
    const patterns = [
      [/(\d{8,10}):AA[0-9A-Za-z_-]{30,}/, 'Telegram bot token'],
      [/xox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
      [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'private key'],
      [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
      [/ghp_[0-9A-Za-z]{36}/, 'GitHub personal access token'],
    ];
    const hits = [];
    for (const f of [...repoFiles(), ...repoFiles('.json'), ...repoFiles('.md'), ...repoFiles('.example')]) {
      const src = read(f);
      for (const [re, label] of patterns) {
        if (re.test(src)) hits.push(`${rel(f)}: ${label}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test('the deleted remote database layer is still gone', () => {
    assert.ok(!fs.existsSync(path.join(REPO, 'utils', 'juneDb')));
    const hits = repoFiles().filter((f) => /juneDb|better-sqlite3|sql\.js/.test(read(f))).map(rel);
    assert.deepEqual(hits, []);
  });

  test('the spawned test helpers are inert when the runner executes them directly', () => {
    // Node's runner treats every .js file under a directory named `test/` as a
    // test file, so _child-exit.js and _child-reload.js get run a second time
    // with no argv. Without a guard that resolves JUNE_DATA_DIR to the literal
    // string "undefined" and writes a stray bot file into the repo root.
    const cp = require('child_process');
    const before = new Set(fs.readdirSync(REPO));

    for (const helper of ['_child-exit.js', '_child-reload.js']) {
      const r = cp.spawnSync(process.execPath, [path.join(__dirname, helper)],
        { encoding: 'utf8', timeout: 20000, cwd: REPO });
      assert.equal(r.status, 0, `${helper} exited ${r.status}: ${r.stderr}`);
    }

    const created = fs.readdirSync(REPO).filter((e) => !before.has(e));
    assert.deepEqual(created, [], `runner-executed helpers left artifacts: ${created}`);
    assert.ok(!fs.existsSync(path.join(REPO, 'undefined')),
      'a directory literally named "undefined" means JUNE_DATA_DIR was set from an undefined value');
  });
});
