'use strict';

/** Boot every registered session independently; one failure never blocks peers. */
async function bootSessionsIndependently(bots, boot, onFailure = () => {}) {
  const list = Array.isArray(bots) ? bots : [];
  return Promise.allSettled(list.map(async bot => {
    try {
      await boot(bot);
      return { id: bot.id, ok: true };
    } catch (error) {
      bot.lastError = String(error?.message || error);
      bot.botState = 'needs-login';
      try { onFailure(bot, error); } catch (_) {}
      return { id: bot.id, ok: false, error: bot.lastError };
    }
  }));
}

module.exports = { bootSessionsIndependently };
