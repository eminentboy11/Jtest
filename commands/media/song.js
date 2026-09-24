const yts = require('yt-search');
const APIs = require('../../utils/api');

module.exports = {
    name: 'play',
    aliases: ['song', 'yta'],
    category: 'media',
    description: 'Download audio from YouTube',
    usage: '.play <song name or URL>',

    async execute(sock, msg, args, extra) {
        try {
            const chatId = extra.from;
            const searchQuery = args.join(' ').trim();

            if (!searchQuery) {
                return await sock.sendMessage(chatId, {
                    text: '🎵 Please provide a song name or YouTube URL.'
                }, { quoted: msg });
            }

            await sock.sendMessage(chatId, {
                react: { text: '🎼', key: msg.key }
            });

            const isUrl = searchQuery.startsWith('http://') || searchQuery.startsWith('https://');
            let videoUrl = searchQuery;
            let title = searchQuery;

            // --- Metadata extraction (yts, best-effort) ---
            if (!isUrl) {
                const { videos } = await yts(searchQuery);
                if (!videos || videos.length === 0) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ No songs found for that search.'
                    }, { quoted: msg });
                }
                const found = videos[0];
                videoUrl = found.url;
                title = found.title;
            } else {
                try {
                    const ytId = (videoUrl.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/) || [])[1];
                    if (ytId) {
                        const result = await yts({ videoId: ytId });
                        if (result && result.title) {
                            title = result.title;
                        }
                    }
                } catch (e) {}
            }

            // --- Audio download ---
            // Tries each API in order, stops at first success
            const apiFns = [
                () => APIs.getIzumiDownloadByUrl(videoUrl),
                () => APIs.getEliteProTechDownloadByUrl(videoUrl),
                () => APIs.getIzumiDownloadByQuery(searchQuery),
            ];

            let audioData = null;
            for (const fn of apiFns) {
                try {
                    const result = await fn();
                    if (result && result.download) {
                        audioData = result;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!audioData || !audioData.download) {
                return await sock.sendMessage(chatId, {
                    text: '❌ Failed to fetch audio. Please try again later.'
                }, { quoted: msg });
            }

            // Use title from API if yts didn't find one
            const finalTitle = title || audioData.title || 'Unknown Title';
            const safeTitle = finalTitle.replace(/[^\w\s\-()]/g, '').trim() || 'audio';

            // --- Send title/status first ---
            await sock.sendMessage(chatId, {
                text: `_${finalTitle}_`
            });

            // --- Send as AUDIO (playable in-chat player) ---
            await sock.sendMessage(chatId, {
                audio: { url: audioData.download },
                mimetype: 'audio/mpeg',
                fileName: `${safeTitle}.mp3`,
                ptt: false
            }, { quoted: msg });

            // --- Send as DOCUMENT (downloadable file) ---
            await sock.sendMessage(chatId, {
                document: { url: audioData.download },
                mimetype: 'audio/mpeg',
                fileName: `${safeTitle}.mp3`
            }, { quoted: msg });

        } catch (error) {
            console.error('Error in play/song command:', error);
            await sock.sendMessage(msg.key.remoteJid, {
                text: '❌ Download failed. Please try again later.'
            }, { quoted: msg });
        }
    }
};
