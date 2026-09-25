'use strict';

/**
 * Command loader.
 *
 *   loadCommands()     -> Map<name|alias, command>   walks commands/ recursively
 *   reloadCommands()   -> clears the require cache and returns a fresh Map
 *   watchCommands(cb)  -> hot-reloads on file changes (debounced), so a new
 *                         command file works without restarting the server
 *   swapInto(live,fresh)-> in-place hot-reload of a Map callers already hold
 *   clearCommandCache()-> drops the commands subtree from require.cache
 *
 * One Map is the whole dispatch table: it holds each command under its real
 * name AND under every alias. Because `.size` therefore overstates the command
 * total, accurate counts are attached as non-enumerable props:
 *
 *   map.commandCount   real commands
 *   map.aliasCount     alias entries
 *
 * handler.js owns the single live Map and mutates it in place on hot-reload, so
 * handlers already mid-execution keep working; the next dispatch just resolves
 * to the new version.
 */

const fs = require('fs');
const path = require('path');

const COMMANDS_PATH = path.join(__dirname, '..', 'commands');
const EXT = '.js';

// Collect every .js file under `dir`, at any depth.
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out; // unreadable or deleted mid-scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(EXT)) out.push(full);
  }
  return out;
}

// Drop the whole commands subtree from require.cache so `require()` re-reads
// edited files from disk.
function clearCommandCache() {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(COMMANDS_PATH) && id.endsWith(EXT)) delete require.cache[id];
  }
}

// Register one command object (and its aliases) into the dispatch table.
function register(commands, command, category, source) {
  // The containing folder is the single source of truth for the category.
  // Trusting a hand-written `category:` field let files drift into the wrong
  // menu section, and a *missing* field produced an "UNDEFINED-CMD" section.
  command.category = category;
  command.__source = source;

  // Registration is last-write-wins, so a duplicate name would silently replace
  // an earlier command. Surface it instead of hiding it.
  const prior = commands.get(command.name);
  if (prior && prior.name === command.name) {
    console.warn(
      `[ COMMANDS ] Duplicate name "${command.name}": ${source} overrides ${prior.__source || 'earlier command'}`
    );
  }
  commands.set(command.name, command);

  for (const alias of command.aliases || []) {
    const clash = commands.get(alias);
    // A command listing its own name in `aliases` is harmless — it just
    // re-points the same key at the same object.
    if (clash === command) continue;
    if (clash && clash.name === alias) {
      console.warn(
        `[ COMMANDS ] Alias "${alias}" of ${source} shadows the real command "${alias}" (${clash.__source}) — alias skipped`
      );
      continue; // never let an alias bury a first-class command
    }
    commands.set(alias, command);
  }
}

// Attach accurate counts without making them show up in iteration/JSON.
// `configurable` is required so swapInto() can refresh them after a hot reload.
function withCounts(commands) {
  let commandCount = 0;
  let aliasCount = 0;
  for (const [key, command] of commands) {
    if (key === command.name) commandCount++;
    else aliasCount++;
  }
  const opts = { enumerable: false, configurable: true };
  Object.defineProperty(commands, 'commandCount', { ...opts, value: commandCount });
  Object.defineProperty(commands, 'aliasCount', { ...opts, value: aliasCount });
  return commands;
}

/**
 * Replace the contents of `target` with `fresh`, in place.
 *
 * Callers (handler.js) hold a long-lived reference to one Map, so a hot reload
 * must mutate that instance rather than hand back a new one. Plain
 * clear()+set() copies entries only and silently drops the non-enumerable
 * counts, leaving getCommandCount() frozen at its boot-time value — so the
 * counts are recomputed here as part of the swap.
 *
 * @param {Map} target live dispatch table to update
 * @param {Map} fresh  freshly loaded table
 * @returns {Map} target (same instance, updated)
 */
function swapInto(target, fresh) {
  target.clear();
  for (const [name, command] of fresh) target.set(name, command);
  return withCounts(target);
}

function loadCommands() {
  const commands = new Map();
  if (!fs.existsSync(COMMANDS_PATH)) {
    console.log('[ COMMANDS ] Commands directory not found');
    return withCounts(commands);
  }

  for (const file of walk(COMMANDS_PATH)) {
    const source = path.relative(COMMANDS_PATH, file);
    // First path segment under commands/ is the category.
    const category = source.split(path.sep)[0] || 'general';

    let exported;
    try {
      exported = require(file);
    } catch (error) {
      console.error(`[ COMMANDS ] Failed to load ${source}:`, error.message);
      continue; // one broken file must never take down the rest
    }

    for (const command of Array.isArray(exported) ? exported : [exported]) {
      if (command?.name) register(commands, command, category, source);
    }
  }

  return withCounts(commands);
}

// Rebuild from disk, clearing the cache first so edits are picked up.
function reloadCommands() {
  clearCommandCache();
  return loadCommands();
}

/**
 * Watch commands/ and hot-reload.
 *
 * @param {(freshCommands: Map) => void} callback receives the rebuilt Map
 * @param {object}   [opts]
 * @param {number}   [opts.debounceMs=250] ms to wait after the last fs event
 * @returns {{ close: () => void }} handle to stop watching
 */
function watchCommands(callback, opts = {}) {
  const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 250;
  let timer = null;
  let watcher = null;

  const scheduleReload = (changedFile) => {
    if (timer) clearTimeout(timer); // filesystem watchers fire in bursts
    timer = setTimeout(() => {
      timer = null;
      try {
        const fresh = reloadCommands();
        if (typeof callback === 'function') callback(fresh);
        console.log(`[ COMMANDS ] Hot-reloaded ${fresh.commandCount} commands (${changedFile})`);
      } catch (error) {
        // Keep the previous command set intact on failure.
        console.error('[ COMMANDS ] Hot-reload failed:', error.message);
      }
    }, debounceMs);
  };

  try {
    // Node >= 20 (pinned by package.json `engines`) supports recursive
    // fs.watch on Linux, macOS and Windows, so the old per-folder fallback
    // is dead code and is gone.
    watcher = fs.watch(COMMANDS_PATH, { recursive: true }, (_eventType, filename) => {
      const name = String(filename || '');
      if (!name.endsWith(EXT)) return;
      // Ignore generated/backup artefacts users may keep alongside commands.
      const lower = name.toLowerCase();
      if (lower.includes('.obfuscated.') || lower.includes('.backup')) return;
      scheduleReload(name);
    });
    watcher.on('error', (error) => {
      console.error('[ COMMANDS ] Watcher error:', error.message);
    });
  } catch (error) {
    // Hot-reload is a convenience, never a boot requirement.
    console.warn('[ COMMANDS ] Hot-reload unavailable:', error.message);
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      if (watcher) try { watcher.close(); } catch (_) {}
    },
  };
}

module.exports = { loadCommands, reloadCommands, watchCommands, clearCommandCache, swapInto };
