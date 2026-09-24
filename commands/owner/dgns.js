/**
 * Owner-only, purpose-built real diagnostic runner for MEDIA-CMD.
 * Other categories are intentionally out of scope.
 */
const { runMediaDiagnostics, formatMediaReport } = require('../../utils/mediaDiagnostics');

module.exports = {
  name: 'dgns',
  category: 'owner',
  description: 'Run real, capture-only diagnostics for MEDIA-CMD',
  usage: '.dgns MEDIA-CMD',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const target = args.join(' ').trim().toUpperCase();
    if (target !== 'MEDIA-CMD') {
      return extra.reply('⚠️ Only `.dgns MEDIA-CMD` is available right now.');
    }

    if (global.__JUNE_MEDIA_DGNS_RUNNING) {
      return extra.reply('⏳ A MEDIA-CMD diagnostic run is already in progress.');
    }

    global.__JUNE_MEDIA_DGNS_RUNNING = true;
    try {
      await extra.reply('🧪 *DGNS — MEDIA-CMD*\nStarting sequential real API/execution checks. This can take several minutes; media output is captured, not sent.');
      const results = await runMediaDiagnostics(msg);
      return extra.reply(formatMediaReport(results));
    } catch (error) {
      console.error('[DGNS MEDIA-CMD]', error);
      return extra.reply(`❌ MEDIA-CMD diagnostic could not complete: ${error.message || error}`);
    } finally {
      global.__JUNE_MEDIA_DGNS_RUNNING = false;
    }
  },
};
