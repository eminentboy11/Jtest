'use strict';
/**
 * Independent Web Edition — getsession
 * Returns the current bot's session as JTEST~<base64> (local, no external server)
 * This is a completely independent project — no June X family, no session server.
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'getsession',
  aliases: ['session', 'getsid'],
  category: 'owner',
  description: 'Get current bot session as independent JTEST~ base64 (local, no external server)',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const { from } = extra;
      // Try to read creds.json from current bot's session dir
      // Session dir is resolved via bot context — try common locations
      const possiblePaths = [
        path.join(process.cwd(), 'session', 'creds.json'),
        path.join(process.cwd(), 'sessions', 'default', 'creds.json'),
      ];
      
      // Also try to get from database if available
      let credsData = null;
      try {
        const database = require('../../database');
        // Try to get session from DB
        if (database.getSession) {
          const b64 = database.getSession();
          if (b64) {
            credsData = Buffer.from(b64, 'base64').toString('utf8');
          }
        }
      } catch (_) {}

      // Try file paths
      if (!credsData) {
        for (const p of possiblePaths) {
          try {
            if (fs.existsSync(p)) {
              credsData = fs.readFileSync(p, 'utf8');
              break;
            }
          } catch (_) {}
        }
      }

      if (!credsData) {
        return sock.sendMessage(from, { text: '❌ No local session found. Pair via web at / or with phone number.' }, { quoted: msg });
      }

      // Validate JSON
      try { JSON.parse(credsData); } catch (_) {
        return sock.sendMessage(from, { text: '❌ Session file exists but is invalid JSON.' }, { quoted: msg });
      }

      const base64 = Buffer.from(credsData, 'utf8').toString('base64');
      const sessionId = `JTEST~${base64}`;

      // For long sessions, we can't send full base64 in chat (too long), so we send info
      // If base64 is too long for WhatsApp ( > 6000 chars), we inform user to get from file system
      if (sessionId.length > 5000) {
        return sock.sendMessage(from, { 
          text: `✅ *Independent Session (Local)*\n\n` +
                `Your session is stored locally and is quite large (${sessionId.length} chars).\n` +
                `It's saved in your session folder and database — no external server needed.\n\n` +
                `To backup: copy the session folder or database file.\n` +
                `This is a fully independent project — no June X family dependency.` 
        }, { quoted: msg });
      }

      return sock.sendMessage(from, { 
        text: `✅ *Independent Session (Local)*\n\n` +
              `${sessionId}\n\n` +
              `> This is JTEST~ format — independent, local, no external server.\n` +
              `> Fully self-contained project — no June X family.`
      }, { quoted: msg });

    } catch (e) {
      console.log(`[GETSESSION] Error: ${e.message}`);
      return extra.reply(`❌ Failed to get session: ${e.message}`);
    }
  }
};
