/**
 * Set Timezone — persists via database/bot-settings.json
 */
const db = require('../../database');

const COMMON_TIMEZONES = [
  'Africa/Nairobi', 'Africa/Lagos', 'Africa/Cairo', 'Africa/Johannesburg',
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Jakarta',
  'Asia/Singapore', 'Asia/Manila', 'Asia/Karachi', 'Asia/Dhaka',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland'
];

module.exports = {
  name: 'settimezone',
  aliases: ['settz', 'timezone'],
  category: 'owner',
  description: 'Set bot timezone for time display',
  usage: '.settimezone <timezone>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      if (!args.length || args[0].toLowerCase() === 'list') {
        let text = `🌍 *Set Timezone*\n\n` +
          `🕐 Active now: *${db.getTimeZone()}* _(${db.getTimeZoneSource()})_\n` +
          `💾 Saved setting: *${db.getBotSetting('timezone') || 'not set'}*\n\n`;
        text += `*Common Timezones:*\n`;
        COMMON_TIMEZONES.forEach(tz => {
          const marker = tz === db.getBotSetting('timezone') ? ' ✅' : '';
          try {
            const time = new Date().toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true });
            text += `• ${tz} — ${time}${marker}\n`;
          } catch {
            text += `• ${tz}${marker}\n`;
          }
        });
        text += `\nUsage: *${db.getBotSetting('prefix')}settimezone Asia/Kolkata*\nOr: *${db.getBotSetting('prefix')}settimezone auto* → detect from phone number`;
        return extra.reply(text);
      }

      const newTz = args.join(' ').trim();

      if (newTz.toLowerCase() === 'auto') {
        db.setBotSetting('timezone', 'auto');
        const tz = db.getTimeZone();
        const src = db.getTimeZoneSource();
        const how = src === 'auto:owner' ? '📱 owner number'
          : src === 'auto:paired' ? '📱 paired number'
          : src === 'env' ? '🌍 TIMEZONE env'
          : '📦 bot default';
        return extra.reply(
          `🔄 *Timezone: AUTO*\n\n` +
          `🌍 Detected: *${tz}* — from ${how}\n\n` +
          `_Times follow the phone number's country (owner number first, then the paired number)._\n` +
          `_Change your number with .setownernumber — the timezone follows instantly, no restart._\n` +
          `_Lock a fixed zone anytime with .settimezone <zone>._`
        );
      }

      try {
        new Date().toLocaleString('en-US', { timeZone: newTz });
      } catch {
        return extra.reply(`❌ Invalid timezone: *${newTz}*\n\nUse *${db.getBotSetting('prefix')}settimezone list* to see valid options.`);
      }

      // Persist to database and update runtime config
      db.setBotSetting('timezone', newTz);

      const now = new Date().toLocaleString('en-US', { timeZone: newTz, dateStyle: 'full', timeStyle: 'long' });
      await extra.reply(`✅ Timezone set to: *${newTz}*\n\n🕐 Current time: ${now}`);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
