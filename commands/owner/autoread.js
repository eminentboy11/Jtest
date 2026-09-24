const db = require('../../database');

const KEY = 'autoReadMode';
const MODES = ['off', 'pm', 'gc', 'all', 'contacts'];

const LABELS = {
    off: '❌ Auto-read: off',
    pm: '📩 Auto-read: pm',
    gc: '💬 Auto-read: gc',
    all: '✅ Auto-read: all',
    contacts: '👥 Auto-read: contacts',
};

const USAGE = 'Usage: .autoread <off|pm|gc|all|contacts>';

function currentMode() {
    const value = db.getBotSetting(KEY);
    return MODES.includes(value) ? value : 'off';
}

function shouldAutoRead(mode, msg, isContact = () => true) {
    if (!['all', 'contacts', 'pm', 'gc'].includes(mode)) return false;
    if (!msg || !msg.key || !msg.key.remoteJid) return false;
    const jid = String(msg.key.remoteJid);
    if (msg.key.fromMe) return false;
    if (jid === 'status@broadcast') return false;
    if (jid.endsWith('@newsletter')) return false;
    const isPrivate = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@broadcast');
    const isGroup = jid.endsWith('@g.us');
    if (mode === 'pm') return isPrivate;
    if (mode === 'gc') return isGroup;
    if (mode === 'all') return isPrivate || isGroup;
    const sender = isGroup ? (msg.key.participant || null) : jid;
    if (!sender) return false;
    return Boolean(isContact(sender));
}

async function readMessageIfEnabled(sock, msg) {
    try {
        const mode = currentMode();
        if (mode === 'off') return false;
        const contacts = sock?.contacts || {};
        const isContact = (jid) => {
            const bare = String(jid || '').split(':')[0];
            return Boolean(contacts[bare] || contacts[jid]);
        };
        if (!shouldAutoRead(mode, msg, isContact)) return false;
        await sock.readMessages([msg.key]);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    name: 'autoread',
    aliases: ['read', 'autoreadmsgs'],
    category: 'owner',
    description: 'Auto-read incoming messages (off / pm / gc / all / contacts)',
    usage: '.autoread <off | pm | gc | all | contacts>',
    ownerOnly: true,
    adminOnly: false,
    groupOnly: false,
    botAdminOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const opt = (args[0] || '').toLowerCase();

            if (!opt) {
                return extra.reply(`${LABELS[currentMode()]}\n${USAGE}`);
            }

            if (!MODES.includes(opt)) {
                return extra.reply(USAGE);
            }

            db.setBotSetting(KEY, opt);
            if (extra.react) await extra.react(opt === 'off' ? '❌' : '✅').catch(() => {});
            return extra.reply(LABELS[opt]);
        } catch (error) {
            console.error('[autoread]', error.message);
            if (extra.react) await extra.react('❌').catch(() => {});
            return extra.reply(`❌ ${error.message}`);
        }
    },

    shouldAutoRead,
    readMessageIfEnabled,
    currentMode,
};
