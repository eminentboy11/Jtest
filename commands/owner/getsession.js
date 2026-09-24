/**
 * GetSession Command - Owner only
 * Shows the Session ID status. Raw session export was RETIRED — the
 * JUNE-X~ Session ID (from the pairing page) is the single official
 * session mechanism.
 */

const sessionServer = require('../../utils/juneDb/sessionServer');

module.exports = {
  name: 'getsession',
  aliases: ['sessionid', 'mysession', 'session'],
  category: 'owner',
  description: 'Show your Session ID status',
  usage: '.getsession',
  ownerOnly: true,
  adminOnly: false,
  groupOnly: false,
  botAdminOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      // The Session ID already lives in the bot's environment; never print
      // the raw value. Show a masked form plus a server reachability check.
      if (sessionServer.isTokenModeActive()) {
        const sessionId = sessionServer.getConfiguredToken();
        const redacted = sessionId.slice(0, 8) + '…' + sessionId.slice(-4);
        const fingerprint = sessionServer.sha256Hex(sessionId).slice(0, 8);
        const status = sessionServer.getStatus();

        let serverLine = '';
        try {
          const res = await fetch(`${sessionServer.getServerUrl()}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          serverLine = res.ok ? '\n📡 Server: reachable' : `\n📡 Server: HTTP ${res.status}`;
        } catch (error) {
          serverLine = `\n📡 Could not reach the session server: ${error.message}`;
        }

        return extra.reply(
          `╭━━『 *Session ID (active)* 』━━╮\n\n` +
          `🔑 Session ID: \`${redacted}\`\n` +
          `🔖 Fingerprint: \`${fingerprint}\`\n` +
          `🔗 Server: ${sessionServer.getServerUrl()}\n` +
          `📡 Status: ${status.authenticated ? 'loaded (active)' : 'configured'}` +
          `${serverLine}\n\n` +
          `📋 The full Session ID is in your bot's environment\n` +
          `(SESSION_ID).\n\n` +
          `⚠️ Lost it or suspect a leak? Re-pair at\n` +
          `${sessionServer.getServerUrl()}/pair and set the fresh Session ID.\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
        );
      }

      // ── No Session ID configured ─────────────────────────────────────────
      return extra.reply(
        '❌ *No Session ID configured.*\n\n' +
        `1️⃣ Pair at ${sessionServer.getServerUrl()}/pair\n` +
        '2️⃣ Copy your JUNE-X~ Session ID\n' +
        "3️⃣ Set it as SESSION_ID in this bot's .env\n" +
        '4️⃣ Restart the bot'
      );
    } catch (error) {
      console.log('GetSession command error:', error.message);
      await extra.reply(`❌ Failed to read session status: ${error.message}`);
    }
  }
};
