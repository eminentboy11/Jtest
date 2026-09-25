/**
 * Command Loader - Separate module to avoid circular dependencies
 *
 * Hot-reload capable.  `loadCommands()` builds a Map<name|alias, command>.
 * `watchCommands(callback)` watches the commands/ tree and re-loads fresh
 * copies of any changed .js file, then hands the rebuilt Map to the callback
 * so the bot picks up edits WITHOUT restarting the server.
 *
 * - No extra dependency: uses Node's built-in fs.watch (recursive).
 *   (Node >= 20 supports recursive watching on Linux/macOS; the repo's
 *   `engines` already require Node >= 20.)
 * - On change we clear the require cache for the entire commands subtree,
 *   so `require()` re-reads the edited file from disk.
 * - Events are debounced (filesystem watchers often fire bursts).
 * - Safe while a command is mid-execution: the live Map is mutated in-place
 *   (same instance) so in-flight handlers keep working; the next call just
 *   resolves to the new version.
 */

const fs = require('fs');
const path = require('path');

const COMMANDS_PATH = path.join(__dirname, '..', 'commands');

// Only consider these roots; skip our own transient/temp files if any.
const SCRIPT_EXT = '.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// List of category folders currently present (each holds commands).
function listCategories() {
  if (!fs.existsSync(COMMANDS_PATH)) return [];
  return fs.readdirSync(COMMANDS_PATH);
}

// Clear the require cache for every loaded command file (+ the whole subtree).
function clearCommandCache() {
  const prefix = COMMANDS_PATH;
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(prefix) && id.endsWith(SCRIPT_EXT)) {
      delete require.cache[id];
    }
  }
}

// Load all commands from disk (fresh `require` calls).
function loadCommands() {
  const commands = new Map();
  const commandsPath = COMMANDS_PATH;

  if (!fs.existsSync(commandsPath)) {
    console.log('Commands directory not found');
    return commands;
  }

  const categories = fs.readdirSync(commandsPath);

  categories.forEach(category => {
    const categoryPath = path.join(commandsPath, category);
    let stat;
    try {
      stat = fs.statSync(categoryPath);
    } catch (_) {
      return; // may have been deleted mid-scan
    }
    if (stat.isDirectory()) {
      let files = [];
      try {
        files = fs.readdirSync(categoryPath).filter(f => f.endsWith(SCRIPT_EXT));
      } catch (_) { return; }

      files.forEach(file => {
        const fullPath = path.join(categoryPath, file);
        try {
          const exported = require(fullPath);
          const cmds = Array.isArray(exported) ? exported : [exported];
          cmds.forEach(command => {
            if (command && command.name) {
              // The containing folder is the single source of truth for the
              // category. Trusting a hand-written `category:` field let files
              // drift into the wrong menu section (e.g. general/antibug.js
              // declaring `owner`), and a *missing* field produced the
              // "UNDEFINED-CMD" section in .menu.
              command.category = category;

              // Registration is last-write-wins, so a duplicate name silently
              // replaces an earlier command. Surface it instead of hiding it.
              const prior = commands.get(command.name);
              if (prior && prior.name === command.name) {
                console.warn(
                  `[ COMMANDS ] Duplicate name "${command.name}": ` +
                  `${category}/${file} overrides ${prior.__source || 'earlier command'}`
                );
              }
              command.__source = `${category}/${file}`;
              commands.set(command.name, command);

              if (command.aliases) {
                command.aliases.forEach(alias => {
                  const clash = commands.get(alias);
                  // A command listing its own name in `aliases` is harmless
                  // (it just re-points the same key at the same object).
                  if (clash === command) return;
                  if (clash && clash.name === alias) {
                    console.warn(
                      `[ COMMANDS ] Alias "${alias}" of ${category}/${file} ` +
                      `shadows the real command "${alias}" (${clash.__source}) — alias skipped`
                    );
                    return; // never let an alias bury a first-class command
                  }
                  commands.set(alias, command);
                });
              }
            }
          });
        } catch (error) {
          console.error(`Error loading command ${file}:`, error.message);
        }
      });
    }
  });

  // Honest counts: the Map holds both real command names and aliases (they
  // share one dispatch table), so .size alone overstates the command total.
  // Attach the breakdown as non-enumerable props for banners/menus.
  let commandCount = 0, aliasCount = 0;
  for (const [key, cmd] of commands) {
    if (key === cmd.name) commandCount++; else aliasCount++;
  }
  Object.defineProperty(commands, 'commandCount', { value: commandCount, enumerable: false });
  Object.defineProperty(commands, 'aliasCount', { value: aliasCount, enumerable: false });

  return commands;
}

// Rebuild the command map from disk, clearing the cache first so edits are
// picked up. Returns the fresh Map.
function reloadCommands() {
  clearCommandCache();
  return loadCommands();
}

// ── Watcher ────────────────────────────────────────────────────────────────

/**
 * Watch the commands/ tree for changes and hot-reload.
 *
 * @param {(freshCommands: Map) => void} callback  called with the rebuilt Map
 *        whenever a .js command file changes (debounced).
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=250]           ms to wait after the last event
 * @returns {{ close: () => void }}  a handle to stop watching.
 */
function watchCommands(callback, opts = {}) {
  const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 250;
  let timer = null;
  let watcher = null;

  const reload = (changedFile) => {
    try {
      const fresh = reloadCommands();
      if (typeof callback === 'function') callback(fresh);
      console.log(
        `[ COMMANDS ] Hot-reloaded ${fresh.size} command${fresh.size === 1 ? '' : 's'} ` +
        `(changed: ${changedFile})`
      );
    } catch (error) {
      console.error('[ COMMANDS ] Hot-reload failed:', error.message);
      // Keep the previous command set intact on failure.
    }
  };

  const scheduleReload = (changedFile) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => reload(changedFile), debounceMs);
  };

  try {
    // fs.watch with recursive:true works on Node >= 20 for Linux/macOS.
    watcher = fs.watch(COMMANDS_PATH, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const name = String(filename);
      // Only react to .js files under the commands tree.
      if (!name.endsWith(SCRIPT_EXT)) return;
      // Skip our own reference/backup files if users keep them in commands/.
      const lower = name.toLowerCase();
      if (lower.includes('.obfuscated.') || lower.includes('.backup')) return;
      scheduleReload(name);
    });
  } catch (err) {
    // Fallback: recursive watch not supported (e.g. older Node/plattform).
    // Watch the top-level categories individually.
    console.warn('[ COMMANDS ] Recursive watch unavailable, falling back to per-folder watch:', err.message);
    const watchers = [];
    for (const category of listCategories()) {
      const dirPath = path.join(COMMANDS_PATH, category);
      try {
        const w = fs.watch(dirPath, (eventType, filename) => {
          const name = String(filename || '');
          if (name.endsWith(SCRIPT_EXT)) scheduleReload(`${category}/${name}`);
        });
        watchers.push(w);
      } catch (_) { /* ignore unreadable folders */ }
    }
    return {
      close() {
        if (timer) clearTimeout(timer);
        for (const w of watchers) try { w.close(); } catch (_) {}
      },
    };
  }

  watcher.on('error', (err) => {
    console.error('[ COMMANDS ] Watcher error:', err.message);
  });

  return {
    close() {
      if (timer) clearTimeout(timer);
      if (watcher) try { watcher.close(); } catch (_) {}
    },
  };
}

module.exports = { loadCommands, watchCommands, reloadCommands, clearCommandCache };
