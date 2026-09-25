/**
 * JuneX Ultra Chatbot — fresh build.
 * architecture (public-facing AI assistant for
 * groups + DMs) and adapted to the June X Ultra runtime (CommonJS, Baileys,
 * SQLite-backed database, June X api.js / helpers.js).
 *
 * Features carried over from W.O.L.F:
 *   • Multi-turn conversation memory (last 20 messages, 24h expiry)
 *   • Intent detection — recognizes "play a song", "make an image", etc. and
 *     executes the matching bot command automatically
 *   • Pending-action flow — vague requests ("play something") ask for a target
 *     and wait for the follow-up (2-minute timeout)
 *   • Automatic fallback through the registered AI models in priority order
 *   • Full identity scrubbing (GPT / Claude / Gemini → bot name) so the bot
 *     always identifies as JuneX (no leaked model/company names)
 *   • Multimodal image analysis (NVIDIA Nemotron VL) + image generation
 *     (NVIDIA FLUX with a free Pollinations fallback)
 *   • Per-group user filters (allow-only / block-user), group & DM whitelists,
 *     usage statistics
 *
 * Config:  data/chatbot/chatbot_config_<botId>.json
 * History: data/chatbot/conversations/<botId>/<userId>.json
 * Profiles: persisted in the June X SQLite database (chat_profiles table).
 */

'use strict';
const { getOpenRouterApiKey } = require('../../utils/juneDb/orap.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { normalizeMessageContent, jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');

const database = require('../../database');
const APIs = require('../../utils/api');
const {
  AI_MODELS,
  MODEL_PRIORITY,
} = require('../../utils/helpers');
const { loadProfile, saveProfile, learnFromMessage, buildProfileContext, getPersonalizedGreeting } = require('../../database');
const getjid = require('../owner/getjid');
const resolveJid = getjid.resolveJid || getjid;

// ── Bot identity (June X Ultra) ──────────────────────────────
const EMOTE = '🤖';
function defaultBotName() {
  return database.getBotSetting('botName') || 'JuneX';
}
function defaultTechName() {
  const owner = (Array.isArray(database.getOwnerNames()) && database.getOwnerNames()[0]) || '';
  return owner || 'JUNE X TECH';
}

// ── Data directory paths ──────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data', 'chatbot');

const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

const _lgCache = new Map();
const _LG_MAX = 200;

// ── Target user / group filter helpers ────────────────────────────────────
async function _extractTargetUsers(sock, m, args) {
  const chatJid = m.key.remoteJid;
  const users = new Set();
  const mentions = (m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])
    .filter(j => j && !j.includes('status'));

  if (mentions.length > 0) {
    for (const jid of mentions) {
      try {
        const resolved = await resolveJid(sock, jid, chatJid);
        users.add(resolved);
      } catch { users.add(jid); }
    }
  } else {
    for (let i = 1; i < args.length; i++) {
      const num = String(args[i]).replace(/[^0-9]/g, '');
      if (num.length >= 7) users.add(`${num}@s.whatsapp.net`);
    }
  }
  return [...users];
}

// Returns false when the sender is blocked by the per-group user filter.
function _checkGroupUserFilter(cfg, groupJid, senderJid) {
  const filter = (cfg.groupUserFilters || {})[groupJid];
  if (!filter || !filter.users || filter.users.length === 0) return true;
  const senderNum = senderJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  const inList = filter.users.some(u => {
    const uNum = u.split('@')[0].split(':')[0].replace(/\D/g, '');
    return uNum === senderNum;
  });
  if (filter.mode === 'allow') return inList;
  if (filter.mode === 'block') return !inList;
  return true;
}

// ── Bot ID helpers ────────────────────────────────────────────────────────
function getBotId() {
  const ownerNum = (database.getOwners()?.[0] || '').replace(/[^0-9]/g, '');
  if (ownerNum) {
    const candidate = path.join(DATA_DIR, `chatbot_config_${ownerNum}.json`);
    if (fs.existsSync(candidate)) return ownerNum;
  }
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('chatbot_config_') && f.endsWith('.json'));
    if (files.length > 0) {
      return files[0].replace('chatbot_config_', '').replace('.json', '');
    }
  } catch {}
  return ownerNum || 'default';
}

function getConfigFile() {
  return path.join(DATA_DIR, `chatbot_config_${getBotId()}.json`);
}

function getConversationsDir() {
  return path.join(CONVERSATIONS_DIR, getBotId());
}

// ── Pending action management ─────────────────────────────────────────────
const pendingActions = new Map();
const PENDING_TIMEOUT = 120000; // 2 minutes

function pendingKey(senderJid, chatId) {
  return `${senderJid}::${chatId}`;
}
function setPendingAction(senderJid, chatId, actionType, command) {
  pendingActions.set(pendingKey(senderJid, chatId), { type: actionType, command, timestamp: Date.now() });
}
function getPendingAction(senderJid, chatId) {
  const key = pendingKey(senderJid, chatId);
  const entry = pendingActions.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PENDING_TIMEOUT) {
    pendingActions.delete(key);
    return null;
  }
  return entry;
}
function clearPendingAction(senderJid, chatId) {
  pendingActions.delete(pendingKey(senderJid, chatId));
}

const CANCEL_WORDS = ['cancel', 'nevermind', 'never mind', 'nvm', 'stop', 'nah', 'no', 'forget it', 'skip'];

// ── Config / conversation persistence (file-based) ────────────────────────
function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const convDir = getConversationsDir();
  if (!fs.existsSync(convDir)) fs.mkdirSync(convDir, { recursive: true });
}

function loadConfig() {
  ensureDataDirs();
  const defaults = {
    mode: 'off',
    preferredModel: 'nvidia-chat',
    chatbotName: defaultBotName(),
    techName: defaultTechName(),
    excludedGroups: [],
    allowedDMs: [],
    blockedDMs: [],
    groupUserFilters: {},
    stats: { totalQueries: 0, modelsUsed: {}, mediaActions: {} },
  };
  const file = getConfigFile();
  try {
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      const merged = { ...defaults, ...loaded, stats: { ...defaults.stats, ...(loaded.stats || {}) } };
      // The legacy default 'gpt' model points to dead endpoints; upgrade it to
      // the working NVIDIA provider so existing configs keep answering.
      if (merged.preferredModel === 'gpt') merged.preferredModel = 'nvidia-chat';
      return merged;
    }
  } catch {}
  return defaults;
}

function saveConfig(cfg) {
  ensureDataDirs();
  fs.writeFileSync(getConfigFile(), JSON.stringify(cfg, null, 2));
}

function getConversationFile(userId) {
  return path.join(getConversationsDir(), `${userId.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
}

function loadConversation(userId) {
  ensureDataDirs();
  const file = getConversationFile(userId);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const oneDay = 24 * 60 * 60 * 1000;
      if (Date.now() - (data.lastActive || 0) > oneDay) {
        return { messages: [], lastActive: Date.now(), model: null };
      }
      return data;
    }
  } catch {}
  return { messages: [], lastActive: Date.now(), model: null };
}

function saveConversation(userId, conversation) {
  ensureDataDirs();
  const file = getConversationFile(userId);
  conversation.lastActive = Date.now();
  if (conversation.messages.length > 40) {
    conversation.messages = conversation.messages.slice(-40);
  }
  fs.writeFileSync(file, JSON.stringify(conversation, null, 2));
}

function clearConversation(userId) {
  const file = getConversationFile(userId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── AI prompt builder + identity scrubbing ────────────────────────────────
function buildContextPrompt(conversation, newQuery, botName, userProfile = null, techName = null) {
  const n = botName || defaultBotName();
  const t = techName || defaultTechName();
  const profileCtx = userProfile ? buildProfileContext(userProfile) : '';

  let context = `You are ${n}, an elite AI assistant created by ${t}. Your name is ${n} and you must always identify yourself as ${n} when asked who you are. You are intelligent, witty, warm, and helpful. You have a distinct personality — friendly and sometimes a little humorous without being annoying. You remember conversation context and respond naturally like a real chat partner. Keep responses SHORT and CONCISE — aim for 2-3 sentences maximum unless the question genuinely requires more detail. Occasionally ask a follow-up question to keep the conversation flowing.\n\nCRITICAL IDENTITY RULES:\n- Your name is ${n}. Always refer to yourself as ${n}.\n- You were created by ${t}. Never say you were made by OpenAI, Google, Anthropic, Microsoft, Meta, xAI, or any other company.\n- Never reveal or mention any underlying AI model (GPT, Claude, Copilot, Grok, Bard, Blackbox, Perplexity, LLaMA, Gemini, NVIDIA, etc).\n- If asked what you are, say: "I'm ${n}, an AI assistant by ${t}."\n- Never say "As an AI language model" — instead say "As ${n}" if needed.\n- You are not ChatGPT, not Claude, not Bard, not Copilot. You are ${n}.\n\n`;

  if (profileCtx) context += profileCtx + '\n';

  if (conversation.messages.length > 0) {
    context += `Previous conversation:\n`;
    const recentMessages = conversation.messages.slice(-10);
    for (const m of recentMessages) {
      context += `${m.role === 'user' ? 'Human' : n}: ${m.content}\n`;
    }
    context += `\n`;
  }

  context += `Human: ${newQuery}\n${n}:`;
  return context;
}

// ── AI query engine ───────────────────────────────────────────────────────
// All text AI routes through NVIDIA (baked-in key in utils/api.js). The
// modelKey is used only as a label for which model was tried; every configured
// model resolves to the reliable NVIDIA provider so no config breaks.
//
// 2026-09-11: NVIDIA retired the previous default chat model
// (nemotron-nano-12b-v2-vl, EOL 2026-08-26 — every call returned HTTP 410 and
// the bot answered 'trouble connecting'). utils/api.js still defaults to the
// retired model (protected file — the owner's dev should update
// NVIDIA_DEFAULT_MODEL there), so every NVIDIA call below passes an explicit,
// current model. The omni successor is multimodal: it serves both the text
// path and the vision fallback below.
const NVIDIA_CHAT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

async function queryAI(modelKey, prompt, timeout = 35000, rawQuery = null) {
  if (!AI_MODELS[modelKey]) return null;
  try {
    const answer = await APIs.nvidiaChat(prompt, { model: NVIDIA_CHAT_MODEL, maxTokens: 700, timeoutMs: 90000 });
    if (answer && answer.trim().length >= 3) {
      // Reasoning-family models can emit <think>…</think> blocks; never show them.
      const cleaned = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (cleaned.length >= 3) return cleaned;
    }
  } catch (err) {
    console.error(`[Chatbot/NVIDIA/${modelKey}]`, err.message);
  }
  return null;
}

// ── OpenRouter vision (image understanding ONLY) ──────────────────────────
// Uses the free NVIDIA vision models routed through OpenRouter. Actives only
// when OPENROUTER_API_KEY is set; otherwise we fall back to NVIDIA directly.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_VISION_MODELS = [
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', key: 'nemotron-omni' },
  { id: 'nvidia/nemotron-nano-12b-v2-vl:free', key: 'nemotron-vl' },
];

async function askOpenRouterVision(prompt, imageBuffer) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const imageUrl = 'data:image/jpeg;base64,' + Buffer.from(imageBuffer).toString('base64');
  let lastError;
  for (const model of OPENROUTER_VISION_MODELS) {
    try {
      const resp = await axios.post(
        OPENROUTER_URL,
        {
          model: model.id,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://replit.com',
            'X-Title': process.env.OPENROUTER_APP_NAME || 'June_Ultra',
          },
          timeout: 90000,
        }
      );
      const content = resp.data?.choices?.[0]?.message?.content;
      if (content) {
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        if (text && text.trim().length >= 3) return { answer: text.trim(), model: model.key };
      }
      lastError = new Error('Empty response from ' + model.id);
    } catch (err) {
      lastError = err;
      console.error('[Chatbot/Vision] OpenRouter ' + model.id + ':', err.message);
    }
  }
  throw lastError || new Error('OpenRouter vision failed');
}

// The default vision prompt. We deliberately ask the model to TRANSCRIBE on-screen
// text first and only then describe, and to be honest about uncertainty instead
// of inventing scene details (free-tier vision models hallucinate badly on
// text-graphic / plain-color images).
const VISION_PROMPT =
  'Analyze this image. FIRST, transcribe all visible text exactly as written. ' +
  'THEN briefly describe the visual content (colors, layout, subjects). ' +
  'If you are not sure about something, say so explicitly. Do NOT invent objects, ' +
  'people, animals, or scenes that are not actually in the image. ' +
  'If the image is mostly text on a plain background, just transcribe it and note that.';

// Analyse an image: try OpenRouter when the key is set, else NVIDIA directly.
async function queryVision(prompt, imageBuffer) {
  const effectivePrompt = (prompt && prompt.trim() && prompt.length > 3)
    ? prompt.trim()
    : VISION_PROMPT;

  // 1) OpenRouter (image-only), if configured.
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const r = await askOpenRouterVision(effectivePrompt, imageBuffer);
      if (r?.answer) return r.answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    } catch (err) {
      console.error('[Chatbot/Vision] OpenRouter failed, falling back to NVIDIA:', err.message);
    }
  }
  // 2) NVIDIA Nemotron VL (key baked into utils/api.js) as the reliable default.
  try {
    const text = await APIs.nvidiaVision(
      effectivePrompt,
      imageBuffer,
      { model: NVIDIA_CHAT_MODEL, maxTokens: 1024, timeoutMs: 90000 }
    );
    return text ? text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : null;
  } catch (err) {
    console.error('[Chatbot/Vision]', err.message);
    return null;
  }
}

// Generate an image: try NVIDIA FLUX, then free Pollinations fallback.
// Returns a Buffer (ready to send) on success, or null on failure.
async function generateImage(prompt) {
  let buf = await APIs.nvidiaImage(prompt, { width: 1024, height: 1024, timeoutMs: 120000 });
  if (buf && buf.length > 0) return buf;
  buf = await APIs.pollinationsImage(prompt, { width: 1024, height: 1024, timeoutMs: 60000 });
  if (buf && buf.length > 0) return buf;
  return null;
}

// Try the preferred model, then walk MODEL_PRIORITY, then a bare GPT call.
async function getAIResponse(query, conversation, preferredModel = 'nvidia-chat', botName = null, userProfile = null, techName = null) {
  const contextPrompt = buildContextPrompt(conversation, query, botName, userProfile, techName);

  let result = await queryAI(preferredModel, contextPrompt, 35000, query);
  if (result) return { response: result, model: preferredModel };

  for (const modelKey of MODEL_PRIORITY) {
    if (modelKey === preferredModel) continue;
    result = await queryAI(modelKey, contextPrompt, 35000, query);
    if (result) return { response: result, model: modelKey };
  }

  result = await queryAI('nvidia-chat', query);
  if (result) return { response: result, model: 'nvidia-chat' };

  return null;
}

// ── Response cleaning + trimming ──────────────────────────────────────────
function cleanAIResponse(text, botName, techName) {
  if (!text) return '';
  const n = botName || defaultBotName();
  const nEscaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  text = text.replace(/\[\d+\]/g, '');
  text = text.replace(/Human:.*$/gm, '');
  text = text.replace(new RegExp(`^${nEscaped}:\\s*`, 'gim'), '');
  text = text.replace(/^(Assistant|AI|Bot|Claude|GPT|Grok|Copilot|Bard):\s*/gim, '');

  text = text.replace(/\b(ChatGPT|GPT-?[34o5]?|GPT|OpenAI)\b/gi, n);
  text = text.replace(/\b(Claude|Anthropic)\b/gi, n);
  text = text.replace(/\b(Copilot|Microsoft Copilot)\b/gi, n);
  text = text.replace(/\b(Google Bard|Bard|Gemini)\b/gi, n);
  text = text.replace(/\b(Grok|xAI)\b/gi, n);
  text = text.replace(/\b(Blackbox|Blackbox AI)\b/gi, n);
  text = text.replace(/\b(Perplexity|Perplexity AI)\b/gi, n);
  text = text.replace(/\b(LLaMA|Meta AI|Mistral)\b/gi, n);
  text = text.replace(/\bI'?m an? (?:large )?AI? ?(?:language )?model\b/gi, `I'm ${n}`);
  text = text.replace(/\bAs an? (?:large )?AI ?(?:language )?model\b/gi, `As ${n}`);
  text = text.replace(/\ba (?:large )?language model\b/gi, `${n}`);
  text = text.replace(/\bI'?m a (?:large )?language model\b/gi, `I'm ${n}`);
  const t = techName || defaultTechName();
  text = text.replace(/\bmade by (OpenAI|Google|Anthropic|Microsoft|Meta|xAI)\b/gi, `made by ${t}`);
  text = text.replace(/\bcreated by (OpenAI|Google|Anthropic|Microsoft|Meta|xAI)\b/gi, `created by ${t}`);
  text = text.replace(/\bdeveloped by (OpenAI|Google|Anthropic|Microsoft|Meta|xAI)\b/gi, `developed by ${t}`);
  text = text.replace(/\bbuilt by (OpenAI|Google|Anthropic|Microsoft|Meta|xAI)\b/gi, `built by ${t}`);
  text = text.replace(/\btrained by (OpenAI|Google|Anthropic|Microsoft|Meta|xAI)\b/gi, `trained by ${t}`);

  text = text.replace(new RegExp(`(${nEscaped}[\\s,]*){2,}`, 'g'), `${n} `);
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  return text.trim();
}

function trimResponse(text, maxChars = 700) {
  if (!text || text.length <= maxChars) return text;
  const chunk = text.slice(0, maxChars + 100);
  const sentenceEnd = /[.!?](?:\s|$)/g;
  let lastGoodCut = -1;
  let match;
  while ((match = sentenceEnd.exec(chunk)) !== null) {
    if (match.index + 1 <= maxChars) lastGoodCut = match.index + 1;
  }
  if (lastGoodCut > 50) return text.slice(0, lastGoodCut).trim() + ' _..._';
  const hardCut = text.slice(0, maxChars);
  const lastSpace = hardCut.lastIndexOf(' ');
  return (lastSpace > 50 ? hardCut.slice(0, lastSpace) : hardCut).trim() + ' _..._';
}

// ── Public config helpers (used by the ?chatbot command) ──────────────────
function getChatbotConfig() {
  return loadConfig();
}

// Returns true if the chatbot should respond in the given chat.
function isChatbotActiveForChat(chatId) {
  const cfg = loadConfig();
  if (cfg.mode === 'off') return false;

  const isGroup = chatId.endsWith('@g.us');
  const isDM = chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');

  const excludedGroups = cfg.excludedGroups || [];
  const allowedDMs = cfg.allowedDMs || [];

  if (isGroup) {
    if (cfg.mode === 'groups' || cfg.mode === 'on' || cfg.mode === 'both') {
      return !excludedGroups.includes(chatId);
    }
    return false;
  }

  if (isDM && allowedDMs.length > 0) {
    const normalized = chatId.split('@')[0].split(':')[0];
    let resolvedPhone = null;
    if (chatId.endsWith('@lid')) {
      const fromCache = global.lidPhoneCache?.get(normalized) || global.lidPhoneCache?.get(chatId);
      const fromGlobal = global.resolvePhoneFromLid?.(chatId);
      const raw = fromGlobal || fromCache;
      if (raw) resolvedPhone = String(raw).replace(/[^0-9]/g, '');
    }
    if (resolvedPhone || !chatId.endsWith('@lid')) {
      return allowedDMs.some(dm => {
        const normDM = dm.split('@')[0].split(':')[0];
        if (normDM === normalized) return true;
        if (resolvedPhone && normDM === resolvedPhone) return true;
        return false;
      });
    }
  }

  if (cfg.mode === 'on' || cfg.mode === 'both') return true;
  if (cfg.mode === 'groups' && isGroup) return true;
  if (cfg.mode === 'dms' && isDM) return true;

  return false;
}

// ── "Silent sock" proxy ────────────────────────────────────────────────────
function createSilentSock(sock, chatId, originalMsg) {
  const proxyHandler = {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return async (jid, content, options = {}) => {
          if (content.react) return target.sendMessage(jid, content, options);
          if (content.image || content.video || content.audio || content.document || content.sticker) {
            if (content.caption) content.caption = `${EMOTE} Here is your result!\n\n${content.caption}`;
            return target.sendMessage(jid, content, options);
          }
          if (content.edit) return { key: { id: 'suppressed' } };
          if (content.text && !content.image && !content.video && !content.audio) {
            return { key: { id: 'suppressed' } };
          }
          return target.sendMessage(jid, content, options);
        };
      }
      const val = target[prop];
      if (typeof val === 'function') return val.bind(target);
      return val;
    }
  };
  return new Proxy(sock, proxyHandler);
}

// ── Media command execution ────────────────────────────────────────────────
async function executeMediaCommand(sock, msg, commandName, query, commandsMap) {
  if (!commandsMap || !commandsMap.has(commandName)) return false;
  const command = commandsMap.get(commandName);
  if (!command || !command.execute) return false;

  try {
    const chatId = msg.key.remoteJid;
    const reaction = MEDIA_REACTIONS[commandName] || '⚡';
    await sock.sendMessage(chatId, { react: { text: reaction, key: msg.key } });

    const prefix = '.';
    const args = query.split(/\s+/).filter(Boolean);
    const fakeMsg = {
      ...msg,
      message: {
        conversation: `${prefix}${commandName} ${query}`,
        extendedTextMessage: { text: `${prefix}${commandName} ${query}` }
      }
    };

    const silentSock = createSilentSock(sock, chatId, msg);
    // June X commands expect `execute(sock, msg, args, extra)`, where extra
    // carries from/sender/prefix. Provide a minimal but sufficient extra.
    await command.execute(silentSock, fakeMsg, args, {
      from: chatId,
      sender: msg.key.participant || chatId,
      isGroup: chatId.endsWith('@g.us'),
      prefix,
      command: commandName,
      reply: (text) => silentSock.sendMessage(chatId, { text }, { quoted: msg }),
      react: (emoji) => silentSock.sendMessage(chatId, { react: { text: emoji, key: msg.key } })
    });

    await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
    return true;
  } catch (error) {
    console.error(`[Chatbot] Media command error (${commandName}):`, error.message);
    await sock.sendMessage(msg.key.remoteJid, { react: { text: '❌', key: msg.key } });
    return false;
  }
}

function trackMediaAction(intentType, cfg) {
  cfg.stats.totalQueries = (cfg.stats.totalQueries || 0) + 1;
  cfg.stats.mediaActions = cfg.stats.mediaActions || {};
  cfg.stats.mediaActions[intentType] = (cfg.stats.mediaActions[intentType] || 0) + 1;
  saveConfig(cfg);
}

// ── Intent detection ──────────────────────────────────────────────────────
const MEDIA_REACTIONS = {
  imagine: '🎨',
  play: '🎵',
  video: '🎬',
  song: '🎶'
};

const MEDIA_PROMPTS = {
  image: { ask: `Sure! Describe the image you'd like me to generate 🎨`, confirm: `Got it! Let me create that for you... 🎨` },
  playAudio: { ask: `Of course! What song or music would you like me to play? 🎵`, confirm: `Great choice! Let me find that for you... 🎵` },
  playVideo: { ask: `Sure thing! What video would you like me to find? 🎬`, confirm: `On it! Finding that video for you... 🎬` },
  song: { ask: `Sure! Which song would you like me to download? 🎶`, confirm: `Alright! Downloading that for you... 🎶` }
};

const INTENT_PATTERNS = {
  image: {
    vaguePatterns: [
      /^(?:can you |could you |bot,?\s+)?(?:generate|create|make|draw|design|paint|sketch)\s+(?:an?\s+)?(?:image|picture|photo|art|artwork|illustration|pic|img|drawing|painting)\s*\??$/i,
      /^(?:can you |could you |bot,?\s+)?(?:generate|create|make|draw|design)\s+(?:for me|something|an image|a picture)\s*\??$/i,
      /^(?:i want|i need|i'd like)\s+(?:an?\s+)?(?:image|picture|photo|art|drawing)\s*\.?$/i,
      /^(?:generate|create|make|draw)\s+(?:an?\s+)?(?:image|picture|photo)\s*\??$/i
    ],
    specificPatterns: [
      /^(?:generate|create|make|draw|design|paint|sketch)\s+(?:an?\s+)?(?:image|picture|photo|art|artwork|illustration|pic|img|drawing|painting)\s+(?:of|about|for|with|showing)\s+.{3,}/i,
      /^(?:generate|create|make|draw|design|paint|sketch)\s+(?:me\s+)?(?:an?\s+)?.{5,}/i,
      /(?:image|picture|photo|art|drawing|painting)\s+(?:of|about|for|with)\s+.{3,}/i,
      /^imagine\s+.{3,}/i,
      /^(?:can you |please |bot,?\s+)?(?:generate|create|make|draw|design)\s+(?:an?\s+)?(?:image|picture|photo)\s+(?:of|about|for|with|showing)\s+.{3,}/i
    ],
    extractQuery: (text) => {
      let query = text;
      query = query.replace(/^(?:can you |could you |please |bot,?\s+)?(?:generate|create|make|draw|design|paint|sketch)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|art|artwork|illustration|pic|img|drawing|painting)\s*(?:of|about|for|with|showing)?\s*/i, '');
      query = query.replace(/^imagine\s+/i, '');
      query = query.replace(/^(?:can you |could you |please |bot,?\s+)?(?:generate|create|make|draw|design|paint|sketch)\s+(?:me\s+)?(?:an?\s+)?/i, '');
      return query.trim();
    },
    command: 'imagine'
  },
  playAudio: {
    vaguePatterns: [
      /^(?:can you |could you |bot,?\s+)?(?:play|sing|find)\s+(?:a\s+)?(?:song|music|something|audio)\s*\??$/i,
      /^(?:play|sing)\s+(?:me\s+)?(?:something|a song|music)\s*\??$/i,
      /^(?:i want to (?:hear|listen to)|let me hear)\s+(?:a\s+)?(?:song|music|something)\s*\??$/i
    ],
    specificPatterns: [
      /^(?:play|sing|find me|put on|listen to)\s+(?:the\s+)?(?:song\s+)?(?!(?:a\s+)?(?:song|music|something|audio)\s*\??$).{3,}/i,
      /^(?:can you |please |bot,?\s+)?(?:play|sing|find me|put on)\s+(?!(?:a\s+)?(?:song|music|something)\s*\??$).{3,}/i,
      /^(?:play|download)\s+(?:me\s+)?(?:the\s+)?(?:song|music|audio|mp3)\s+.{3,}/i,
      /^(?:i want to (?:hear|listen)|let me hear|play me)\s+.{3,}/i
    ],
    extractQuery: (text) => {
      let query = text;
      query = query.replace(/^(?:can you |could you |please |bot,?\s+)?(?:play|sing|find me|put on|listen to|download)\s+(?:me\s+)?(?:the\s+)?(?:song|music|track|audio|mp3)?\s*/i, '');
      query = query.replace(/^(?:i want to (?:hear|listen)|let me hear|play me)\s+/i, '');
      query = query.replace(/\s+(?:on youtube|from youtube|for me|please)$/i, '');
      return query.trim();
    },
    command: 'play'
  },
  playVideo: {
    vaguePatterns: [
      /^(?:can you |could you |bot,?\s+)?(?:play|download|get|find|show)\s+(?:a\s+)?(?:video|vid|clip)\s*\??$/i,
      /^(?:i want to (?:watch|see)|let me (?:watch|see)|show me)\s+(?:a\s+)?(?:video|something)\s*\??$/i
    ],
    specificPatterns: [
      /^(?:play|download|get|find|show)\s+(?:the\s+)?(?:video|vid|clip|movie)\s+(?:of|about|for)?\s*.{3,}/i,
      /^(?:play|download|get|find|show)\s+(?:me\s+)?(?:the\s+)?video\s+.{3,}/i,
      /^(?:can you |please |bot,?\s+)?(?:play|download|get|show)\s+(?:the\s+)?(?:video|vid)\s+.{3,}/i,
      /^(?:i want to (?:watch|see)|let me (?:watch|see)|show me)\s+.{3,}/i,
      /^(?:play|download)\s+.{3,}\s+video$/i
    ],
    extractQuery: (text) => {
      let query = text;
      query = query.replace(/^(?:can you |could you |please |bot,?\s+)?(?:play|download|get|find|show)\s+(?:me\s+)?(?:the\s+)?(?:video|vid|clip|movie)\s*(?:of|about|for)?\s*/i, '');
      query = query.replace(/^(?:i want to (?:watch|see)|let me (?:watch|see)|show me)\s+/i, '');
      query = query.replace(/\s+(?:video|vid|clip)$/i, '');
      query = query.replace(/\s+(?:on youtube|from youtube|for me|please)$/i, '');
      return query.trim();
    },
    command: 'video'
  },
  song: {
    vaguePatterns: [
      /^(?:can you |could you |bot,?\s+)?(?:download|get|send|give)\s+(?:me\s+)?(?:a\s+)?(?:song|music|audio)\s*\??$/i
    ],
    specificPatterns: [
      /^(?:download|get)\s+(?:the\s+)?(?:song|music|audio|mp3)\s+.{3,}/i,
      /^(?:send|give)\s+(?:me\s+)?(?:the\s+)?(?:song|music|audio)\s+.{3,}/i
    ],
    extractQuery: (text) => {
      let query = text;
      query = query.replace(/^(?:download|get|send|give)\s+(?:me\s+)?(?:the\s+)?(?:song|music|audio|mp3)\s*/i, '');
      query = query.replace(/\s+(?:for me|please)$/i, '');
      return query.trim();
    },
    command: 'song'
  }
};

function detectIntent(text) {
  const trimmed = text.trim();
  if (trimmed.length < 4) return null;
  for (const [intentKey, intent] of Object.entries(INTENT_PATTERNS)) {
    if (intentKey === 'playAudio') {
      const isVideo = INTENT_PATTERNS.playVideo.vaguePatterns.some(p => p.test(trimmed)) ||
                      INTENT_PATTERNS.playVideo.specificPatterns.some(p => p.test(trimmed));
      if (isVideo) continue;
    }
    for (const pattern of intent.vaguePatterns) {
      if (pattern.test(trimmed)) {
        return { type: intentKey, command: intent.command, query: '', vague: true };
      }
    }
    for (const pattern of intent.specificPatterns) {
      if (pattern.test(trimmed)) {
        const query = intent.extractQuery(trimmed);
        if (query && query.length >= 2) {
          return { type: intentKey, command: intent.command, query, vague: false };
        }
      }
    }
  }
  return null;
}

// ── Main message handler ──────────────────────────────────────────────────
// Called for every inbound message in a chat where the chatbot is active.
// Returns true if handled, false otherwise.
// ── Capability question detection + reply ─────────────────────────────────
const CAPABILITY_PHRASES = [
  'what can you do', 'what tools do you have', 'what tools can you use',
  'what are your tools', 'what are your capabilities', 'what features do you have',
  'list your tools', 'show your tools', 'show me what you can do',
  'what do you support', 'do you have tools', 'can you generate images',
  'can you play music', 'can you play songs', 'can you download music',
  'can you find videos', 'can you describe images', 'help me list your features',
  'what are you capable of', 'your capabilities',
];

// Returns true when the message is asking about the bot's capabilities.
function isCapabilityQuestion(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return false;
  if (/\b(?:can'?t|cannot|couldn'?t|didn'?t|doesn'?t|don'?t|not able)\b/.test(q)) return false;
  return CAPABILITY_PHRASES.some(p => q.includes(p));
}

// Build a grounded menu of what the bot can actually do (checks the commands
// map so it only lists things that genuinely exist).
function chatbotCapabilities(commandsMap) {
  const has = (name) => !!(commandsMap && commandsMap.get(name)?.execute);

  const actions = [];
  const actionLine = (label, example) => `• ${label} — \`${example}\``;

  if (has('imagine') || has('generate')) {
    actions.push({ label: 'Image generation', cmd: 'generate', example: 'generate an image of a sunset over Lagos' });
  }
  if (has('play')) {
    actions.push({ label: 'Music (find + send audio)', cmd: 'play', example: 'play Faded by Alan Walker' });
  }
  if (has('video')) {
    actions.push({ label: 'Videos (YouTube search)', cmd: 'video', example: 'find a video about Linux' });
  }
  if (has('song')) {
    actions.push({ label: 'Song downloads', cmd: 'song', example: 'download the song Believer' });
  }

  const lines = [
    `${EMOTE} *Here is what I can do*`,
    ``,
    `🧰 *Chat* — Chat naturally, remember recent conversations, and learn your preferences.`,
    `👁️ *Vision* — Analyze images and answer questions about them.`,
  ];

  if (actions.length) {
    lines.push(``, `*Command actions I can run for you:*`);
    for (const a of actions) lines.push(actionLine(a.label, a.example));
  }

  lines.push(``, `_Just say it naturally — e.g. "play Faded" or "generate an image of a wolf"._`);
  return lines.join('\n');
}

async function handleChatbotMessage(sock, msg, commandsMap) {
  const chatId = msg.key.remoteJid;
  const rawSender = msg.key.participant || chatId;
  const senderJid = jidNormalizedUser(rawSender);
  const botName = loadConfig().chatbotName || defaultBotName();

  // ── Per-group user filter gate ────────────────────────────────────────
  if (chatId.endsWith('@g.us')) {
    const _cfg = loadConfig();
    let _resolvedSender = senderJid;
    if (senderJid.endsWith('@lid')) {
      try { _resolvedSender = await resolveJid(sock, senderJid, chatId); } catch {}
    }
    if (!_checkGroupUserFilter(_cfg, chatId, _resolvedSender)) return false;
  }

  const normalized = normalizeMessageContent(msg.message);
  const textMsg = normalized?.conversation
    || normalized?.extendedTextMessage?.text
    || normalized?.imageMessage?.caption
    || normalized?.videoMessage?.caption
    || '';

  // ── Multimodal: image analysis ─────────────────────────────────────────
  const hasImage = !!(msg.message?.imageMessage || msg.message?.viewOnceMessageV2?.message?.imageMessage);
  if (hasImage) {
    const cfg = loadConfig();
    const techName = cfg.techName || defaultTechName();
    const caption = textMsg.trim() || VISION_PROMPT;
    const botId = getBotId();
    let profile = loadProfile(botId, senderJid);

    try {
      await sock.sendPresenceUpdate('composing', chatId);
      await sock.sendMessage(chatId, { react: { text: '👀', key: msg.key } });

      const imageBuffer = await downloadMediaMessage(msg, 'buffer', {});
      let visionReply = null;
      if (imageBuffer && imageBuffer.length > 0) {
        visionReply = await queryVision(caption, imageBuffer);
      }

      if (visionReply) {
        const cleaned = cleanAIResponse(visionReply, botName, techName);
        const trimmed = trimResponse(cleaned, 1000);
        const greeting = getPersonalizedGreeting(profile);
        const prefix = greeting ? `${greeting} ` : `${EMOTE} `;

        const conversation = loadConversation(senderJid);
        conversation.messages.push({ role: 'user', content: `[Image sent] ${caption}` });
        conversation.messages.push({ role: 'assistant', content: cleaned });
        saveConversation(senderJid, conversation);

        profile = learnFromMessage(caption, profile);
        saveProfile(botId, senderJid, profile);
        cfg.stats.totalQueries = (cfg.stats.totalQueries || 0) + 1;
        saveConfig(cfg);

        await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
        await sock.sendMessage(chatId, { text: `${prefix}${trimmed}` }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, {
          text: `${EMOTE} _I received your image but couldn't analyse it right now. Try again or add a caption describing what you'd like to know!_`
        }, { quoted: msg });
      }
    } catch (err) {
      console.error(`[${botName}] Vision error:`, err.message);
      await sock.sendMessage(chatId, { text: `${EMOTE} _Image analysis failed. Please try again._` }, { quoted: msg });
    }
    return true;
  }

  if (!textMsg || textMsg.trim().length < 2) return false;

  const userText = textMsg.trim();

  // Ignore messages that look like bot commands (prefix-triggered)
  if (userText.startsWith('.') || userText.startsWith('/') || userText.startsWith('!')) {
    clearPendingAction(senderJid, chatId);
    return false;
  }

  // ── Capability question — "what can you do?" ────────────────────────────
  // Intercept before hitting the AI so we reply with a grounded menu of the
  // bot's real abilities instead of a generic model answer.
  if (isCapabilityQuestion(userText)) {
    const replyText = chatbotCapabilities(commandsMap);
    await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
    return true;
  }

  // ── Pending action resolution ──────────────────────────────────────────
  const pending = getPendingAction(senderJid, chatId);
  if (pending && commandsMap) {
    clearPendingAction(senderJid, chatId);
    if (CANCEL_WORDS.includes(userText.toLowerCase()) || userText.length < 3) {
      await sock.sendMessage(chatId, { text: `${EMOTE} Alright, cancelled!` }, { quoted: msg });
      return true;
    }
    const executed = await executeMediaCommand(sock, msg, pending.command, userText, commandsMap);
    if (executed) {
      const cfg = loadConfig();
      trackMediaAction(pending.type, cfg);
      const conversation = loadConversation(senderJid);
      conversation.messages.push({ role: 'user', content: userText });
      conversation.messages.push({ role: 'assistant', content: `[Executed ${pending.command}: ${userText}]` });
      saveConversation(senderJid, conversation);
      return true;
    }
  }

  const cfg = loadConfig();
  const techName = cfg.techName || defaultTechName();
  const conversation = loadConversation(senderJid);
  const botId = getBotId();
  let profile = loadProfile(botId, senderJid);

  // ── Image generation (checked BEFORE detectIntent) ─────────────────────
  const imageGenPatterns = [
    /^(?:generate|create|make|draw|paint|design|render)\s+(?:me\s+)?(?:an?\s+)?(?:ai\s+)?(?:image|picture|photo|art|artwork|illustration|painting|wallpaper)\s+(?:of|showing|with|about)\s+(.+)/i,
    /^(?:generate|create|make|draw|paint)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|art|painting)\s+(.+)/i,
    /^imagine\s+(.+)/i,
    /^flux\s+(.+)/i,
    /^(?:nvidia\s+)?(?:flux|image)\s+(.+)/i,
    /^(?:generate|create)\s+(?:ai\s+)?(?:image|art)\s+(.+)/i,
  ];
  let imagePrompt = null;
  for (const pat of imageGenPatterns) {
    const m = userText.match(pat);
    if (m?.[1]?.trim().length > 3) { imagePrompt = m[1].trim(); break; }
  }

  if (imagePrompt) {
    try {
      await sock.sendPresenceUpdate('composing', chatId);
      await sock.sendMessage(chatId, { react: { text: '🎨', key: msg.key } });
      const imgBuf = await generateImage(imagePrompt);

      if (imgBuf) {
        await sock.sendMessage(chatId, {
          image: imgBuf,
          caption: `🎨 *${imagePrompt}*\n_Generated with NVIDIA FLUX Dev_`
        }, { quoted: msg });

        conversation.messages.push({ role: 'user', content: userText });
        conversation.messages.push({ role: 'assistant', content: `[Generated image: ${imagePrompt}]` });
        saveConversation(senderJid, conversation);
        profile = learnFromMessage(userText, profile);
        saveProfile(botId, senderJid, profile);

        cfg.stats.totalQueries = (cfg.stats.totalQueries || 0) + 1;
        cfg.stats.imagesCreated = (cfg.stats.imagesCreated || 0) + 1;
        saveConfig(cfg);

        await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
        return true;
      }
      await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
      await sock.sendMessage(chatId, { text: `${EMOTE} _Image generation failed. Try again in a moment._` }, { quoted: msg });
      return true;
    } catch (imgErr) {
      console.error(`[${botName}] Image gen error:`, imgErr.message);
      await sock.sendMessage(chatId, { text: `${EMOTE} _Image generation error: ${imgErr.message}_` }, { quoted: msg });
      return true;
    }
  }

  // ── Media intent detection (play/video/song — NOT image) ──────────────
  const intent = detectIntent(userText);
  if (intent && intent.type !== 'image' && commandsMap) {
    if (intent.vague) {
      setPendingAction(senderJid, chatId, intent.type, intent.command);
      const promptInfo = MEDIA_PROMPTS[intent.type];
      await sock.sendMessage(chatId, { text: `${EMOTE} ${promptInfo?.ask || 'Sure! What would you like?'}` }, { quoted: msg });
      conversation.messages.push({ role: 'user', content: userText });
      conversation.messages.push({ role: 'assistant', content: promptInfo?.ask || 'Sure! What would you like?' });
      saveConversation(senderJid, conversation);
      return true;
    }

    const executed = await executeMediaCommand(sock, msg, intent.command, intent.query, commandsMap);
    if (executed) {
      const cfg = loadConfig();
      trackMediaAction(intent.type, cfg);
      const conversation = loadConversation(senderJid);
      conversation.messages.push({ role: 'user', content: userText });
      conversation.messages.push({ role: 'assistant', content: `[Executed ${intent.command}: ${intent.query}]` });
      saveConversation(senderJid, conversation);
      return true;
    }
  }

  // ── AI text response ───────────────────────────────────────────────────
  try {
    await sock.sendPresenceUpdate('composing', chatId);

    const aiResult = await getAIResponse(userText, conversation, cfg.preferredModel || 'nvidia-chat', botName, profile, techName);

    if (!aiResult) {
      await sock.sendMessage(chatId, { text: `${EMOTE} _I'm having trouble connecting right now. Try again in a moment._` }, { quoted: msg });
      return true;
    }

    const cleanedResponse = cleanAIResponse(aiResult.response, botName, techName);
    const finalResponse = trimResponse(cleanedResponse);
    const greeting = getPersonalizedGreeting(profile);
    const prefix = greeting ? `${greeting} ` : `${EMOTE} `;

    conversation.messages.push({ role: 'user', content: userText });
    conversation.messages.push({ role: 'assistant', content: cleanedResponse });
    saveConversation(senderJid, conversation);

    profile = learnFromMessage(userText, profile);
    saveProfile(botId, senderJid, profile);

    cfg.stats.totalQueries = (cfg.stats.totalQueries || 0) + 1;
    cfg.stats.modelsUsed = cfg.stats.modelsUsed || {};
    cfg.stats.modelsUsed[aiResult.model] = (cfg.stats.modelsUsed[aiResult.model] || 0) + 1;
    saveConfig(cfg);

    await sock.sendMessage(chatId, { text: `${prefix}${finalResponse}` }, { quoted: msg });
    return true;
  } catch (error) {
    console.error(`[${botName}] Chat error:`, error.message);
    return false;
  }
}

// ── Status card / help menu builders (matches original June X UX) ──────────
async function getDashboardGroupCount(sock) {
  try {
    const fetched = await sock.groupFetchAllParticipating();
    return Object.keys(fetched || {}).length;
  } catch {
    return null;
  }
}

function buildStatusCard(cfg, prefix, groupCount) {
  const on = cfg.mode !== 'off';
  const modeLabel = on
    ? (cfg.mode === 'both' ? 'Both'
        : cfg.mode === 'groups' ? 'Groups'
          : cfg.mode === 'dms' ? 'DMs' : cfg.mode)
    : 'off';
  const modelLabel = String(cfg.preferredModel || 'nvidia-chat').toUpperCase();
  const name = cfg.chatbotName || 'June Ultra';
  const tech = cfg.techName || 'June_Ultra';

  return (
    '╭─⌈ ⚡ *' + name + ' Chatbot ⌋\n' +
    '│ Status: ' + (on ? '🟢 ON' : '🔴 OFF') + '\n' +
    '│ Mode: ' + modeLabel + '\n' +
    '│ Model: ' + modelLabel + '\n' +
    '│ Name: ' + name + '\n' +
    '│ Tech: ' + tech + '\n' +
    '│ Groups: ' + (groupCount === null ? 'Unavailable' : groupCount) + '\n' +
    '│ Excluded Groups: ' + (cfg.excludedGroups || []).length + '\n' +
    '│ Allowed DMs: ' + (cfg.allowedDMs || []).length + '\n' +
    '│ Blocked DMs: ' + (cfg.blockedDMs || []).length + '\n' +
    '│ Memory: 🟢 Enabled\n' +
    '╰─ Type `' + prefix + 'chatbot help` to view all commands.'
  );
}

function buildHelpMenu(cfg, prefix) {
  const on = cfg.mode !== 'off' ? '🟢 ON' : '🔴 OFF';
  const name = cfg.chatbotName || 'June Ultra';
  return (
    '╭─⌈ ⚡ *' + name + ' CHATBOT* ⌋\n' +
    '│ ' + on + '\n' +
    '│ 🎯 Mode: ' + cfg.mode + '\n' +
    '│ 🤖 Model: ' + (cfg.preferredModel || 'nvidia-chat') + '\n' +
    '│ 🏷️ Name: ' + name + '\n' +
    '│ 🏢 Tech: ' + (cfg.techName || 'June_Ultra') + '\n' +
    '├─⊷ *' + prefix + 'chatbot on*\n│  └⊷ Enable everywhere\n' +
    '├─⊷ *' + prefix + 'chatbot off*\n│  └⊷ Disable chatbot\n' +
    '├─⊷ *' + prefix + 'chatbot groups*\n│  └⊷ Groups only\n' +
    '├─⊷ *' + prefix + 'chatbot dms*\n│  └⊷ DMs only\n' +
    '├─⊷ *' + prefix + 'chatbot both*\n│  └⊷ All chats\n' +
    '├─⊷ *' + prefix + 'chatbot name <name>*\n│  └⊷ Set chatbot name\n' +
    '├─⊷ *' + prefix + 'chatbot techname <name>*\n│  └⊷ Set creator/tech name\n' +
    '├─⊷ *' + prefix + 'chatbot model*\n│  └⊷ Switch AI model\n' +
    '├─⊷ *' + prefix + 'chatbot stats*\n│  └⊷ View stats\n' +
    '├─⊷ *' + prefix + 'chatbot status*\n│  └⊷ View status card\n' +
    '├─⊷ *' + prefix + 'chatbot clear*\n│  └⊷ Reset history\n' +
    '├─⊷ *' + prefix + 'chatbot settings*\n│  └⊷ View config\n' +
    '├─⌈ 📋 *GROUP CONTROL* ⌋\n' +
    '├─⊷ *' + prefix + 'chatbot addgroup*\n│  └⊷ Re-enable this group\n' +
    '├─⊷ *' + prefix + 'chatbot removegroup [jid]*\n│  └⊷ Exclude this group\n' +
    '├─⊷ *' + prefix + 'chatbot listgroups*\n│  └⊷ List groups + status\n' +
    '├─⊷ *' + prefix + 'chatbot cleargroups*\n│  └⊷ Clear exclusions\n' +
    '├─⌈ 👤 *USER FILTER (per group)* ⌋\n' +
    '├─⊷ *' + prefix + 'chatbot allowonly @user*\n│  └⊷ Reply only to selected users\n' +
    '├─⊷ *' + prefix + 'chatbot blockuser @user*\n│  └⊷ Ignore selected users\n' +
    '├─⊷ *' + prefix + 'chatbot allowuser @user*\n│  └⊷ Add/unblock a user\n' +
    '├─⊷ *' + prefix + 'chatbot removeuser @user*\n│  └⊷ Remove user from filters\n' +
    '├─⊷ *' + prefix + 'chatbot listusers*\n│  └⊷ Show this group\'s filter\n' +
    '├─⊷ *' + prefix + 'chatbot clearusers*\n│  └⊷ Reply to everyone\n' +
    '├─⌈ 💬 *DM CONTROL* ⌋\n' +
    '├─⊷ *' + prefix + 'chatbot adddm <number>*\n│  └⊷ Add an allowed DM\n' +
    '├─⊷ *' + prefix + 'chatbot removedm <number>*\n│  └⊷ Remove an allowed DM\n' +
    '├─⊷ *' + prefix + 'chatbot blockdm <number>*\n│  └⊷ Block a DM user\n' +
    '├─⊷ *' + prefix + 'chatbot unblockdm <number>*\n│  └⊷ Unblock a DM user\n' +
    '├─⊷ *' + prefix + 'chatbot listdms*\n│  └⊷ List allowed DMs\n' +
    '├─⊷ *' + prefix + 'chatbot listbdms*\n│  └⊷ List blocked DMs\n' +
    '├─⊷ *' + prefix + 'chatbot cleardms*\n│  └⊷ Clear allowed DMs\n' +
    '├─⊷ *' + prefix + 'chatbot clearbdms*\n│  └⊷ Clear blocked DMs\n' +
    '╰───'
  );
}

// Levenshtein edit-distance — used for the "did you mean" command suggestion.
function commandDistance(a, b) {
  a = String(a);
  b = String(b);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// ── ?chatbot command handler (owner-only) ──────────────────────────────────
async function execute(sock, m, args, extra) {
  const jid = (extra && extra.from) || m.key.remoteJid;
  const prefix = (extra && extra.prefix) || '.';
  const cfg = loadConfig();
  const subCommand = (args[0] || '').toLowerCase();

  const quotedId = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const input = (args[0] || '').trim();
  if (quotedId && _lgCache.has(quotedId) && /^\d+$/.test(input)) {
    const groups = _lgCache.get(quotedId);
    const idx = parseInt(input) - 1;
    const group = groups[idx];
    if (!group) {
      return sock.sendMessage(jid, { text: `❌ No group at position *${input}*. The list has *${groups.length}* groups.` }, { quoted: m });
    }
    const detailText = `╭─⌈ 👥 *GROUP DETAIL* ⌋\n├─⊷ *${group.name}*\n╰─⊷ 🆔 \`${group.gid}\``;
    try {
      const { sendInteractiveMessage } = require('gifted-btns');
      return await sendInteractiveMessage(sock, jid, {
        text: detailText,
        footer: cfg.chatbotName || defaultBotName(),
        interactiveButtons: [
          { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: '📋 Copy JID', copy_code: group.gid }) },
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🗑️ Remove Group', id: `${prefix}chatbot removegroup ${group.gid}` }) }
        ]
      });
    } catch {
      return sock.sendMessage(jid, { text: detailText + `\n\n_Long-press the JID above to copy it._\n_Or send:_ \`${prefix}chatbot removegroup ${group.gid}\` _to remove._` }, { quoted: m });
    }
  }

  // ── No sub-command: show the compact STATUS CARD (live group count) ────
  if (!subCommand) {
    const groupCount = await getDashboardGroupCount(sock);
    const card = buildStatusCard(cfg, prefix, groupCount);
    return extra && typeof extra.reply === 'function'
      ? extra.reply(card)
      : sock.sendMessage(jid, { text: card }, { quoted: m });
  }

  // ── `help` sub-command: show the full command menu ──────────────────────
  if (subCommand === 'help') {
    return sock.sendMessage(jid, { text: buildHelpMenu(cfg, prefix) }, { quoted: m });
  }

  // ── Mode toggle ────────────────────────────────────────────────────────
  if (['on', 'off', 'groups', 'dms', 'both'].includes(subCommand)) {
    cfg.mode = subCommand;
    saveConfig(cfg);
    const modeLabels = { on: '🟢 ON', off: '🔴 OFF', groups: '👥 GROUPS', dms: '💬 DMS', both: '🌐 ALL' };
    return sock.sendMessage(jid, { text: `✅ Chatbot mode set to: *${modeLabels[subCommand]}*` }, { quoted: m });
  }

  // ── Model selection ────────────────────────────────────────────────────
  if (subCommand === 'model') {
    const modelName = (args[1] || '').toLowerCase();
    if (!modelName) {
      const active = cfg.preferredModel || 'nvidia-chat';
      let modelList = `*AI Models:*\n`;
      for (const [key, model] of Object.entries(AI_MODELS)) {
        modelList += `${model.icon} ${model.name} (\`${key}\`)${key === active ? ' ✅' : ''}\n`;
      }
      modelList += `\nSwitch: \`${prefix}chatbot model <key>\``;
      return sock.sendMessage(jid, { text: modelList }, { quoted: m });
    }
    if (!AI_MODELS[modelName]) {
      const validModels = Object.keys(AI_MODELS).join(', ');
      return sock.sendMessage(jid, { text: `❌ Unknown model: *${modelName}*\nAvailable: ${validModels}` }, { quoted: m });
    }
    cfg.preferredModel = modelName;
    saveConfig(cfg);
    const model = AI_MODELS[modelName];
    return sock.sendMessage(jid, { text: `✅ Model set to: ${model.icon} *${model.name}*` }, { quoted: m });
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  if (subCommand === 'stats') {
    const stats = cfg.stats || { totalQueries: 0, modelsUsed: {}, mediaActions: {} };
    let statsText = `${EMOTE} *${cfg.chatbotName || defaultBotName()} Stats*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 *Total Queries:* ${stats.totalQueries}\n` +
      `🤖 *Model:* ${(AI_MODELS[cfg.preferredModel] || AI_MODELS.gpt).name}\n` +
      `📡 *Mode:* ${cfg.mode.toUpperCase()}\n\n`;

    if (Object.keys(stats.modelsUsed || {}).length > 0) {
      statsText += `🔄 *AI Usage:*\n`;
      const sorted = Object.entries(stats.modelsUsed).sort((a, b) => b[1] - a[1]);
      for (const [modelKey, count] of sorted) {
        const model = AI_MODELS[modelKey];
        if (model) statsText += `  ${model.icon} ${model.name}: ${count}\n`;
      }
      statsText += `\n`;
    }

    if (Object.keys(stats.mediaActions || {}).length > 0) {
      const mediaEmojis = { image: '🎨', playAudio: '🎵', playVideo: '🎬', song: '🎶' };
      const mediaLabels = { image: 'Images', playAudio: 'Music', playVideo: 'Videos', song: 'Songs' };
      statsText += `🎯 *Media Actions:*\n`;
      for (const [key, count] of Object.entries(stats.mediaActions)) {
        statsText += `  ${mediaEmojis[key] || '📦'} ${mediaLabels[key] || key}: ${count}\n`;
      }
    }

    statsText += `\n⚡ ${(database.getOwnerNames() && database.getOwnerNames()[0]) || 'JuneX'}`;
    return sock.sendMessage(jid, { text: statsText }, { quoted: m });
  }

  // ── Clear conversation history ─────────────────────────────────────────
  if (subCommand === 'clear') {
    const senderJid = m.key.participant || jid;
    clearConversation(senderJid);
    clearPendingAction(senderJid, jid);
    return sock.sendMessage(jid, { text: `✅ Conversation history cleared` }, { quoted: m });
  }

  // ── Settings overview ──────────────────────────────────────────────────
  if (subCommand === 'settings') {
    const model = AI_MODELS[cfg.preferredModel] || AI_MODELS.gpt;
    const modeEmoji = { off: '🔴', on: '🟢', groups: '👥', dms: '💬', both: '🌐' };
    const exGroups = cfg.excludedGroups || [];
    const aDMs = cfg.allowedDMs || [];
    let filterSection = '';
    if (exGroups.length > 0 || aDMs.length > 0) {
      filterSection = `\n📋 *Filters:*\n`;
      if (exGroups.length > 0) filterSection += `  🚫 ${exGroups.length} group(s) excluded\n`;
      if (aDMs.length > 0) filterSection += `  💬 ${aDMs.length} DM(s) whitelisted\n`;
    }
    const cbName = cfg.chatbotName || defaultBotName();
    const cbTech = cfg.techName || defaultTechName();
    const settingsText =
      `${EMOTE} *${cbName} Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏷️ *Name:* ${cbName}\n` +
      `🏢 *Tech:* ${cbTech}\n` +
      `${modeEmoji[cfg.mode] || '🔴'} *Mode:* ${cfg.mode.toUpperCase()}\n` +
      `${model.icon} *Model:* ${model.name}\n` +
      `🔄 *Auto-Fallback:* Enabled\n` +
      `💾 *Memory:* 20 msgs (24h timeout)\n` +
      `🎯 *Interactive:* Images, Music, Videos\n` +
      `📊 *Queries:* ${cfg.stats?.totalQueries || 0}\n` +
      filterSection + `\n` +
      `🤖 *Models (${Object.keys(AI_MODELS).length}):*\n` +
      Object.entries(AI_MODELS).map(([k, v]) => `  ${v.icon} ${v.name} (\`${k}\`)`).join('\n') +
      `\n\n⚡ ${(database.getOwnerNames() && database.getOwnerNames()[0]) || 'JuneX'}`;
    return sock.sendMessage(jid, { text: settingsText }, { quoted: m });
  }

  // ── Group whitelist management ─────────────────────────────────────────
  if (subCommand === 'addgroup') {
    if (!jid.endsWith('@g.us')) {
      return sock.sendMessage(jid, { text: `❌ Run this command inside a group.` }, { quoted: m });
    }
    if (!cfg.excludedGroups) cfg.excludedGroups = [];
    let groupName = jid.split('@')[0];
    const cachedG = global.groupMetadataCache?.get(jid);
    if (cachedG?.data?.subject) groupName = cachedG.data.subject;

    const wasOffG = cfg.mode === 'off';
    if (wasOffG) cfg.mode = 'groups';

    const exIdx = cfg.excludedGroups.indexOf(jid);
    if (exIdx !== -1) {
      cfg.excludedGroups.splice(exIdx, 1);
      saveConfig(cfg);
      return sock.sendMessage(jid, { text: `✅ *${groupName}* re-enabled — chatbot will respond here again.` }, { quoted: m });
    }

    saveConfig(cfg);
    const autoNoteG = wasOffG ? `\n⚠️ Mode auto-set to GROUPS (was OFF)` : '';
    return sock.sendMessage(jid, { text: `✅ *${groupName}* is already active${autoNoteG}` }, { quoted: m });
  }

  if (subCommand === 'removegroup') {
    if (!cfg.excludedGroups) cfg.excludedGroups = [];
    let targetJid = null;
    if (args[1]) {
      targetJid = args[1].includes('@') ? args[1].trim() : `${args[1].trim()}@g.us`;
    } else if (jid.endsWith('@g.us')) {
      targetJid = jid;
    } else {
      return sock.sendMessage(jid, { text: `❌ Provide a group JID: *${prefix}chatbot removegroup <jid>*\n_Run ${prefix}chatbot listgroups to see all groups._` }, { quoted: m });
    }

    if (cfg.excludedGroups.includes(targetJid)) {
      return sock.sendMessage(jid, { text: `⚠️ That group is already excluded.\n_Use ${prefix}chatbot addgroup inside it to re-enable._` }, { quoted: m });
    }

    let removedName = targetJid.split('@')[0];
    const cachedMeta = global.groupMetadataCache?.get(targetJid);
    if (cachedMeta?.data?.subject) removedName = cachedMeta.data.subject;

    cfg.excludedGroups.push(targetJid);
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `🚫 *${removedName}* excluded — chatbot won't respond there.\n_Use ${prefix}chatbot addgroup inside it to re-enable._` }, { quoted: m });
  }

  if (subCommand === 'listgroups') {
    const excluded = cfg.excludedGroups || [];
    let allGroupEntries = [];
    try {
      const fetched = await sock.groupFetchAllParticipating();
      allGroupEntries = Object.values(fetched || {});
    } catch (fetchErr) {
      return sock.sendMessage(jid, { text: `❌ Failed to fetch groups: ${fetchErr.message}` }, { quoted: m });
    }

    if (allGroupEntries.length === 0) {
      return sock.sendMessage(jid, { text: `📋 Bot is not in any groups yet.` }, { quoted: m });
    }

    const metaCache = global.groupMetadataCache;
    const knownGroups = allGroupEntries.map(g => {
      let name = (g.subject || '').trim();
      if (!name && metaCache) {
        const cached = metaCache.get(g.id);
        if (cached?.data?.subject) name = cached.data.subject.trim();
      }
      return { gid: g.id, name: name || g.id.split('@')[0] };
    });

    knownGroups.sort((a, b) => a.name.localeCompare(b.name));

    const activeCount = knownGroups.filter(g => !excluded.includes(g.gid)).length;
    let listText = `📋 *Groups (${knownGroups.length} total, ${activeCount} active):*\n\n`;
    for (let i = 0; i < knownGroups.length; i++) {
      const { gid, name } = knownGroups[i];
      const isExcluded = excluded.includes(gid);
      listText += isExcluded ? `${i + 1}. 🚫 *${name}*\n` : `${i + 1}. ✅ *${name}*\n`;
    }
    listText += `\n_✅ active  •  🚫 excluded_\n_Reply with a number to copy its JID_`;

    const sent = await sock.sendMessage(jid, { text: listText }, { quoted: m });
    const sentId = sent?.key?.id;
    if (sentId) {
      _lgCache.set(sentId, knownGroups);
      if (_lgCache.size > _LG_MAX) _lgCache.delete(_lgCache.keys().next().value);
    }
    return;
  }

  if (subCommand === 'cleargroups') {
    cfg.excludedGroups = [];
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ All exclusions cleared — chatbot will respond in all groups again.` }, { quoted: m });
  }

  // ── DM whitelist management ────────────────────────────────────────────
  if (subCommand === 'adddm') {
    const number = (args[1] || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 7) {
      return sock.sendMessage(jid, { text: `❌ Provide a valid number.\nUsage: \`${prefix}chatbot adddm 2547xxxxxxxx\`` }, { quoted: m });
    }
    if (!cfg.allowedDMs) cfg.allowedDMs = [];
    const dmJid = `${number}@s.whatsapp.net`;
    const exists = cfg.allowedDMs.some(dm => dm.split('@')[0].split(':')[0] === number);
    if (exists) {
      return sock.sendMessage(jid, { text: `⚠️ ${number} is already added.` }, { quoted: m });
    }
    cfg.allowedDMs.push(dmJid);
    const wasOff = cfg.mode === 'off';
    if (wasOff) cfg.mode = 'dms';
    saveConfig(cfg);
    const autoNote = wasOff ? `\n⚠️ Mode auto-set to DMS (was OFF)` : '';
    return sock.sendMessage(jid, { text: `✅ ${number} successfully added${autoNote}` }, { quoted: m });
  }

  if (subCommand === 'removedm') {
    const number = (args[1] || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 7) {
      return sock.sendMessage(jid, { text: `❌ Provide a valid number.\nUsage: \`${prefix}chatbot removedm 2547xxxxxxxx\`` }, { quoted: m });
    }
    if (!cfg.allowedDMs) cfg.allowedDMs = [];
    const idx = cfg.allowedDMs.findIndex(dm => dm.split('@')[0].split(':')[0] === number);
    if (idx === -1) {
      return sock.sendMessage(jid, { text: `⚠️ ${number} is not in the list.` }, { quoted: m });
    }
    cfg.allowedDMs.splice(idx, 1);
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ ${number} successfully removed` }, { quoted: m });
  }

  if (subCommand === 'listdms') {
    const dms = cfg.allowedDMs || [];
    if (dms.length === 0) {
      return sock.sendMessage(jid, { text: `📋 No DMs in whitelist.` }, { quoted: m });
    }
    let listText = `📋 *Whitelisted DMs (${dms.length}):*\n`;
    for (let i = 0; i < dms.length; i++) {
      const num = dms[i].split('@')[0].split(':')[0];
      listText += `${i + 1}. +${num}\n`;
    }
    return sock.sendMessage(jid, { text: listText }, { quoted: m });
  }

  if (subCommand === 'cleardms') {
    cfg.allowedDMs = [];
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ All DMs cleared` }, { quoted: m });
  }

  // ── Blocked-DM management ──────────────────────────────────────────────
  if (subCommand === 'blockdm') {
    const number = (args[1] || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 7) {
      return sock.sendMessage(jid, { text: `❌ Provide a valid number.\nUsage: \`${prefix}chatbot blockdm 2547xxxxxxxx\`` }, { quoted: m });
    }
    if (!cfg.blockedDMs) cfg.blockedDMs = [];
    const exists = cfg.blockedDMs.some(dm => dm.split('@')[0].split(':')[0] === number);
    if (exists) {
      return sock.sendMessage(jid, { text: `⚠️ ${number} is already blocked.` }, { quoted: m });
    }
    cfg.blockedDMs.push(`${number}@s.whatsapp.net`);
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `🚫 ${number} blocked — chatbot won't respond in DMs with them.` }, { quoted: m });
  }

  if (subCommand === 'unblockdm') {
    const number = (args[1] || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 7) {
      return sock.sendMessage(jid, { text: `❌ Provide a valid number.\nUsage: \`${prefix}chatbot unblockdm 2547xxxxxxxx\`` }, { quoted: m });
    }
    if (!cfg.blockedDMs) cfg.blockedDMs = [];
    const idx = cfg.blockedDMs.findIndex(dm => dm.split('@')[0].split(':')[0] === number);
    if (idx === -1) {
      return sock.sendMessage(jid, { text: `⚠️ ${number} is not blocked.` }, { quoted: m });
    }
    cfg.blockedDMs.splice(idx, 1);
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ ${number} unblocked — chatbot can respond again.` }, { quoted: m });
  }

  if (subCommand === 'listbdms' || subCommand === 'listblockeddms') {
    const blocked = cfg.blockedDMs || [];
    if (blocked.length === 0) {
      return sock.sendMessage(jid, { text: `📋 No blocked DMs.` }, { quoted: m });
    }
    let listText = `🚫 *Blocked DMs (${blocked.length}):*\n`;
    for (let i = 0; i < blocked.length; i++) {
      const num = blocked[i].split('@')[0].split(':')[0];
      listText += `${i + 1}. +${num}\n`;
    }
    return sock.sendMessage(jid, { text: listText }, { quoted: m });
  }

  if (subCommand === 'clearbdms') {
    cfg.blockedDMs = [];
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ All blocked DMs cleared` }, { quoted: m });
  }

  // ── `status` sub-command: show the compact status card (live group count) ─
  if (subCommand === 'status') {
    const groupCount = await getDashboardGroupCount(sock);
    const card = buildStatusCard(cfg, prefix, groupCount);
    return extra && typeof extra.reply === 'function'
      ? extra.reply(card)
      : sock.sendMessage(jid, { text: card }, { quoted: m });
  }

  // ──chatbot ─────────────────────────────────────────────────
  if (subCommand === 'name') {
    const newName = args.slice(1).join(' ').trim();
    if (!newName) {
      const currentName = cfg.chatbotName || defaultBotName();
      return sock.sendMessage(jid, { text: `Name: *${currentName}*\nChange: \`${prefix}chatbot name <new name>\`` }, { quoted: m });
    }
    if (newName.length > 30) {
      return sock.sendMessage(jid, { text: `❌ Name too long (max 30 characters).` }, { quoted: m });
    }
    cfg.chatbotName = newName;
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ Chatbot name set to: *${newName}*` }, { quoted: m });
  }

  // ── tech/creator name ───────────────────────────────────────
  if (subCommand === 'techname') {
    const newTech = args.slice(1).join(' ').trim();
    if (!newTech) {
      const current = cfg.techName || defaultTechName();
      return sock.sendMessage(jid, { text: `Tech name: *${current}*\nChange: \`${prefix}chatbot techname <new name>\`` }, { quoted: m });
    }
    if (newTech.length > 40) {
      return sock.sendMessage(jid, { text: `❌ Tech name too long (max 40 characters).` }, { quoted: m });
    }
    cfg.techName = newTech;
    saveConfig(cfg);
    return sock.sendMessage(jid, { text: `✅ Tech/creator name set to: *${newTech}*\nThe chatbot will now say it was created by *${newTech}*.` }, { quoted: m });
  }

  // ── Per-group user filter management ───────────────────────────────────
  if (['allowonly', 'blockuser', 'allowuser', 'removeuser', 'listusers', 'clearusers'].includes(subCommand)) {
    if (!jid.endsWith('@g.us')) {
      return sock.sendMessage(jid, { text: `❌ User filters are per-group. Run this command inside a group.` }, { quoted: m });
    }

    if (!cfg.groupUserFilters) cfg.groupUserFilters = {};

    if (subCommand === 'listusers') {
      const filter = cfg.groupUserFilters[jid];
      if (!filter || !filter.users || filter.users.length === 0) {
        return sock.sendMessage(jid, { text: `ℹ️ *No user filter set for this group.*\nChatbot replies to *everyone*.\n\nUse:\n• \`${prefix}chatbot allowonly @user\` — only reply to specific people\n• \`${prefix}chatbot blockuser @user\` — block specific people` }, { quoted: m });
      }
      const modeLabel = filter.mode === 'allow'
        ? '✅ *ALLOW ONLY* — replies only to listed users'
        : '🚫 *BLOCK LIST* — replies to everyone except listed users';
      let text = `╭─⌈ 👤 *USER FILTER* ⌋\n│\n│ ${modeLabel}\n│\n`;
      filter.users.forEach((u, i) => {
        const num = u.split('@')[0].split(':')[0];
        text += `│ ${i + 1}. +${num}\n`;
      });
      text += `│\n╰⊷ ${(database.getOwnerNames() && database.getOwnerNames()[0]) || 'JuneX'}`;
      return sock.sendMessage(jid, { text }, { quoted: m });
    }

    if (subCommand === 'clearusers') {
      delete cfg.groupUserFilters[jid];
      saveConfig(cfg);
      return sock.sendMessage(jid, { text: `✅ User filter cleared — chatbot will reply to *everyone* in this group.` }, { quoted: m });
    }

    const targets = await _extractTargetUsers(sock, m, args);
    if (targets.length === 0) {
      const hint = subCommand === 'allowonly'
        ? `\`${prefix}chatbot allowonly @user\``
        : subCommand === 'blockuser'
          ? `\`${prefix}chatbot blockuser @user\``
          : subCommand === 'allowuser'
            ? `\`${prefix}chatbot allowuser @user\``
            : `\`${prefix}chatbot removeuser @user\``;
      return sock.sendMessage(jid, { text: `❌ @Mention someone or provide a number.\nExample: ${hint}` }, { quoted: m });
    }

    const _mentionLine = (list) => ({
      text: list.map(u => `@${u.split('@')[0].split(':')[0].replace(/\D/g, '')}`).join(', '),
      mentions: list
    });

    const filter = cfg.groupUserFilters[jid] || { mode: 'block', users: [] };

    if (subCommand === 'allowonly') {
      filter.mode = 'allow';
      for (const u of targets) {
        const uNum = u.split('@')[0].replace(/\D/g, '');
        const exists = filter.users.some(x => x.split('@')[0].replace(/\D/g, '') === uNum);
        if (!exists) filter.users.push(u);
      }
      cfg.groupUserFilters[jid] = filter;
      saveConfig(cfg);
      const { text: nameStr, mentions } = _mentionLine(targets);
      return sock.sendMessage(jid, {
        text: `✅ *Allow-only mode* set.\nChatbot will reply *only* to: ${nameStr}\n_Add more anytime with \`${prefix}chatbot allowonly @user\`_`,
        mentions
      }, { quoted: m });
    }

    if (subCommand === 'blockuser') {
      filter.mode = 'block';
      const added = [];
      for (const u of targets) {
        const uNum = u.split('@')[0].replace(/\D/g, '');
        const exists = filter.users.some(x => x.split('@')[0].replace(/\D/g, '') === uNum);
        if (!exists) { filter.users.push(u); added.push(u); }
      }
      cfg.groupUserFilters[jid] = filter;
      saveConfig(cfg);
      if (added.length === 0) {
        return sock.sendMessage(jid, { text: `⚠️ Those users are already blocked.` }, { quoted: m });
      }
      const { text: nameStr, mentions } = _mentionLine(added);
      return sock.sendMessage(jid, {
        text: `🚫 *Blocked:* ${nameStr}\nChatbot will ignore them in this group.\n_Use \`${prefix}chatbot allowuser @user\` to unblock._`,
        mentions
      }, { quoted: m });
    }

    if (subCommand === 'allowuser') {
      for (const u of targets) {
        const uNum = u.split('@')[0].replace(/\D/g, '');
        if (filter.mode === 'block') {
          const idx = filter.users.findIndex(x => x.split('@')[0].replace(/\D/g, '') === uNum);
          if (idx !== -1) filter.users.splice(idx, 1);
        } else if (filter.mode === 'allow') {
          const exists = filter.users.some(x => x.split('@')[0].replace(/\D/g, '') === uNum);
          if (!exists) filter.users.push(u);
        }
      }
      if (filter.users.length === 0) delete cfg.groupUserFilters[jid];
      else cfg.groupUserFilters[jid] = filter;
      saveConfig(cfg);
      const { text: nameStr, mentions } = _mentionLine(targets);
      const action = filter.mode === 'allow' ? 'Added to allow list' : 'Unblocked';
      return sock.sendMessage(jid, { text: `✅ *${action}:* ${nameStr}`, mentions }, { quoted: m });
    }

    if (subCommand === 'removeuser') {
      const removed = [];
      for (const u of targets) {
        const uNum = u.split('@')[0].replace(/\D/g, '');
        const idx = filter.users.findIndex(x => x.split('@')[0].replace(/\D/g, '') === uNum);
        if (idx !== -1) { removed.push(filter.users[idx]); filter.users.splice(idx, 1); }
      }
      if (removed.length === 0) {
        return sock.sendMessage(jid, { text: `⚠️ None of those users were in the filter list.` }, { quoted: m });
      }
      if (filter.users.length === 0) delete cfg.groupUserFilters[jid];
      else cfg.groupUserFilters[jid] = filter;
      saveConfig(cfg);
      const { text: nameStr, mentions } = _mentionLine(removed);
      return sock.sendMessage(jid, {
        text: `✅ *Removed from filter:* ${nameStr}\n${filter.users?.length ? `_${filter.users.length} user(s) still in list._` : '_Filter cleared — chatbot replies to everyone._'}`,
        mentions
      }, { quoted: m });
    }
  }

  // Unknown sub-command fallback — offer a "did you mean" suggestion.
  {
    const known = [
      'on', 'off', 'groups', 'dms', 'both', 'help', 'status', 'model', 'name',
      'techname', 'stats', 'clear', 'settings',
      'addgroup', 'removegroup', 'listgroups', 'cleargroups',
      'allowonly', 'blockuser', 'allowuser', 'removeuser', 'listusers', 'clearusers',
      'adddm', 'removedm', 'blockdm', 'unblockdm', 'listdms', 'listbdms', 'listblockeddms', 'cleardms', 'clearbdms',
    ];
    let best = null, bestDist = Infinity;
    for (const k of known) {
      const d = commandDistance(subCommand, k);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    const threshold = Math.max(2, Math.floor(subCommand.length / 2));
    if (best && bestDist <= threshold && bestDist <= 3) {
      return sock.sendMessage(jid, {
        text: `❌ Unknown option: *${subCommand}*\n\n💡 Did you mean: \`${prefix}chatbot ${best}\`?\n_Use \`${prefix}chatbot help\` to see all commands._`
      }, { quoted: m });
    }
    return sock.sendMessage(jid, { text: `❌ Unknown option: *${subCommand}*\nUse \`${prefix}chatbot\` to see all commands.` }, { quoted: m });
  }
}

// ── handleAutoReply — the interface June X's handler.js calls ──────────────
async function handleAutoReply(sock, msg, { from, isGroup, commands }) {
  try {
    const chatId = from || msg.key.remoteJid;
    if (!chatId) return false;
    if (!isChatbotActiveForChat(chatId)) return false;
    const handled = await handleChatbotMessage(sock, msg, commands);
    return handled === true;
  } catch (err) {
    console.error('[Chatbot/AutoReply]', err.message);
    return false;
  }
}

module.exports = {
  name: 'chatbot',
  description: 'JuneX Ultra AI chatbot | intelligent replies, image/audio/video intents, per-user memory',
  category: 'ai',
  aliases: ['aichat', 'ai-chat', 'junex', 'juneai'],
  usage: 'chatbot <on|off|groups|dms|both|model>',
  ownerOnly: true,
  execute,
  handleAutoReply,
  handleChatbotMessage,
  getChatbotConfig,
  isChatbotActiveForChat,
};
