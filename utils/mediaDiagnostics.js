/**
 * MEDIA-CMD real diagnostic runner.
 *
 * This module is deliberately limited to the existing `media` command
 * category. It calls each command's own execute() function with real fixtures
 * and a capture-only socket: APIs, scrapers, downloads, parsing and command
 * logic all run normally, but command media/messages are retained in memory
 * instead of flooding the owner's chat.
 */
'use strict';

const { EventEmitter } = require('events');
const axios = require('axios');
const { loadCommands } = require('./commandLoader');

const DEFAULT_TIMEOUT_MS = Math.max(15_000, Math.min(180_000, Number(process.env.JUNE_DGNS_MEDIA_TIMEOUT_MS) || 90_000));
const CHAT_JID = 'media-diagnostic@s.whatsapp.net';
const TEST_QUERY = 'Rick Astley Never Gonna Give You Up';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Fixtures are intentionally separate from command implementations. URL-based
// services change frequently, so a deployment owner can replace a stale public
// fixture through its panel without changing bot code.
const MEDIA_FIXTURES = Object.freeze({
  facebook:  () => process.env.JUNE_DGNS_FACEBOOK_URL || 'https://www.facebook.com/watch/?v=10153231379946729',
  igs:       () => process.env.JUNE_DGNS_INSTAGRAM_URL || 'https://www.instagram.com/reel/Cx6p9q5P7qI/',
  igsc:      () => process.env.JUNE_DGNS_INSTAGRAM_URL || 'https://www.instagram.com/reel/Cx6p9q5P7qI/',
  instagram: () => process.env.JUNE_DGNS_INSTAGRAM_URL || 'https://www.instagram.com/reel/Cx6p9q5P7qI/',
  lyrics:    () => process.env.JUNE_DGNS_LYRICS_QUERY || TEST_QUERY,
  pinterest: () => process.env.JUNE_DGNS_PINTEREST_URL || 'https://in.pinterest.com/pin/1109363320773690068/',
  play:      () => process.env.JUNE_DGNS_YOUTUBE_QUERY || TEST_QUERY,
  play2:     () => process.env.JUNE_DGNS_YOUTUBE_QUERY || TEST_QUERY,
  shazam:    () => process.env.JUNE_DGNS_SHAZAM_QUERY || TEST_QUERY,
  soundcloud: () => process.env.JUNE_DGNS_SOUNDCLOUD_URL || 'https://soundcloud.com/alanwalker/faded',
  spotify:   () => process.env.JUNE_DGNS_SPOTIFY_QUERY || 'Alan Walker Faded',
  spotify2:  () => process.env.JUNE_DGNS_SPOTIFY_QUERY || 'Alan Walker Faded',
  tiktok2:   () => process.env.JUNE_DGNS_TIKTOK_URL || 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
  tt:        () => process.env.JUNE_DGNS_TIKTOK_URL || 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
  twitter:   () => process.env.JUNE_DGNS_TWITTER_URL || 'https://x.com/SpaceX/status/1884633239926157752',
  ytvideo:   () => process.env.JUNE_DGNS_YOUTUBE_URL || YOUTUBE_URL,
  video2:    () => process.env.JUNE_DGNS_YOUTUBE_QUERY || TEST_QUERY,
  video3:    () => process.env.JUNE_DGNS_YOUTUBE_QUERY || TEST_QUERY,
  ytsearch:  () => process.env.JUNE_DGNS_YOUTUBE_QUERY || TEST_QUERY,
  // Adult/video-host fixtures have no suitable stable non-explicit default.
  // They run only when their owner supplies a deliberate panel fixture.
  snapchat:  () => process.env.JUNE_DGNS_SNAPCHAT_URL || '',
  porn:      () => process.env.JUNE_DGNS_PORN_INPUT || '',
  xvideos:   () => process.env.JUNE_DGNS_XVIDEOS_INPUT || '',
});

const INTERACTIVE_STEPS = Object.freeze({
  spotify: ['number'],
  spotify2: ['sptrack_', 'spfmt_'],
  soundcloud: ['scfmt_'], // direct SoundCloud URL fixture skips track search
  video2: ['video_'],
  twitter: ['tw_'],
});

function uniqueMediaCommands() {
  const byName = new Map();
  for (const command of loadCommands().values()) {
    if (command?.category === 'media' && command.name && !byName.has(command.name)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Diagnostic exceeded ${Math.ceil(ms / 1000)}s timeout`);
        error.code = 'DGNS_TIMEOUT';
        reject(error);
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function truncate(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstText(content) {
  return content?.text || content?.caption || content?.conversation || '';
}

function isFailureText(text) {
  return /(?:^|\s)(?:❌|🚫|error|failed|failure|invalid|unsupported|timed out|timeout|no (?:media|video|results?|download|downloadable)|cannot|could not)/i.test(String(text || ''));
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collectStrings(item, output));
  return output;
}

function mediaKind(content) {
  for (const key of ['audio', 'video', 'image', 'document', 'sticker']) {
    if (content?.[key]) return key;
  }
  return null;
}

function makeMessage(id, input, originalMessage) {
  const quoted = originalMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  return {
    key: { id, remoteJid: CHAT_JID, fromMe: false, participant: CHAT_JID },
    message: {
      conversation: input,
      ...(quoted ? {
        extendedTextMessage: {
          text: input,
          contextInfo: originalMessage.message.extendedTextMessage.contextInfo,
        },
      } : {}),
    },
  };
}

function makeCaptureSocket() {
  const ev = new EventEmitter();
  const sent = [];
  return {
    ev,
    sent,
    user: { id: CHAT_JID },
    async sendMessage(jid, content, options) {
      sent.push({ jid, content: content || {}, options: options || {}, at: Date.now() });
      return { key: { id: `DGNS-OUT-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async updateMediaMessage() { return null; },
  };
}

function axiosTrace() {
  const events = [];
  const fulfilled = axios.interceptors.response.use(response => {
    events.push({ ok: true, url: response.config?.url, status: response.status });
    return response;
  });
  const rejected = axios.interceptors.response.use(undefined, error => {
    events.push({
      ok: false,
      url: error.config?.url,
      status: error.response?.status || null,
      message: error.message,
    });
    return Promise.reject(error);
  });
  return {
    events,
    close() {
      axios.interceptors.response.eject(fulfilled);
      axios.interceptors.response.eject(rejected);
    },
  };
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(80);
  }
  return null;
}

function selectionMessage(id, text) {
  return {
    key: { id: `DGNS-SELECT-${Date.now()}`, remoteJid: CHAT_JID, fromMe: false, participant: CHAT_JID },
    message: {
      conversation: text === '1' ? '1' : undefined,
      interactiveResponseMessage: text === '1' ? undefined : {
        nativeFlowResponseMessage: { paramsJson: text },
      },
    },
  };
}

async function runInteractiveSteps(name, socket, deadline) {
  // Twitter may first show an item selector (multi-media tweets) and then a
  // format selector, or go straight to a format selector for a single item.
  if (name === 'twitter') {
    let sentIndex = 0;
    const first = await waitFor(() => {
      const strings = socket.sent.slice(sentIndex).flatMap(entry => collectStrings(entry.content));
      return strings.find(value => /tw_(?:item|vfmt|ifmt)_/.test(value));
    }, Math.min(15_000, Math.max(1000, deadline - Date.now())));
    if (!first) throw new Error('Selection UI did not provide a Twitter media option');
    sentIndex = socket.sent.length;
    socket.ev.emit('messages.upsert', { messages: [selectionMessage('dgns-twitter-1', first)] });
    if (first.includes('tw_item_')) {
      const format = await waitFor(() => {
        const strings = socket.sent.slice(sentIndex).flatMap(entry => collectStrings(entry.content));
        return strings.find(value => /tw_(?:vfmt|ifmt)_/.test(value));
      }, Math.min(15_000, Math.max(1000, deadline - Date.now())));
      if (!format) throw new Error('Twitter item selection did not provide a format option');
      socket.ev.emit('messages.upsert', { messages: [selectionMessage('dgns-twitter-2', format)] });
    }
    return;
  }

  const steps = INTERACTIVE_STEPS[name] || [];
  let sentIndex = 0;

  for (const step of steps) {
    const remaining = Math.max(1000, deadline - Date.now());
    let selected;
    if (step === 'number') {
      // spotify's original command deliberately expects a numeric reply.
      selected = '1';
      await delay(120);
    } else {
      selected = await waitFor(() => {
        const newStrings = socket.sent.slice(sentIndex).flatMap(entry => collectStrings(entry.content));
        return newStrings.find(value => value.includes(step));
      }, Math.min(15_000, remaining));
      if (!selected) throw new Error(`Selection UI did not provide ${step}`);
    }

    sentIndex = socket.sent.length;
    socket.ev.emit('messages.upsert', { messages: [selectionMessage(`dgns-${name}`, selected)] });
    await delay(180);
  }
}

function classifyResult(name, socket, trace, thrown) {
  const sent = socket.sent;
  const media = sent.map(entry => mediaKind(entry.content)).find(Boolean);
  const texts = sent.map(entry => firstText(entry.content)).filter(Boolean);
  const failure = [...texts].reverse().find(isFailureText);
  const httpFailure = [...trace.events].reverse().find(event => !event.ok);

  if (thrown?.code === 'DGNS_TIMEOUT') {
    return { status: 'timeout', stage: 'Timeout', reason: thrown.message };
  }
  if (thrown) {
    const status = thrown.response?.status || httpFailure?.status;
    return {
      status: 'failed',
      stage: status ? 'API request' : 'Command execution',
      reason: status ? `HTTP ${status} — ${truncate(thrown.message)}` : truncate(thrown.message || thrown),
    };
  }
  if (failure) {
    const status = httpFailure?.status;
    return {
      status: 'failed',
      stage: status ? 'API request' : (trace.events.length ? 'API response / parsing' : 'Command execution'),
      reason: status ? `HTTP ${status} — ${truncate(failure)}` : truncate(failure),
    };
  }
  if (media) return { status: 'passed', stage: 'Delivery prepared', reason: `${media} output captured` };

  // Search/display media commands legitimately complete with a real response
  // but no media attachment. A non-error text/button result is their success.
  if (texts.length || sent.some(entry => collectStrings(entry.content).some(text => /(?:sptrack_|scfmt_|tw_|video_)/.test(text)))) {
    return { status: 'passed', stage: 'API response', reason: 'successful response captured' };
  }
  return { status: 'failed', stage: 'Command execution', reason: 'Command completed without a success or error result' };
}

function quotedFixtureAvailable(name, originalMessage) {
  const quoted = originalMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return false;
  if (name === 'ptv') return Boolean(quoted.videoMessage);
  if (name === 'trim') return Boolean(quoted.audioMessage || quoted.videoMessage);
  return false;
}

async function runOne(command, originalMessage, timeoutMs) {
  const name = command.name;
  const fixtureFactory = MEDIA_FIXTURES[name];

  if ((name === 'ptv' || name === 'trim') && !quotedFixtureAvailable(name, originalMessage)) {
    return { name, status: 'skipped', stage: 'Input', reason: 'Reply to a WhatsApp video/audio when running .dgns MEDIA-CMD to test this command' };
  }

  const input = fixtureFactory ? fixtureFactory() : '';
  if (!input && name !== 'ptv' && name !== 'trim') {
    return { name, status: 'skipped', stage: 'Input', reason: 'No deliberate safe diagnostic fixture is configured' };
  }

  const socket = makeCaptureSocket();
  const trace = axiosTrace();
  const id = `DGNS-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const msg = makeMessage(id, input, originalMessage);
  const extra = {
    from: CHAT_JID,
    sender: CHAT_JID,
    prefix: '.',
    isOwner: true,
    isSudo: true,
    isMod: true,
    isGroup: false,
    quoted: originalMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage,
    reply: text => socket.sendMessage(CHAT_JID, { text }, { quoted: msg }),
    react: text => socket.sendMessage(CHAT_JID, { react: { text, key: msg.key } }),
  };

  const started = Date.now();
  let thrown = null;
  try {
    const deadline = started + timeoutMs;
    // trim needs real time arguments in addition to the quoted WhatsApp media
    // fixture supplied by the owner; its normal execution path remains intact.
    const commandArgs = name === 'trim' ? ['0:00', '0:01'] : (input ? input.split(/\s+/) : []);
    await withTimeout(command.execute(socket, msg, commandArgs, extra), timeoutMs);
    await runInteractiveSteps(name, socket, deadline);

    // Interactive handler callbacks are async EventEmitter listeners. Wait for
    // their real download/API path to emit a terminal output into the capture.
    if (INTERACTIVE_STEPS[name]?.length) {
      await waitFor(() => socket.sent.some(entry => mediaKind(entry.content) || isFailureText(firstText(entry.content))), Math.max(0, deadline - Date.now()));
    }
  } catch (error) {
    thrown = error;
  } finally {
    trace.close();
    socket.ev.removeAllListeners();
  }

  return {
    name,
    inputType: /https?:\/\//.test(input) ? 'URL' : input ? 'query' : 'quoted media',
    durationMs: Date.now() - started,
    ...classifyResult(name, socket, trace, thrown),
  };
}

async function runMediaDiagnostics(originalMessage, options = {}) {
  const timeoutMs = Math.max(15_000, Math.min(180_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const commands = uniqueMediaCommands();
  const results = [];
  for (const command of commands) {
    // Intentionally sequential: no parallel extractor/API flood.
    results.push(await runOne(command, originalMessage, timeoutMs));
  }
  return results;
}

function formatMediaReport(results) {
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, { passed: 0, failed: 0, timeout: 0, skipped: 0 });
  const tested = counts.passed + counts.failed + counts.timeout;
  const successRate = tested ? Math.round((counts.passed / tested) * 100) : 0;
  const icon = { passed: '✅', failed: '❌', timeout: '⏱️', skipped: '⚠️' };

  const lines = ['🧪 *DGNS — MEDIA-CMD*', '━━━━━━━━━━━━━━━━━━━━'];
  results.forEach((result, index) => {
    lines.push(`${String(index + 1).padStart(2, '0')}. ${icon[result.status]} *${result.name}*${result.status === 'passed' ? '' : ` — ${truncate(result.reason, 115)}`}`);
  });
  lines.push('━━━━━━━━━━━━━━━━━━━━', '📊 *FINAL RESULT*',
    `Tested: ${tested}/${results.length}  •  ✅ ${counts.passed}  ❌ ${counts.failed}  ⏱️ ${counts.timeout}  ⚠️ ${counts.skipped}`,
    `Success rate: ${successRate}%`);

  const problems = results.filter(result => result.status === 'failed' || result.status === 'timeout');
  if (problems.length) {
    lines.push('━━━━━━━━━━━━━━━━━━━━', '❌ *FAILED / TIMEOUT*');
    for (const result of problems) lines.push(`• *${result.name}* — ${result.stage}: ${truncate(result.reason, 150)}`);
  }
  const skipped = results.filter(result => result.status === 'skipped');
  if (skipped.length) {
    lines.push('━━━━━━━━━━━━━━━━━━━━', '⚠️ *SKIPPED*');
    for (const result of skipped) lines.push(`• *${result.name}* — ${truncate(result.reason, 130)}`);
  }
  return lines.join('\n').slice(0, 6500);
}

module.exports = { runMediaDiagnostics, formatMediaReport, MEDIA_FIXTURES };
