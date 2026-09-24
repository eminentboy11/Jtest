'use strict';
const { loadCommands, loadLocalCommands } = require('./commandLoaderLite');

let commands = new Map();
let uniqueCommands = new Map();

// Load local immediately (sync) so ping works even before async init
try {
    const local = loadLocalCommands();
    commands = new Map(local);
    uniqueCommands = new Map();
    for (const cmd of commands.values()) {
        if (!uniqueCommands.has(cmd.name)) uniqueCommands.set(cmd.name, cmd);
    }
    console.log(`[ HANDLER ] Local ${uniqueCommands.size} commands loaded sync: ${[...uniqueCommands.keys()].join(', ')}`);
} catch (e) {
    console.log('[ HANDLER ] Local sync load failed:', e.message);
}

async function init() {
    try {
        const loaded = await loadCommands();
        commands = loaded;
        uniqueCommands = new Map();
        for (const cmd of commands.values()) {
            if (!uniqueCommands.has(cmd.name)) uniqueCommands.set(cmd.name, cmd);
        }
        console.log(`[ HANDLER ] Mini handler ready — ${uniqueCommands.size} unique: ${[...uniqueCommands.keys()].join(', ')}`);
    } catch (e) {
        console.log('[ HANDLER ] Init failed, keeping local:', e.message);
    }
    return { commands, uniqueCommands };
}

function getCommands() { return commands; }
function getUniqueCommands() { return uniqueCommands; }

async function handleMessage(sock, msg, { bot }) {
    try {
        // Ensure commands loaded — if empty, try sync local again
        if (commands.size === 0) {
            try {
                const local = loadLocalCommands();
                commands = new Map(local);
                uniqueCommands = new Map();
                for (const cmd of commands.values()) {
                    if (!uniqueCommands.has(cmd.name)) uniqueCommands.set(cmd.name, cmd);
                }
            } catch (_) {}
        }

        const m = msg.message;
        if (!m) return;
        const text = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
        if (!text) return;

        const prefix = '.';
        const lower = text.toLowerCase();

        // Allow ping without prefix too (lite) — always work even if handler not fully ready
        if (lower === 'ping' || lower === 'alive' || lower === '.ping' || lower === '!.ping' || lower.startsWith('.ping ') || lower.startsWith('ping ')) {
            const cmd = commands.get('ping') || { run: async (sock, msg) => {
                await sock.sendMessage(msg.key.remoteJid, { text: `🔸 pong! ${bot.id} • lite • ${new Date().toLocaleTimeString()} • uptime ${Math.floor(process.uptime())}s` });
            }};
            console.log(`[ ${bot.id} ] CMD ping from ${msg.key.remoteJid} fromMe=${!!msg.key.fromMe}`);
            return cmd.run(sock, msg, [], { bot, commands: uniqueCommands });
        }

        if (!text.startsWith(prefix) && !text.startsWith('!')) return;

        const withoutPrefix = text.slice(1).trim();
        if (!withoutPrefix) return;
        const parts = withoutPrefix.split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const args = parts.slice(1);

        const cmd = commands.get(cmdName);
        if (!cmd) {
            if (cmdName === 'help' || cmdName === 'menu') {
                const helpCmd = commands.get('help');
                if (helpCmd) return helpCmd.run(sock, msg, args, { bot, commands: uniqueCommands });
            }
            return;
        }

        console.log(`[ ${bot.id} ] CMD ${cmd.name} from ${msg.key.remoteJid}`);
        await cmd.run(sock, msg, args, { bot, commands: uniqueCommands });
    } catch (e) {
        console.log(`[ HANDLER ] Error: ${e.message} ${e.stack?.slice(0,200)}`);
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
