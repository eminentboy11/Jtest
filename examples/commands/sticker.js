// Example remote command — sticker (fetched via URL)
module.exports = {
    name: 'sticker',
    alias: ['s'],
    desc: 'Make sticker from image (remote URL example)',
    async run(sock, msg, args, { bot }) {
        const jid = msg.key.remoteJid;
        await sock.sendMessage(jid, { text: `🎨 Sticker command (remote) — bot ${bot.id}\nThis is fetched from URL, not local file!\nSend image with caption .sticker` });
    }
};
