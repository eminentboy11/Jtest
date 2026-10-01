/**
 * Clean Command - Delete messages in group
 *
 * WHERE THE MESSAGE LIST COMES FROM
 * ----------------------------------
 * There is no message store in Jtest, and there never was: this command used to
 * pull `store.messages` out of `require('../../index')`, but index.js has no
 * `module.exports` at all, so `store` was `undefined` and every call threw
 * `Cannot read properties of undefined`. Requiring the entry point from a
 * command was wrong twice over — it is circular (index.js boots the bot that is
 * loading this file) and it made this the only command in the repo able to
 * reach index.js's `process.exit` sites.
 *
 * The real source is the antidelete replay cache — the bounded, per-bot KV
 * namespace `.antidelete` and `.snipe` already use:
 *
 *   KV namespace 'antidelete', key `msg:<chatId>|<messageId>`
 *   value { payload: { sender, timestamp, type, … }, storedAt }
 *
 * That is a capped window (JUNE_KV_MAX_PER_NS, default 500 entries per bot),
 * not full history, so this deletes the most recent messages it knows about.
 * Deleting further back than the cache holds is not possible — the copies no
 * longer exist. Note the cache is populated by antidelete's capture path, so
 * `.clean` is most useful on a bot where antidelete has been running.
 */

const database = require('../../database');

/** Everything the cache holds for one chat, newest first. */
function recentMessagesFor(chatId) {
  const all = database.getAllKV('antidelete') || {};
  const prefix = `msg:${chatId}|`;
  const out = [];

  for (const [key, record] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue;
    const messageId = key.slice(prefix.length);
    const payload = record && record.payload ? record.payload : {};
    out.push({
      messageId,
      sender: String(payload.sender || ''),
      timestamp: Number(payload.timestamp) || Number(record && record.storedAt) || 0,
    });
  }

  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/** Digits only, so an @lid and a phone jid for the same person can compare. */
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

module.exports = {
  name: 'clean',
  aliases: ['purge', 'clear'],
  category: 'admin',
  description: 'Clean messages (all or from specific user if replied)',
  usage: '.clean <number>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const count = parseInt(args[0]);
      if (!count || count < 1 || count > 100) {
        return extra.reply('❌ Please enter a valid number (1-100).');
      }

      const jid = extra.from;

      // Check if message is a reply
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;

      let candidates = recentMessagesFor(jid);
      if (!candidates.length) {
        return extra.reply(
          '❌ No stored messages found.\n\n' +
          '_The command reads the antidelete cache, which is capped and only ' +
          'fills while `.antidelete` is on._'
        );
      }

      // Mode: delete a specific user's messages, when this is a reply.
      if (quotedMsg && quotedParticipant) {
        const wanted = digitsOf(quotedParticipant);
        candidates = candidates.filter((c) => digitsOf(c.sender) === wanted);
        if (!candidates.length) {
          return extra.reply('❌ That user has no recent stored messages here.');
        }
      }

      const messagesToDelete = candidates.slice(0, count);

      // The bot's own number, so a message it sent is deleted with fromMe:true.
      const botNumber = digitsOf(sock.user?.id);

      let deleted = 0;
      for (const target of messagesToDelete) {
        try {
          const fromMe = botNumber && digitsOf(target.sender) === botNumber;
          await sock.sendMessage(jid, {
            delete: {
              remoteJid: jid,
              fromMe,
              id: target.messageId,
              // a participant is only meaningful for someone else's message
              ...(fromMe ? {} : { participant: target.sender }),
            },
          });
          deleted++;
          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 300));
        } catch (err) {
          console.error('[clean] delete error:', err.message);
        }
      }

      if (!deleted) {
        return extra.reply('❌ Nothing could be deleted — the messages may already be gone.');
      }
      return extra.reply(`🧹 Deleted ${deleted} message(s).`);

    } catch (e) {
      console.error('[clean cmd] error:', e);
      extra.reply('❌ Failed to clean messages.');
    }
  },
};
