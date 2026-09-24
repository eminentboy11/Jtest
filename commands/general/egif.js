/**
 * Emoji GIF Sticker Command
 * Convert an emoji into an animated sticker (GIF-based)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const ffmpegPath = require('../../utils/ffmpegPath');
const axios = require('axios');
const webp = require('node-webpmux');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const database = require('../../database');

module.exports = {
  name: 'egif',
  aliases: ['emojisticker', 'emojigif', 'emosticker'],
  description: 'Convert emoji to animated sticker (GIF)',
  usage: '.egif <emoji>',
  category: 'general',

  async execute(sock, msg, args, extra) {
    const tmpDir = getTempDir();
    const tempInput = path.join(tmpDir, `emoji_${Date.now()}.gif`);
    const tempOutput = path.join(tmpDir, `emoji_${Date.now()}.webp`);
    const tempFiles = [tempInput, tempOutput];

    try {
      const q = args.join(' ').trim();

      if (!q) {
        return extra.reply('😂 Provide an emoji!\nExample: .egif 😂');
      }

      const emojiMatch = q.match(/([\p{Emoji_Presentation}|\p{Extended_Pictographic}])/u);
      if (!emojiMatch) {
        return extra.reply('❌ Please provide a valid emoji!');
      }

      const emoji = emojiMatch[0];
      const emojiCode = emoji.codePointAt(0).toString(16);
      const gifUrl = `https://fonts.gstatic.com/s/e/notoemoji/latest/${emojiCode}/512.gif`;

      // Fetch emoji GIF
      const response = await axios.get(gifUrl, {
        responseType: 'arraybuffer'
      });

      if (!response.data) {
        return extra.reply('❌ Failed to fetch emoji GIF!');
      }

      // Write GIF to temp file
      fs.writeFileSync(tempInput, response.data);

      // Convert GIF to animated WebP sticker
      const ffmpegCommand = `"${ffmpegPath()}" -i "${tempInput}" -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality 80 -compression_level 6 "${tempOutput}"`;

      await new Promise((resolve, reject) => {
        exec(ffmpegCommand, (error, stdout, stderr) => {
          if (error) {
            console.error('FFmpeg error:', error);
            console.error('FFmpeg stderr:', stderr);
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (!fs.existsSync(tempOutput)) {
        throw new Error('FFmpeg failed to create output file');
      }

      const outputStats = fs.statSync(tempOutput);
      if (outputStats.size === 0) {
        throw new Error('FFmpeg created empty output file');
      }

      // Read the WebP file
      let webpBuffer = fs.readFileSync(tempOutput);

      const finalSizeKB = webpBuffer.length / 1024;
      console.log(`Final emoji sticker size: ${Math.round(finalSizeKB)} KB`);

      if (finalSizeKB > 1000) {
        console.log(`⚠️ Warning: Sticker size (${Math.round(finalSizeKB)} KB) exceeds recommended limit but will be sent anyway`);
      }

      // Add metadata using webpmux
      const img = new webp.Image();
      await img.load(webpBuffer);

      const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': database.getBotSetting('packname') || 'June-X',
        'emojis': [emoji]
      };

      const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
      const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
      const exif = Buffer.concat([exifAttr, jsonBuffer]);
      exif.writeUIntLE(jsonBuffer.length, 14, 4);

      img.exif = exif;

      const finalBuffer = await img.save(null);

      // Send the sticker
      await sock.sendMessage(extra.from, {
        sticker: finalBuffer
      }, { quoted: msg });

    } catch (error) {
      console.error('Egif command error:', error);
      await extra.reply(`❌ Error: ${error.message}`);
    } finally {
      tempFiles.forEach(file => deleteTempFile(file));
    }
  }
};
