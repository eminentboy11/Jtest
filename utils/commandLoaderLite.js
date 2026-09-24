/**
 * Mini handler loader — lite, not huge like wdp
 * - Loads local commands from commands/*.js
 * - Loads remote commands from URL base (env REMOTE_COMMANDS_BASE or data/remote-commands.json)
 * - Remote = JS files fetched online and cached in data/remote-commands/
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const LOCAL_DIR = path.join(process.cwd(), 'commands');
const CACHE_DIR = path.join(process.cwd(), 'data', 'remote-commands');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function fetchText(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${url}`)); });
    });
}

function loadLocalCommands() {
    const map = new Map();
    if (!fs.existsSync(LOCAL_DIR)) return map;
    for (const file of fs.readdirSync(LOCAL_DIR)) {
        if (!file.endsWith('.js')) continue;
        const full = path.join(LOCAL_DIR, file);
        try {
            delete require.cache[require.resolve(full)];
            const cmd = require(full);
            if (!cmd?.name || typeof cmd.run !== 'function') continue;
            map.set(cmd.name.toLowerCase(), cmd);
            if (Array.isArray(cmd.alias)) {
                for (const a of cmd.alias) map.set(String(a).toLowerCase(), cmd);
            }
        } catch (e) {
            console.log(`[ CMD LOADER ] Local ${file} failed: ${e.message}`);
        }
    }
    return map;
}

async function loadRemoteCommands() {
    const map = new Map();
    // Option 1: env REMOTE_COMMANDS_BASE = https://raw.githubusercontent.com/you/repo/main/commands/
    // Option 2: file data/remote-commands.json = { "sticker": "https://.../sticker.js", "play": "https://.../play.js" }
    // Option 3: env REMOTE_COMMANDS_URL = https://your-api.com/commands.json returns same map

    let remoteMap = {};
    const jsonPath = path.join(process.cwd(), 'data', 'remote-commands.json');
    const envUrl = process.env.REMOTE_COMMANDS_URL;
    const envBase = process.env.REMOTE_COMMANDS_BASE;

    if (envUrl) {
        try {
            console.log(`[ CMD LOADER ] Fetching remote map from ${envUrl}`);
            const txt = await fetchText(envUrl);
            remoteMap = JSON.parse(txt);
        } catch (e) {
            console.log(`[ CMD LOADER ] Remote map fetch failed: ${e.message}`);
        }
    } else if (fs.existsSync(jsonPath)) {
        try {
            remoteMap = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (e) {
            console.log(`[ CMD LOADER ] remote-commands.json parse failed: ${e.message}`);
        }
    } else if (envBase) {
        // If base provided, we can't know names — expect data/remote-commands.json to list names, or use local list?
        // For demo, try to fetch data/remote-list.json from base
        try {
            const listUrl = envBase.replace(/\/$/, '') + '/list.json';
            console.log(`[ CMD LOADER ] Fetching list from ${listUrl}`);
            const txt = await fetchText(listUrl);
            const names = JSON.parse(txt); // ["sticker","play"]
            if (Array.isArray(names)) {
                for (const n of names) remoteMap[n] = envBase.replace(/\/$/, '') + `/${n}.js`;
            }
        } catch (e) {
            console.log(`[ CMD LOADER ] Base list fetch failed: ${e.message}`);
        }
    }

    for (const [name, url] of Object.entries(remoteMap)) {
        if (String(name).startsWith('_')) continue; // ignore _comment
        const safeName = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!safeName) continue;
        const cachePath = path.join(CACHE_DIR, `${safeName}.js`);
        try {
            console.log(`[ CMD LOADER ] Fetching remote command ${safeName} from ${url}`);
            const code = await fetchText(url);
            // Basic safety: must contain module.exports
            if (!code.includes('module.exports') && !code.includes('exports.')) {
                console.log(`[ CMD LOADER ] Remote ${safeName} doesn't look like a command, skipping`);
                continue;
            }
            fs.writeFileSync(cachePath, code, 'utf8');
            delete require.cache[require.resolve(cachePath)];
            const cmd = require(cachePath);
            if (!cmd?.name || typeof cmd.run !== 'function') {
                console.log(`[ CMD LOADER ] Remote ${safeName} invalid format`);
                continue;
            }
            map.set(cmd.name.toLowerCase(), cmd);
            if (Array.isArray(cmd.alias)) {
                for (const a of cmd.alias) map.set(String(a).toLowerCase(), cmd);
            }
            console.log(`[ CMD LOADER ] Remote ${safeName} loaded`);
        } catch (e) {
            console.log(`[ CMD LOADER ] Remote ${safeName} failed: ${e.message}`);
            // Try cache fallback
            if (fs.existsSync(cachePath)) {
                try {
                    delete require.cache[require.resolve(cachePath)];
                    const cmd = require(cachePath);
                    if (cmd?.name) {
                        map.set(cmd.name.toLowerCase(), cmd);
                        console.log(`[ CMD LOADER ] Remote ${safeName} loaded from cache`);
                    }
                } catch (_) {}
            }
        }
    }

    return map;
}

async function loadCommands() {
    const local = loadLocalCommands();
    const remote = await loadRemoteCommands();
    // Remote overrides local if same name
    const merged = new Map([...local, ...remote]);
    console.log(`[ CMD LOADER ] Loaded ${local.size} local + ${remote.size} remote = ${merged.size} total (unique names with aliases)`);
    // Deduplicate to unique command objects
    const unique = new Map();
    for (const cmd of merged.values()) {
        if (!unique.has(cmd.name)) unique.set(cmd.name, cmd);
    }
    console.log(`[ CMD LOADER ] Unique commands: ${[...unique.keys()].join(', ')}`);
    return merged;
}

module.exports = { loadCommands, loadLocalCommands, loadRemoteCommands };
