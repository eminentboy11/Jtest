// Example remote command — play (fetched via URL)
module.exports = {
    name: 'play',
    alias: ['song'],
    desc: 'Play song (remote URL example)',
    async run(sock, msg, args, { bot }) {
        const jid = msg.key.remoteJid;
        const query = args.join(' ');
        if (!query) return sock.sendMessage(jid, { text: 'Usage: .play <song name>\nExample: .play faded alan walker' });
        await sock.sendMessage(jid, { text: `🎵 Searching: ${query} — bot ${bot.id}\n(Remote command example — add ytdl logic here)` });
    }
};
