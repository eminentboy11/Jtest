module.exports = {
    name: 'help',
    alias: ['menu', 'h'],
    desc: 'Show help',
    async run(sock, msg, args, { bot, commands }) {
        const jid = msg.key.remoteJid;
        const list = [...commands.values()].map(c => `• .${c.name} — ${c.desc || ''}`).join('\n');
        await sock.sendMessage(jid, { text: `JTEST WEB LITE — ${bot.id}\nConnected as +${bot.accountNumber}\n\n${list}\n\nMode: velvet-sparrow • ${commands.size} commands` });
    }
};
