/**
 * .imenu — interactive mini-app menu card (BETA, parked under games).
 *
 * Sends the ENTIRE command list as a tappable in-chat card on the same
 * GenAI rich-response channel as .tetris: category chips, live search, and
 * tap-to-expand command details (description, usage, aliases).
 *
 * Deliberately SEPARATE from the classic .menu — this is a testing surface.
 * The list is built DYNAMICALLY from the command loader at send time, so it
 * always matches what the bot actually has loaded (no stale page to ship).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadCommands } = require('../../utils/commandLoader');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'help.html'), 'utf8');

function collectCommands() {
    const seen = new Set();
    const cats = {};
    for (const [, cmd] of (loadCommands() || new Map())) {
        if (!cmd || !cmd.name || seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        const cat = String(cmd.category || 'other').toLowerCase();
        (cats[cat] = cats[cat] || []).push({
            n: cmd.name,
            a: Array.isArray(cmd.aliases) ? cmd.aliases.slice(0, 4) : [],
            d: String(cmd.description || '').slice(0, 90),
            u: String(cmd.usage || `.${cmd.name}`).slice(0, 40),
        });
    }
    const out = {};
    for (const cat of Object.keys(cats).sort()) {
        out[cat] = cats[cat].sort((x, y) => x.n.localeCompare(y.n));
    }
    return out;
}

function buildHtml(data, prefix) {
    const json = JSON.stringify({ prefix, cats: data }).replace(/</g, '\\u003c');
    return TEMPLATE.replace('__MENUDATA__', json);
}

module.exports = {
    name: 'help',
    aliases: ['help'],
    category: 'games',
    description: 'BETA interactive menu card — tappable command list (mini-app)',
    usage: '.help',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            const prefix = extra.prefix || '.';
            await sendRichApp(sock, msg, buildHtml(collectCommands(), prefix), chatId);
        } catch (error) {
            console.error('[help] command unavailable:', error.message);
            await sock.sendMessage(chatId, { text: RICH_FALLBACK('MINI MENU') }, { quoted: msg }).catch(() => {});
        }
    }
};
