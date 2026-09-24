module.exports = {
    name: 'ping',
    alias: ['alive', 'p'],
    desc: 'Check bot alive',
    async run(sock, msg, args, { bot }) {
        const jid = msg.key.remoteJid;
        await sock.sendMessage(jid, { text: `🔸 pong! ${bot.id} • lite • ${new Date().toLocaleTimeString()} • uptime ${Math.floor(process.uptime())}s` });
    }
};
