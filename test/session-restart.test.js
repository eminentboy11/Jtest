'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runInBot } = require('../utils/core/botContext');
const service = require('../platform/sessionService');
const restartCommand = require('../commands/owner/restart');
const { bootSessionsIndependently } = require('../utils/core/sessionBoot');

test('.restart reconnects only the current session and never exits the process', async () => {
  service._resetForTests();
  const botA = { id: 'bot-a', botState: 'connected', marker: 'A' };
  const botB = { id: 'bot-b', botState: 'connected', marker: 'B' };
  const bots = new Map([[botA.id, botA], [botB.id, botB]]);
  const reconnectCalls = [];
  const freshMessages = [];

  service.configure({
    provision: async () => ({ ok: false }),
    restorePersisted: async () => ({ ok: true, restored: 0 }),
    remove: async () => ({ ok: false }),
    stop: async () => ({ ok: false }),
    reconnect: async (id) => {
      reconnectCalls.push(id);
      const bot = bots.get(id);
      bot.marker = 'A-restarted';
      return {
        ok: true,
        id,
        connected: true,
        sock: { sendMessage: async (jid, content) => freshMessages.push({ jid, content }) },
      };
    },
    reconcile: async () => true,
    get: id => bots.get(id) || null,
    list: () => [...bots.values()],
    snapshot: () => [...bots.values()].map(bot => ({ id: bot.id, state: bot.botState })),
  });

  const replies = [];
  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => { exitCalled = true; throw new Error('process.exit must not run'); };
  try {
    await runInBot('bot-a', () => restartCommand.execute(
      {},
      { key: { remoteJid: 'chat@s.whatsapp.net' } },
      [],
      { from: 'chat@s.whatsapp.net', reply: async text => replies.push(text) }
    ));
  } finally {
    process.exit = originalExit;
  }

  assert.deepEqual(reconnectCalls, ['bot-a']);
  assert.equal(botA.marker, 'A-restarted');
  assert.equal(botB.marker, 'B');
  assert.equal(botB.botState, 'connected');
  assert.equal(exitCalled, false);
  assert.match(replies[0], /this session only/i);
  assert.match(freshMessages[0].content.text, /restarted successfully/i);
});

test('one failed persisted session does not prevent other sessions from booting', async () => {
  const bots = [
    { id: 'good-a', botState: 'connecting' },
    { id: 'bad', botState: 'connecting' },
    { id: 'good-b', botState: 'connecting' },
  ];
  const booted = [];
  await bootSessionsIndependently(bots, async bot => {
    if (bot.id === 'bad') throw new Error('invalid authentication');
    bot.botState = 'connected';
    booted.push(bot.id);
  });

  assert.deepEqual(booted.sort(), ['good-a', 'good-b']);
  assert.equal(bots[0].botState, 'connected');
  assert.equal(bots[1].botState, 'needs-login');
  assert.match(bots[1].lastError, /invalid authentication/);
  assert.equal(bots[2].botState, 'connected');
});
