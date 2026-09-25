'use strict';

/**
 * .menu — live plain-text command menu.
 *
 * Features:
 * - Reads commands directly from the live command table
 * - Dynamically discovers categories
 * - Counts unique commands
 * - Supports `.menu [category]`
 * - SQLite bot settings
 * - Fake quoted contact
 * - Loading → completed state
 * - Uptime / memory / RAM / command count
 * - Dynamic platform detection
 * - Menu display toggles from SQLite
 * - Plain-text menu only (Style 2)
 * - Shows command names only
 */

const { loadCommands } = require('../../utils/commandLoader');
const { applyFont } = require('../../utils/fontConverter');
const os = require('os');
const db = require('../../database');
const detectPlatform = require('../../utils/platform');

// ─────────────────────────────────────────────────────────────
// Create fake contact for enhanced quoted replies
// ─────────────────────────────────────────────────────────────

function createFakeContact(msg) {
    const botName = db.getBotSetting('botName') || 'JUNE-X';
    const participantId = msg.key.participant || msg.key.remoteJid || '0';
    const cleanId = String(participantId).split(':')[0].split('@')[0] || '0';

    return {
        key: {
            participants: "0@s.whatsapp.net",
            remoteJid: "0@s.whatsapp.net",
            fromMe: false,
            id: "JUNEX" + Math.random().toString(36).substring(2, 12).toUpperCase()
        },
        message: {
            contactMessage: {
                displayName: botName,
                vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:${botName}\nitem1.TEL;waid=${cleanId}:${cleanId}\nitem1.X-ABLabel:Phone\nEND:VCARD`
            }
        },
        participant: "0@s.whatsapp.net"
    };
}

// ─────────────────────────────────────────────────────────────
// Detect hosting / operating platform
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// Format uptime
// ─────────────────────────────────────────────────────────────

function formatUptime() {
    const seconds = Math.floor(process.uptime());

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];

    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);

    parts.push(`${secs}s`);

    return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────
// Format memory
// ─────────────────────────────────────────────────────────────

function formatMemory(bytes) {
    if (bytes >= 1073741824) {
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    if (bytes >= 1048576) {
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }

    return `${(bytes / 1024).toFixed(0)} KB`;
}

// ─────────────────────────────────────────────────────────────
// RAM progress bar
// ─────────────────────────────────────────────────────────────

function progressBar(used, total, size = 10) {
    if (!total || total <= 0) {
        return '[░░░░░░░░░░] 0%';
    }

    const ratio = Math.max(
        0,
        Math.min(1, used / total)
    );

    const filled = Math.round(ratio * size);

    const bar =
        '█'.repeat(filled) +
        '░'.repeat(size - filled);

    return `[${bar}] ${Math.round(ratio * 100)}%`;
}

// ─────────────────────────────────────────────────────────────
// Read menu display settings
// ─────────────────────────────────────────────────────────────

function getMenuDisplaySettings() {
    const defaults = {
        showUptime: true,
        showMemory: true,
        showProgressBar: true,
        showPluginCount: true,
    };

    try {
        if (typeof db.getMenuSettings === 'function') {
            return {
                ...defaults,
                ...(db.getMenuSettings() || {}),
            };
        }
    } catch {
        // Keep defaults.
    }

    return defaults;
}

// ─────────────────────────────────────────────────────────────
// Build menu text
// ─────────────────────────────────────────────────────────────

function buildMenuText(cats, totalCount, speed, filter = '') {
    const botName =
        db.getBotSetting('botName') || 'JUNE-X';

    const prefix =
        db.getBotSetting('prefix') || '.';

    const ownerNames =
        typeof db.getOwnerNames === 'function'
            ? db.getOwnerNames()
            : 'Bot Owner';

    const ownerName =
        Array.isArray(ownerNames)
            ? ownerNames[0]
            : ownerNames;

    const safeOwner =
        ownerName || 'Bot Owner';

    // index.js computed this once at load; fall back only if a command runs
    // in a process that never went through index.js (tests, child tools).
    const platform = global.platform || detectPlatform();
    const uptime = formatUptime();

    const totalMemory = os.totalmem();
    const botMemory = process.memoryUsage().rss;
    const systemUsedMemory =
        totalMemory - os.freemem();

    const ping =
        Number.isInteger(speed)
            ? `${speed}`
            : Number(speed).toFixed(2);

    const settings = getMenuDisplaySettings();

    const readmore =
        String.fromCharCode(8206).repeat(6001);

    // ──────────────────────────────────────────
    // Header
    // ──────────────────────────────────────────

    let menu =
        `┏━━❐◈  ${botName} ◈\n`;

    menu +=
        `┃ ᴘʀᴇꜰɪx: [ ${prefix} ]\n`;

    menu +=
        `┃ ᴏᴡɴᴇʀ: ${safeOwner}\n`;

    menu +=
        `┃ ᴘʟᴀᴛꜰᴏʀᴍ: ${platform}\n`;

    menu +=
        `┃ ꜱᴘᴇᴇᴅ: ${ping} ms\n`;

    if (settings.showUptime) {
        menu +=
            `┃ ᴜᴘᴛɪᴍᴇ: ${uptime}\n`;
    }

    menu +=
        `┃ Vᴇʀꜱɪᴏɴ: v${db.VERSION}\n`;

    if (settings.showMemory) {
        menu +=
            `┃ ᴜꜱᴀɢᴇ: ${formatMemory(botMemory)} of ${formatMemory(totalMemory)}\n`;
    }

    if (settings.showProgressBar) {
        menu +=
            `┃ ʀᴀᴍ: ${progressBar(systemUsedMemory, totalMemory)}\n`;
    }

    if (settings.showPluginCount) {
        menu +=
            `┃ Cᴏᴍᴍᴀɴᴅꜱ: ${totalCount}\n`;
    }

    menu +=
        `┗❐◈${readmore}\n`;

    // ──────────────────────────────────────────
    // Dynamic categories
    // ──────────────────────────────────────────

    const allCategories =
        Object.keys(cats).sort((a, b) =>
            a.localeCompare(b)
        );

    const selectedCategories = filter
        ? allCategories.filter(
              category => category === filter
          )
        : allCategories;

    // ──────────────────────────────────────────
    // Invalid category
    // ──────────────────────────────────────────

    if (!selectedCategories.length) {
        menu +=
            `❌ No category "${filter}".\n\n`;

        menu +=
            `Available categories:\n`;

        menu +=
            allCategories.length
                ? allCategories
                      .map(
                          category =>
                              `• ${category}`
                      )
                      .join('\n')
                : 'None';

        return menu;
    }

    // ──────────────────────────────────────────
    // Commands
    // ──────────────────────────────────────────

    let sectionIndex = 0;

    for (const category of selectedCategories) {
        const commands =
            Array.isArray(cats[category])
                ? [...cats[category]]
                : [];

        commands.sort((a, b) =>
            String(a.name).localeCompare(
                String(b.name)
            )
        );

        if (!commands.length) continue;

        menu +=
            `┏━━❐◈  \`${category.toUpperCase()}-CMD\` ◈\n`;

        // ONLY COMMAND NAMES
        for (const cmd of commands) {
            menu +=
                `┃◈${prefix}${cmd.name}\n`;
        }

        menu +=
            `┗❐◈\n`;

        sectionIndex++;

        if (sectionIndex % 3 === 0) {
            menu +=
                `${readmore}\n`;
        } else {
            menu += '\n';
        }
    }

    menu +=
        `> ${botName}`;

    return menu;
}

// ─────────────────────────────────────────────────────────────
// Main command
// ─────────────────────────────────────────────────────────────

module.exports = {
    name: 'menu',

    aliases: [
        'commands',
        'cmds',
    ],

    category: 'general',

    description:
        'List every command this bot currently has loaded',

    usage:
        '.menu [category]',

    async execute(sock, msg, args, extra) {
        try {
            // ──────────────────────────────────────────
            // Load live commands
            // ──────────────────────────────────────────

            const table =
                loadCommands() || new Map();

            const seen = new Set();
            const cats = {};

            for (const [, cmd] of table) {
                if (!cmd?.name) continue;

                const commandName =
                    String(cmd.name).trim();

                if (!commandName) continue;

                if (seen.has(commandName)) continue;

                seen.add(commandName);

                const category =
                    String(
                        cmd.category || 'other'
                    )
                        .trim()
                        .toLowerCase();

                if (!cats[category]) {
                    cats[category] = [];
                }

                cats[category].push(cmd);
            }

            const totalCount = seen.size;

            // ──────────────────────────────────────────
            // Category filter
            // ──────────────────────────────────────────

            const filter =
                String(args?.[0] || '')
                    .trim()
                    .toLowerCase();

            // ──────────────────────────────────────────
            // Fake quoted contact
            // ──────────────────────────────────────────

            const fakeQuoted =
                createFakeContact(msg);

            const chatId =
                extra?.from ||
                msg?.key?.remoteJid;

            // ──────────────────────────────────────────
            // Loading message
            // ──────────────────────────────────────────

            const loadingMsg =
                await sock.sendMessage(
                    chatId,
                    {
                        text: applyFont(
                            '⏳ Loading....'
                        ),
                    },
                    {
                        quoted: fakeQuoted,
                    }
                );

            // ──────────────────────────────────────────
            // Completion message
            // ──────────────────────────────────────────

            const markDone = () =>
                sock
                    .sendMessage(
                        chatId,
                        {
                            text: applyFont(
                                `_${db.getBotSetting('botName') || 'JUNE-X'}..._`
                            ),
                            edit: loadingMsg.key,
                        }
                    )
                    .catch(() => {});

            // ──────────────────────────────────────────
            // Calculate response speed
            // ──────────────────────────────────────────

            const msgTimestamp =
                msg?.messageTimestamp
                    ? Number(msg.messageTimestamp) * 1000
                    : Date.now();

            const speedMs =
                Math.max(
                    0,
                    Date.now() - msgTimestamp
                );

            // ──────────────────────────────────────────
            // Build menu
            // ──────────────────────────────────────────

            const menuText =
                buildMenuText(
                    cats,
                    totalCount,
                    speedMs,
                    filter
                );

            const ownerNames =
                typeof db.getOwnerNames === 'function'
                    ? db.getOwnerNames()
                    : 'Bot Owner';

            const ownerName =
                Array.isArray(ownerNames)
                    ? ownerNames[0]
                    : ownerNames;

            const footer =
                `Powered by ${ownerName || 'Bot Owner'}`;

            const fullMenu =
                applyFont(menuText);

            // ──────────────────────────────────────────
            // STYLE 2 ONLY — PLAIN TEXT
            // ──────────────────────────────────────────

            await sock.sendMessage(
                chatId,
                {
                    text: fullMenu,
                    footer,
                    mentions: extra?.sender
                        ? [extra.sender]
                        : [],
                },
                {
                    quoted: fakeQuoted,
                }
            );

            // ──────────────────────────────────────────
            // Mark loading message as completed
            // ──────────────────────────────────────────

            await markDone();

        } catch (error) {
            console.error(
                'Menu error:',
                error
            );

            try {
                await extra?.reply?.(
                    `❌ Error: ${error.message}`
                );
            } catch {
                // Ignore secondary reply failure.
            }
        }
    },
};
