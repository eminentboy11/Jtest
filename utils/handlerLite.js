/**
 * Mini handler — wdp-style but tiny
 * - Loads commands via commandLoaderLite (local + remote URL)
 * - Parses .command, !command, etc.
 * - No huge group caches, no anti-delete, just command routing
 */
'use strict';
const { loadCommands } = require('./commandLoaderLite');

let commands = new Map();
let uniqueCommands = new Map();

async function init() {
    commands = await loadCommands();
    // Build unique map for help
    uniqueCommands = new Map();
    for (const cmd of commands.values()) {
        if (!uniqueCommands.has(cmd.name)) uniqueCommands.set(cmd.name, cmd);
    }
    return { commands, uniqueCommands };
}

function getCommands() { return commands; }
function getUniqueCommands() { return uniqueCommands; }

async function handleMessage(sock, msg, { bot }) {
    try {
        const m = msg.message;
        if (!m) return;
        const text = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
        if (!text) return;

        const prefix = '.';
        if (!text.startsWith(prefix) && !text.startsWith('!')) {
            // Allow ping without prefix too (lite)
            const lower = text.toLowerCase();
            if (lower === 'ping' || lower === 'alive') {
                const cmd = commands.get('ping');
                if (cmd) return cmd.run(sock, msg, [], { bot, commands: uniqueCommands });
            }
            return;
        }

        const withoutPrefix = text.slice(1).trim();
        if (!withoutPrefix) return;
        const parts = withoutPrefix.split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const args = parts.slice(1);

        const cmd = commands.get(cmdName);
        if (!cmd) {
            // Unknown command — ignore or show help if .help
            return;
        }

        console.log(`[ ${bot.id} ] CMD ${cmd.name} from ${msg.key.remoteJid}`);
        await cmd.run(sock, msg, args, { bot, commands: uniqueCommands });
    } catch (e) {
        console.log(`[ HANDLER ] Error: ${e.message}`);
        try {
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${e.message}` });
        } catch (_) {}
    }
}

async function reload() {
    console.log('[ HANDLER ] Reloading commands...');
    return init();
}

module.exports = { init, handleMessage, getCommands, getUniqueCommands, reload };
