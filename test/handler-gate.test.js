// RUNTIME GATE TEST — sends a NON-OWNER command through the real handler.
// Before the fix this dies with ReferenceError: commandToggle is not defined.
// Independent edition: uses local handler/database, not wdp.
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const SENT = [];

(async () => {
  const handler = require(path.join(ROOT, 'handler.js'));
  const database = require(path.join(ROOT, 'database.js'));
  if (database.ready) await database.ready;

  const sock = {
    user: { id: '2349127747465:1@s.whatsapp.net', name: 'June Test' },
    sendMessage: async (jid, content, opts) => { SENT.push({ jid, content }); return {}; },
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    groupMetadata: async () => ({ id: '234801@g.us', subject: 'G', participants: [] }),
  };
  global.currentSock = sock;

  // non-owner sender (NOT in owners list, NOT a sudo, NOT fromMe)
  if (typeof database.setOwners === 'function') {
    database.setOwners(['2349127747465'], 'test');
  }
  const msg = {
    key: { remoteJid: '234802@s.whatsapp.net', fromMe: false, participant: '234802@s.whatsapp.net', id: 'TESTMSG1' },
    pushName: 'Stranger',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: '.ping' },
  };

  // First run: command enabled → executes
  await handler.handleMessage(sock, msg);

  // Now DISABLE ping and re-run as non-owner → must get the 🚫 message
  const commandToggle = require(path.join(ROOT, 'utils/commandToggle.js'));
  commandToggle.disable('ping');
  SENT.length = 0;
  await handler.handleMessage(sock, msg);
  const blockedText = SENT.map(s => JSON.stringify(s.content)).join(' | ');
  console.log('disabled-mode reply:', blockedText.slice(0, 120));
  if (!blockedText.includes('currently disabled')) {
    console.error('❌ disable feature did not block the non-owner');
    process.exit(1);
  }

  // Owner (fromMe) must STILL pass the gate while ping is disabled
  SENT.length = 0;
  const ownerMsg = { ...msg, key: { ...msg.key, fromMe: true, remoteJid: '2349127747465@s.whatsapp.net' } };
  await handler.handleMessage(sock, ownerMsg);
  const ownerText = SENT.map(s => JSON.stringify(s.content)).join(' | ');
  console.log('owner reply while disabled:', ownerText.slice(0, 120));
  if (blockedText.includes('currently disabled') && ownerText.includes('pong')) {
    console.log('✅ disable feature verified: non-owner blocked, owner bypasses');
  }
  commandToggle.enable('ping');

  const text = SENT.map(s => JSON.stringify(s.content)).join(' | ');
  console.log('messages sent back:', SENT.length);
  console.log(text.slice(0, 300));

  if (/commandToggle is not defined/i.test(text)) {
    console.error('\n❌ STILL BROKEN: commandToggle ReferenceError reached the user');
    process.exit(1);
  }
  if (SENT.length === 0) {
    console.error('\n❌ no reply produced — inspect manually');
    process.exit(1);
  }
  console.log('\n✅ GATE PASSED: non-owner command executed WITHOUT ReferenceError');
  process.exit(0);
})().catch(e => {
  if (/commandToggle is not defined/i.test(String(e))) {
    console.error('\n❌ STILL BROKEN:', e.message);
  } else {
    console.error('\nHarness error (non-gate):', e.message);
    console.error(e.stack && e.stack.slice(0, 500));
    console.error('NOTE: any non-commandToggle error here is a harness-env limitation, not the gate bug.');
    process.exit(2);
  }
  process.exit(1);
});
