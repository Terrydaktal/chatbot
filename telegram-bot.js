#!/usr/bin/env node
'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { BrowserAiInterface } = require('./lib/browser-ai-interface');

function formatLogPrefix() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `[(${year}-${month}-${day}) ${hours}:${minutes}:${seconds}.${ms}]`;
}

function installTimestampedConsole() {
  if (global.__chatbotTimestampedConsoleInstalled) return;
  global.__chatbotTimestampedConsoleInstalled = true;

  const wrap = (stream) => (...args) => {
    const rendered = util.format(...args).replace(/\n$/, '');
    const lines = rendered.split('\n');
    for (const line of lines) {
      stream.write(`${formatLogPrefix()} ${line}\n`);
    }
  };

  console.log = wrap(process.stdout);
  console.error = wrap(process.stderr);
  console.warn = wrap(process.stderr);
}

installTimestampedConsole();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_TRIGGER_USERNAME = (process.env.TELEGRAM_TRIGGER_USERNAME || '')
  .replace(/^@/, '')
  .toLowerCase();
const TELEGRAM_ALLOWED_CHAT_IDS = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS || '');
const TELEGRAM_ALLOWED_USER_IDS = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '');
const BROWSER_PORT = Number(process.env.BROWSER_PORT || 9233);
const GEMINI_URL = process.env.GEMINI_URL || 'https://gemini.google.com/app?hl=en-gb';
const AI_MODE_URL = process.env.AI_MODE_URL || 'https://www.google.com/search?udm=50&aep=11';
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);

const AI_MODE_HISTORY_BUTTON_SELECTOR = 'button.UTNPFf[aria-label="AI Mode history"]';
const AI_MODE_HISTORY_ITEM_SELECTOR = 'button.qqMZif[data-thread-id]';
const TELEGRAM_MAX_MESSAGE = 4096;
const CONCISE_PREFIX = 'answer in one sentence: ';
const CHAT_CONTEXT_DIRECTIVE_MAX = 50;
const CHAT_HISTORY_LIMIT = 300;
const HISTORY_MESSAGE_MAX_CHARS = 500;
const AI_MODE_CHAT_PREVIEW_MAX = 120;
const INCLUDE_STAGING_BUFFER_LIMIT = 300;
const INCLUDE_STAGING_WINDOW_MS = 5 * 60 * 1000;
const INCLUDE_MAX_IMAGES = 8;
const AI_PROMPT_MAX_CHARS = 8192;
const TELEGRAM_NAME_MAP_TSV = String(process.env.TELEGRAM_NAME_MAP_TSV || defaultNameMapPath()).trim();
const NAME_MAP_ENTRIES = loadNameMapEntries(TELEGRAM_NAME_MAP_TSV);
const NAME_MAP_SOURCE_MAP = buildSourceNameMap(NAME_MAP_ENTRIES);
const NAME_MAP_FORWARD_ENTRIES = [...NAME_MAP_ENTRIES]
  .sort((a, b) => (b.source.length - a.source.length) || (a.index - b.index));
const NAME_MAP_REVERSE_ENTRIES = buildReverseNameMapEntries(NAME_MAP_ENTRIES);
const fsp = fs.promises;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable.');
  process.exit(1);
}

class GeminiBridge {
  constructor(port, urls) {
    this.port = port;
    this.urls = urls;
    this.browser = null;
    this.page = null;
    this.ai = new BrowserAiInterface();
  }

  async ensureConnected() {
    if (this.browser && this.browser.connected) return;
    this.browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${this.port}`,
      defaultViewport: null,
    });
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.page = null;
    });
  }

  getModelConfig(model) {
    const shared = this.ai.getModelConfig(model);
    if (model === 'aimode') {
      return {
        url: this.urls.ai,
        inputSelectors: shared.inputSelectors,
        responseSelector: shared.responseSelector,
        historyItemSelector: AI_MODE_HISTORY_ITEM_SELECTOR,
      };
    }
    return {
      url: this.urls.gemini,
      inputSelectors: shared.inputSelectors,
      responseSelector: shared.responseSelector,
      historyItemSelector: '[data-test-id="conversation"]',
    };
  }

  async ensurePage(model, newChat = false) {
    const config = this.getModelConfig(model);
    await this.ensureConnected();
    if (!this.page || this.page.isClosed()) {
      const pages = await this.browser.pages();
      this.page = pages.find((p) => !p.url().startsWith('chrome-extension://')) || await this.browser.newPage();
    }

    const currentUrl = this.page.url() || '';
    const isOnModeSurface = model === 'aimode'
      ? currentUrl.includes('google.com/search')
      : currentUrl.includes('gemini.google.com');
    const shouldNavigate = newChat || !isOnModeSurface;
    if (shouldNavigate) {
      await this.page.goto(config.url, { waitUntil: 'networkidle2', timeout: 60000 });
    }
    await this.page.waitForSelector(config.inputSelectors.join(', '), { timeout: 120000 });
    return this.page;
  }

  async startNewChat(model) {
    const page = await this.ensurePage(model, true);
    if (model === 'geminifast') {
      await this.ensureGeminiFastSelected(page);
    } else if (model === 'geminithinking' || model === 'geminipro') {
      await this.ensureGeminiThinkingSelected(page);
    }
  }

  async listRecentChats(model, limit = 20) {
    const page = await this.ensurePage(model, false);

    if (model === 'aimode') {
      const historyButton = await page.$(AI_MODE_HISTORY_BUTTON_SELECTOR);
      if (historyButton) {
        const initialItems = await page.$$(AI_MODE_HISTORY_ITEM_SELECTOR);
        if (!initialItems.length) {
          await historyButton.click();
          await sleep(1000);
          try {
            await page.waitForSelector(AI_MODE_HISTORY_ITEM_SELECTOR, { timeout: 5000 });
          } catch {}
        }
      }

      for (let clicks = 0; clicks < 10; clicks += 1) {
        const showMore = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find((b) =>
            b.classList.contains('EBNOJf') ||
            (b.getAttribute('aria-label') || '').includes('See more AI Mode') ||
            (b.innerText || '').includes('Show more')
          ) || null;
        });
        const button = showMore && showMore.asElement ? showMore.asElement() : null;
        if (!button) break;
        const isVisible = await button.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0;
        }).catch(() => false);
        if (!isVisible) break;
        await button.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
        await sleep(400);
        await button.click().catch(() => {});
        await sleep(1200);
      }

      const aiChats = await page.evaluate((selector) => {
        const results = [];
        const seen = new Set();
        const elements = Array.from(document.querySelectorAll(selector));
        elements.forEach((el, index) => {
          const title = (el.innerText || el.getAttribute('aria-label') || 'Untitled chat').trim();
          const threadId = el.getAttribute('data-thread-id');
          const key = threadId || `idx:${index}`;
          if (seen.has(key)) return;
          seen.add(key);
          results.push({ title, href: '', clickIndex: index });
        });
        return results;
      }, AI_MODE_HISTORY_ITEM_SELECTOR);

      return aiChats.slice(0, Math.max(1, limit)).map((c) => ({
        title: (c.title || '').trim() || 'Untitled chat',
        href: '',
        clickIndex: Number.isInteger(c.clickIndex) ? c.clickIndex : -1,
      }));
    }

    const chats = await page.evaluate(() => {
      const tooltipMap = new Map();
      const tooltipContainer = document.querySelector('.cdk-describedby-message-container');
      if (tooltipContainer) {
        tooltipContainer.querySelectorAll('[id^="cdk-describedby-message"]').forEach((el) => {
          const text = (el.textContent || '').trim();
          if (text) tooltipMap.set(el.id, text);
        });
      }

      const items = [];
      const seen = new Set();

      const convItems = Array.from(document.querySelectorAll('[data-test-id="conversation"]'));
      convItems.forEach((el, index) => {
        let title = '';
        const titleEl = el.querySelector('.conversation-title');
        if (titleEl) title = titleEl.textContent.replace(/\s+/g, ' ').trim();
        if (!title) {
          const aria = el.getAttribute('aria-label');
          if (aria) title = aria.trim();
        }
        if (!title) {
          const describedBy = el.getAttribute('aria-describedby');
          if (describedBy) title = tooltipMap.get(describedBy) || '';
        }
        if (!title) return;
        const href = el.getAttribute('href') || '';
        const key = href || `click:${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ title, href, clickIndex: href ? -1 : index });
      });

      if (items.length > 0) return items;

      const navRoot = document.querySelector('side-navigation-v2') ||
        document.querySelector('bard-side-navigation') ||
        document.querySelector('nav') ||
        document.body;
      const links = Array.from(navRoot.querySelectorAll('a[href*="/app/"]'));
      for (const link of links) {
        const href = link.getAttribute('href') || link.href || '';
        if (!href || !href.includes('/app/')) continue;
        const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
        const title = text || link.getAttribute('aria-label') || link.getAttribute('title') || '';
        const key = href;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ title: title.trim(), href, clickIndex: -1 });
      }
      return items;
    });

    return chats.slice(0, Math.max(1, limit)).map((c) => ({
      title: (c.title || '').trim() || 'Untitled chat',
      href: c.href || '',
      clickIndex: Number.isInteger(c.clickIndex) ? c.clickIndex : -1,
    }));
  }

  async selectChat(chatRef) {
    if (!chatRef) throw new Error('Missing chat reference.');
    const model = normalizeModel(chatRef.model) || 'geminifast';
    const config = this.getModelConfig(model);
    const page = await this.ensurePage(model, false);

    if (chatRef.href) {
      const targetUrl = chatRef.href.startsWith('http')
        ? chatRef.href
        : new URL(chatRef.href, config.url).toString();
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } else if (Number.isInteger(chatRef.clickIndex) && chatRef.clickIndex >= 0) {
      const clicked = await page.evaluate((index, selector) => {
        const items = document.querySelectorAll(selector);
        if (!items[index]) return false;
        items[index].scrollIntoView({ block: 'center' });
        items[index].click();
        return true;
      }, chatRef.clickIndex, config.historyItemSelector);
      if (!clicked) throw new Error('Could not click selected chat item.');
      try {
        await page.waitForNetworkIdle({ timeout: 10000, idleTime: 500 });
      } catch {}
    } else {
      throw new Error('Selected chat has no usable navigation target.');
    }

    await page.waitForSelector(config.inputSelectors.join(', '), { timeout: 120000 });
    if (model === 'geminifast') {
      await this.ensureGeminiFastSelected(page);
    } else if (model === 'geminithinking' || model === 'geminipro') {
      await this.ensureGeminiThinkingSelected(page);
    }
  }

  async ask(promptText, model, options = {}) {
    const prompt = (promptText || '').trim();
    if (!prompt) throw new Error('Empty prompt.');
    const page = await this.ensurePage(model, false);
    return this.ai.ask(page, {
      prompt,
      model,
      preferAiMode: model === 'aimode',
      imagePaths: Array.isArray(options.imagePaths) ? options.imagePaths : [],
    });
  }

  async ensureGeminiFastSelected(page) {
    await this.ai.ensureGeminiFastSelected(page);
  }

  async ensureGeminiThinkingSelected(page) {
    await this.ai.ensureGeminiThinkingSelected(page);
  }
}

function parseAllowedChatIds(raw) {
  if (!raw.trim()) return null;
  const ids = new Set();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids.size ? ids : null;
}

function parseAllowedUserIds(raw) {
  if (!raw.trim()) return null;
  const ids = new Set();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids.size ? ids : null;
}

function defaultNameMapPath() {
  const xdgConfigHome = String(process.env.XDG_CONFIG_HOME || '').trim();
  const base = xdgConfigHome || path.join(os.homedir(), '.config');
  return path.join(base, 'chatbot', 'name-map.tsv');
}

function loadNameMapEntries(tsvPath) {
  const rawPath = String(tsvPath || '').trim();
  if (!rawPath) return [];
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) return [];

  let data = '';
  try {
    data = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error(`name-map load error: ${err.message}`);
    return [];
  }

  const entries = [];
  const seen = new Set();
  const lines = String(data || '').split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const source = String(cols[0] || '').trim();
    const target = String(cols[1] || '').trim();
    if (!source || !target) continue;
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      index: lineIndex,
      source,
      sourceLower: key,
      target,
      regex: buildNameMatchRegex(source),
    });
  }
  return entries;
}

function buildNameMatchRegex(value) {
  const text = String(value || '');
  const startsWord = /[A-Za-z0-9]$/.test(text.slice(0, 1));
  const endsWord = /[A-Za-z0-9]$/.test(text);
  const pattern = `${startsWord ? '\\b' : ''}${escapeRegex(text)}${endsWord ? '\\b' : ''}`;
  return new RegExp(pattern, 'gi');
}

function buildSourceNameMap(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const key = String(entry && entry.sourceLower ? entry.sourceLower : '');
    if (!key || map.has(key)) continue;
    map.set(key, String(entry.target || ''));
  }
  return map;
}

function buildReverseNameMapEntries(entries) {
  const out = [];
  const seenTarget = new Set();
  for (const entry of entries || []) {
    const target = String(entry && entry.target ? entry.target : '').trim();
    const source = String(entry && entry.source ? entry.source : '').trim();
    const targetLower = target.toLowerCase();
    if (!target || !source || seenTarget.has(targetLower)) continue;
    seenTarget.add(targetLower);
    out.push({
      target,
      source,
      regex: buildNameMatchRegex(target),
    });
  }
  return out;
}

function mapSenderLabel(label) {
  const raw = String(label || '').trim();
  if (!raw || !NAME_MAP_ENTRIES.length) return raw;
  const mapped = NAME_MAP_SOURCE_MAP.get(raw.toLowerCase());
  return mapped || raw;
}

function applyNameMappingsToText(text) {
  let out = String(text || '');
  if (!out || !NAME_MAP_FORWARD_ENTRIES.length) return out;
  for (const entry of NAME_MAP_FORWARD_ENTRIES) {
    out = out.replace(entry.regex, entry.target);
  }
  return out;
}

function reverseNameMappingsInText(text) {
  let out = String(text || '');
  if (!out || !NAME_MAP_REVERSE_ENTRIES.length) return out;
  for (const entry of NAME_MAP_REVERSE_ENTRIES) {
    out = out.replace(entry.regex, entry.source);
  }
  return out;
}

function isSenderAllowed(message) {
  if (!TELEGRAM_ALLOWED_USER_IDS || !TELEGRAM_ALLOWED_USER_IDS.size) return true;
  const senderId = String((message && message.from && message.from.id) || '');
  return TELEGRAM_ALLOWED_USER_IDS.has(senderId);
}

function shouldHandleMessage(message) {
  if (!message) return false;
  if (message.from && message.from.is_bot) return false;
  if (String((message.chat && message.chat.type) || '') === 'private' && isForwardedMessage(message)) return false;
  if (TELEGRAM_ALLOWED_CHAT_IDS && !TELEGRAM_ALLOWED_CHAT_IDS.has(String(message.chat.id))) return false;
  if (!isSenderAllowed(message)) return false;

  const { text, entities } = getMessageTextData(message);
  const raw = text || '';
  if (!raw) return false;
  if (!TELEGRAM_TRIGGER_USERNAME) return false;

  if (entities.some((entity) => isTriggerMentionEntity(entity, raw))) return true;

  const mentionRegex = new RegExp(`(^|\\s)@${escapeRegex(TELEGRAM_TRIGGER_USERNAME)}\\b`, 'i');
  return mentionRegex.test(raw);
}

function extractPrompt(message) {
  const { text, entities } = getMessageTextData(message);
  let body = (text || '').trim();
  if (!body) return '';

  if (TELEGRAM_TRIGGER_USERNAME) {
    body = stripTriggerMentionsByEntity(body, entities);
    if (body) {
      const mentionRegex = new RegExp(`(^|\\s)@${escapeRegex(TELEGRAM_TRIGGER_USERNAME)}\\b`, 'ig');
      body = body.replace(mentionRegex, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return body;
}

function parseChatContextDirective(prompt) {
  const input = (prompt || '').trim();
  if (!input) return { includeForwarded: false, prompt: '' };

  const includeLegacy = input.match(/\[\[include:[^\]]+\]\]/i);
  if (includeLegacy) {
    const before = input.slice(0, includeLegacy.index || 0).trim();
    const after = input.slice((includeLegacy.index || 0) + includeLegacy[0].length).trim();
    const remainingPrompt = [before, after].filter(Boolean).join(' ').trim();
    return {
      includeForwarded: false,
      prompt: remainingPrompt,
      error: 'Use [[include]] and manually forward messages to your private chat with the bot first.',
    };
  }

  const include = input.match(/\[\[include\]\]/i);
  if (!include) return { includeForwarded: false, prompt: input };

  const before = input.slice(0, include.index || 0).trim();
  const after = input.slice((include.index || 0) + include[0].length).trim();
  const remainingPrompt = [before, after].filter(Boolean).join(' ').trim();
  return { includeForwarded: true, prompt: remainingPrompt };
}

function applyTelegramPromptMode(prompt) {
  const text = (prompt || '').trim();
  if (!text) return '';
  if (text.startsWith('~') && !text.startsWith('~~')) {
    // Keep behavior aligned with chatbot.js concise mode transformation.
    return CONCISE_PREFIX + text.substring(1);
  }
  return text;
}

function addMessageToChatHistory(historyMap, message) {
  if (!message) return;
  const { text } = getMessageTextData(message);
  const content = (text || '').replace(/\s+/g, ' ').trim();
  if (!content) return;

  const chatId = String(message.chat && message.chat.id ? message.chat.id : '');
  if (!chatId) return;

  const userId = String(message.from && message.from.id ? message.from.id : '');
  const username = message.from && message.from.username ? `@${message.from.username}` : '';
  const firstName = message.from && message.from.first_name ? message.from.first_name : '';
  const lastName = message.from && message.from.last_name ? message.from.last_name : '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();

  const entry = {
    messageId: Number(message.message_id) || 0,
    userId,
    username,
    displayName,
    isBot: Boolean(message.from && message.from.is_bot),
    text: content.slice(0, HISTORY_MESSAGE_MAX_CHARS),
  };

  const bucket = historyMap.get(chatId) || [];
  bucket.push(entry);
  if (bucket.length > CHAT_HISTORY_LIMIT) {
    bucket.splice(0, bucket.length - CHAT_HISTORY_LIMIT);
  }
  historyMap.set(chatId, bucket);
}

function findHistoryMessageById(historyMap, chatId, messageId) {
  const bucket = historyMap.get(chatId) || [];
  for (let i = bucket.length - 1; i >= 0; i -= 1) {
    if (Number(bucket[i].messageId || 0) === Number(messageId || 0)) return bucket[i];
  }
  return null;
}

function formatSenderLabelFromHistory(entry) {
  if (!entry) return 'unknown';
  if (entry.displayName) return mapSenderLabel(entry.displayName);
  if (entry.username) return mapSenderLabel(entry.username);
  if (entry.userId) return mapSenderLabel(`user_${entry.userId}`);
  return mapSenderLabel('unknown');
}

function formatUserLabel(user) {
  if (!user) return '';
  const first = user.first_name || '';
  const last = user.last_name || '';
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full) return mapSenderLabel(full);
  if (user.username) return mapSenderLabel(`@${user.username}`);
  if (user.id) return mapSenderLabel(`user_${user.id}`);
  return '';
}

function formatSenderFromCopiedMessage(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const origin = msg.forward_origin;
  if (origin && typeof origin === 'object') {
    if (origin.type === 'user') {
      const u = origin.sender_user || null;
      const label = formatUserLabel(u);
      if (label) return label;
    }
    if (origin.type === 'hidden_user' && origin.sender_user_name) return String(origin.sender_user_name);
    if (origin.type === 'chat' && origin.sender_chat && origin.sender_chat.title) return String(origin.sender_chat.title);
    if (origin.type === 'channel' && origin.chat && origin.chat.title) return String(origin.chat.title);
  }
  const ff = formatUserLabel(msg.forward_from);
  if (ff) return ff;
  if (msg.forward_sender_name) return String(msg.forward_sender_name);
  return '';
}

function extractMessageContentForInclude(message) {
  const { text } = getMessageTextData(message || {});
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized) return normalized.slice(0, HISTORY_MESSAGE_MAX_CHARS);
  if (message && message.photo) return '[photo]';
  if (message && message.document) return '[document]';
  if (message && message.video) return '[video]';
  if (message && message.audio) return '[audio]';
  if (message && message.voice) return '[voice]';
  if (message && message.sticker) return '[sticker]';
  return '[non-text message]';
}

function extractImageRefsForInclude(message) {
  const refs = [];
  if (!message || typeof message !== 'object') return refs;

  if (Array.isArray(message.photo) && message.photo.length) {
    const sorted = [...message.photo].sort((a, b) => Number(a.file_size || 0) - Number(b.file_size || 0));
    const best = sorted[sorted.length - 1];
    if (best && best.file_id) {
      refs.push({
        kind: 'image',
        fileId: String(best.file_id),
        source: 'photo',
      });
    }
  }

  if (message.document && message.document.file_id) {
    const mime = String(message.document.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) {
      refs.push({
        kind: 'image',
        fileId: String(message.document.file_id),
        source: 'document',
        fileName: String(message.document.file_name || ''),
      });
    }
  }
  return refs;
}

function isForwardedMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return Boolean(
    message.forward_origin
    || message.forward_from
    || message.forward_from_chat
    || message.forward_sender_name
    || message.forward_date
  );
}

function addForwardedStagingMessage(stagingByUserId, message) {
  if (!stagingByUserId || !message) return false;
  const chatType = String((message.chat && message.chat.type) || '');
  if (chatType !== 'private') return false;
  if (!isForwardedMessage(message)) return false;

  const userId = String((message.from && message.from.id) || '');
  if (!userId) return false;
  const chatId = String((message.chat && message.chat.id) || '');
  const senderRaw = formatSenderFromCopiedMessage(message)
    || formatUserLabel(message.from)
    || String((message.sender_chat && message.sender_chat.title) || '')
    || 'unknown';
  const sender = mapSenderLabel(senderRaw);
  const contentRaw = extractMessageContentForInclude(message);
  const content = applyNameMappingsToText(contentRaw);
  const imageRefs = extractImageRefsForInclude(message);
  if (!content) return;

  const messageId = Number(message.message_id) || 0;
  const bucket = stagingByUserId.get(userId) || [];
  if (messageId && bucket.some((entry) => Number(entry.messageId || 0) === messageId)) return true;
  bucket.push({
    messageId,
    chatId,
    sender,
    content,
    imageRefs,
    createdAtMs: Date.now(),
  });
  if (bucket.length > INCLUDE_STAGING_BUFFER_LIMIT) {
    bucket.splice(0, bucket.length - INCLUDE_STAGING_BUFFER_LIMIT);
  }
  stagingByUserId.set(userId, bucket);
  console.log(
    `[include-buffer] add message_id=${messageId || '(none)'} sender=${JSON.stringify(sender)} text_len=${content.length} image_refs=${imageRefs.length}`
  );
  return true;
}

function consumeRecentForwardedMessages(stagingByUserId, userId) {
  const key = String(userId || '');
  if (!key) return { picked: [], stale: 0 };
  const bucket = stagingByUserId.get(key) || [];
  if (!bucket.length) return { picked: [], stale: 0 };

  const nowMs = Date.now();
  const fresh = [];
  let stale = 0;
  for (const entry of bucket) {
    const age = nowMs - Number(entry.createdAtMs || 0);
    if (age <= INCLUDE_STAGING_WINDOW_MS) {
      fresh.push(entry);
    } else {
      stale += 1;
    }
  }
  stagingByUserId.delete(key);
  return { picked: fresh, stale };
}

function buildIncludedMessagesContextFromForwarded(pickedEntries) {
  const source = Array.isArray(pickedEntries) ? pickedEntries : [];
  if (!source.length) return { context: '', count: 0, truncated: false, imageRefs: [] };
  const picked = source.slice(-CHAT_CONTEXT_DIRECTIVE_MAX);
  const truncated = source.length > picked.length;
  const imageRefs = [];
  const lines = picked.map((entry) => {
    const sender = String(entry.sender || 'unknown');
    const text = String(entry.content || '');
    if (Array.isArray(entry.imageRefs) && entry.imageRefs.length) {
      for (const ref of entry.imageRefs) {
        if (!ref || ref.kind !== 'image' || !ref.fileId) continue;
        imageRefs.push({
          kind: 'image',
          fileId: String(ref.fileId),
          source: String(ref.source || ''),
          fileName: String(ref.fileName || ''),
          sender,
          messageId: Number(entry.messageId || 0),
        });
      }
    }
    return `${sender}: ${text}`;
  });
  return {
    context: lines.join('\n'),
    count: picked.length,
    truncated,
    imageRefs,
  };
}

async function deleteForwardedStagingMessages(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const chatId = String(entry && entry.chatId ? entry.chatId : '');
    const messageId = Number(entry && entry.messageId ? entry.messageId : 0);
    if (!chatId || !messageId) continue;
    telegramCall('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    }).catch((err) => {
      console.error(`include-buffer delete failed chat_id=${chatId} message_id=${messageId}: ${err.message}`);
    });
  }
}

function guessImageExt(filePath, mimeType) {
  const fromPath = path.extname(String(filePath || '')).trim();
  if (fromPath) return fromPath;
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

async function downloadTelegramFileById(fileId, tempDir, index) {
  const file = await telegramCall('getFile', { file_id: String(fileId) });
  const telegramPath = String(file && file.file_path ? file.file_path : '');
  if (!telegramPath) throw new Error('getFile returned empty file_path');
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${telegramPath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`file download HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = guessImageExt(telegramPath, response.headers.get('content-type'));
  const local = path.join(tempDir, `include-${index}${ext}`);
  await fsp.writeFile(local, buffer);
  return local;
}

async function prepareIncludeImageUploads(imageRefs) {
  const source = Array.isArray(imageRefs) ? imageRefs : [];
  const selected = source.slice(0, INCLUDE_MAX_IMAGES);
  if (!selected.length) return { imagePaths: [], tempDir: '', dropped: 0 };
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatbot-include-'));
  const imagePaths = [];
  for (let i = 0; i < selected.length; i += 1) {
    const ref = selected[i];
    try {
      const local = await downloadTelegramFileById(ref.fileId, tempDir, i + 1);
      imagePaths.push(local);
    } catch (err) {
      console.error(`include-image download failed file_id=${ref.fileId}: ${err.message}`);
    }
  }
  return {
    imagePaths,
    tempDir,
    dropped: Math.max(0, source.length - selected.length),
  };
}

async function cleanupIncludeImageUploads(tempDir) {
  const dir = String(tempDir || '').trim();
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function getMessageTextData(message) {
  if (typeof message.text === 'string') {
    return {
      text: message.text,
      entities: Array.isArray(message.entities) ? message.entities : [],
    };
  }
  if (typeof message.caption === 'string') {
    return {
      text: message.caption,
      entities: Array.isArray(message.caption_entities) ? message.caption_entities : [],
    };
  }
  return { text: '', entities: [] };
}

function isTriggerMentionEntity(entity, sourceText) {
  if (!entity || entity.type !== 'mention') return false;
  const offset = Number(entity.offset);
  const length = Number(entity.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 1 || offset < 0) return false;
  const raw = (sourceText || '').slice(offset, offset + length);
  if (!raw.startsWith('@')) return false;
  return raw.slice(1).toLowerCase() === TELEGRAM_TRIGGER_USERNAME;
}

function stripTriggerMentionsByEntity(text, entities) {
  if (!text || !TELEGRAM_TRIGGER_USERNAME || !Array.isArray(entities) || !entities.length) return text;
  const ranges = [];
  for (const entity of entities) {
    if (!isTriggerMentionEntity(entity, text)) continue;
    ranges.push([entity.offset, entity.offset + entity.length]);
  }
  if (!ranges.length) return text;

  ranges.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isNewChatCommand(text, botUsername) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  const plain = '/newchat';
  const withBot = botUsername ? `/newchat@${botUsername.toLowerCase()}` : '';
  return lower === plain || (withBot && lower === withBot);
}

function isWhoAmICommand(text, botUsername) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  const plain = '/whoami';
  const withBot = botUsername ? `/whoami@${botUsername.toLowerCase()}` : '';
  return lower === plain || (withBot && lower === withBot);
}

function isHelpCommand(text, botUsername) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  const plain = '/help';
  const withBot = botUsername ? `/help@${botUsername.toLowerCase()}` : '';
  return lower === plain || (withBot && lower === withBot);
}

function buildHelpText(botUsername) {
  return [
    'Telegram Bot Help',
    '',
    'Setup (required per chat):',
    '1. Default model is AI Mode (token: aimode). Change with /model <geminifast|geminithinking|aimode|none>',
    '2. A new chat is auto-started on first prompt and after each /model switch',
    '3. Optional: /chat then /chat <number> to switch to an existing chat',
    '',
    'Commands:',
    '/help - Show this help text',
    '/whoami - Show your Telegram user ID and chat ID',
    '/model - Show current model + available models',
    '/model geminifast - Enable Gemini Fast (3.0 Flash)',
    '/model geminithinking - Enable Gemini Thinking (3.0 Flash Thinking)',
    '/model aimode - Enable AI Mode',
    '/model none - Disable prompt responses (silent mode)',
    '/newchat - Start a new chat in current model',
    '/chat - List recent chats in current model',
    '/chat <number> - Select a chat from latest /chat list',
    '',
    'Trigger rules:',
    '- Message must include @google_ai_mode_bot',
    '- Replies without a tag do not trigger the bot',
    '',
    'Prompt behavior:',
    '- Tagged messages remove @google_ai_mode_bot before sending to AI',
    '- If the remaining tagged text starts with "~", it tells the AI to give a brief answer',
    '- No ~ is a standard answer',
    '',
    'Extra context directives (start of prompt):',
    '- [[include]] include forwarded messages sent to your private chat with this bot in the last 5 minutes',
    '- Forwarded photos/images are uploaded to the AI chat when supported',
    '- Works with concise mode too: ~ [[include]] ...',
    '- After use, those forwarded staging messages are deleted from your private bot chat',
  ].join('\n');
}

function parseChatCommand(text, botUsername) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const cmd = parts[0].toLowerCase();
  const plain = '/chat';
  const withBot = botUsername ? `/chat@${botUsername.toLowerCase()}` : '';
  if (cmd !== plain && (!withBot || cmd !== withBot)) return null;
  if (parts.length < 2) return { list: true };
  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 1) return { error: 'Usage: /chat [number]' };
  return { index };
}

function parseModelCommand(text, botUsername) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const cmd = parts[0].toLowerCase();
  const plain = '/model';
  const withBot = botUsername ? `/model@${botUsername.toLowerCase()}` : '';
  if (cmd !== plain && (!withBot || cmd !== withBot)) return null;
  if (parts.length < 2) return { query: true };
  const model = normalizeModel(parts[1]);
  if (!model) return { error: 'Usage: /model <geminifast|geminithinking|aimode|none>' };
  return { model };
}

function formatModelDisplayName(model) {
  const key = normalizeModel(model);
  if (key === 'geminifast') return 'Gemini Fast (3.0 Flash)';
  if (key === 'geminithinking') return 'Gemini Thinking (3.0 Flash Thinking)';
  if (key === 'aimode') return 'AI Mode';
  if (key === 'none') return 'None (Disabled)';
  return String(model || '').trim() || '(unknown)';
}

function buildModelUsageText() {
  return [
    'Available models:',
    '- Gemini Fast (3.0 Flash) [geminifast]',
    '- Gemini Thinking (3.0 Flash Thinking) [geminithinking]',
    '- AI Mode [aimode]',
    '- None (Disabled) [none]',
    'Use /model <geminifast|geminithinking|aimode|none>.',
  ].join('\n');
}

function normalizeModel(value) {
  const v = (value || '').toString().trim().toLowerCase();
  if (v === 'none' || v === 'off' || v === 'silent') return 'none';
  if (v === 'ai' || v === 'aimode' || v === 'ai-mode') return 'aimode';
  if (v === 'geminifast' || v === 'fast' || v === 'flash' || v === 'gemini') return 'geminifast';
  if (v === 'geminithinking' || v === 'thinking' || v === 'think' || v === 'geminipro' || v === 'pro' || v === 'advanced') return 'geminithinking';
  return '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramCall(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Telegram API error: ${json.description || 'unknown error'}`);
  }
  return json.result;
}

async function telegramCallMultipart(method, formData) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Telegram API error: ${json.description || 'unknown error'}`);
  }
  return json.result;
}

async function sendPhotoReply(chatId, replyToMessageId, photoBuffer, caption = '') {
  const startedAt = Date.now();
  const captionLen = String(caption || '').length;
  const photoBytes = photoBuffer && typeof photoBuffer.length === 'number' ? photoBuffer.length : 0;
  console.log(
    `[telegram-send] start method=sendPhoto chat_id=${chatId} reply_to=${replyToMessageId || '(none)'} caption_len=${captionLen} photo_bytes=${photoBytes}`
  );
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (replyToMessageId) form.set('reply_to_message_id', String(replyToMessageId));
  form.set('allow_sending_without_reply', 'true');
  if (caption) form.set('caption', String(caption).slice(0, 1024));
  form.append('photo', new Blob([photoBuffer], { type: 'image/png' }), 'table.png');
  const result = await telegramCallMultipart('sendPhoto', form);
  const messageId = result && result.message_id ? result.message_id : '(unknown)';
  console.log(
    `[telegram-send] done method=sendPhoto chat_id=${chatId} message_id=${messageId} duration_ms=${Date.now() - startedAt}`
  );
  return result;
}

async function sendMessageWithLog(chatId, messagePayload, context = {}) {
  const startedAt = Date.now();
  const chunkIndex = Number.isInteger(context.chunkIndex) ? context.chunkIndex : 1;
  const chunkTotal = Number.isInteger(context.chunkTotal) ? context.chunkTotal : 1;
  const kind = context.kind ? String(context.kind) : 'text';
  const parseMode = messagePayload && messagePayload.parse_mode ? String(messagePayload.parse_mode) : '(none)';
  const textLen = String((messagePayload && messagePayload.text) || '').length;
  const replyTo = messagePayload && messagePayload.reply_to_message_id
    ? String(messagePayload.reply_to_message_id)
    : '(none)';
  console.log(
    `[telegram-send] start method=sendMessage kind=${kind} chat_id=${chatId} reply_to=${replyTo} parse_mode=${parseMode} chunk=${chunkIndex}/${chunkTotal} text_len=${textLen}`
  );
  const result = await telegramCall('sendMessage', messagePayload);
  const messageId = result && result.message_id ? result.message_id : '(unknown)';
  console.log(
    `[telegram-send] done method=sendMessage kind=${kind} chat_id=${chatId} message_id=${messageId} duration_ms=${Date.now() - startedAt}`
  );
  return result;
}

async function sendReply(chatId, replyToMessageId, payload) {
  const isRich = payload && typeof payload === 'object' && !Array.isArray(payload);
  if (isRich && Array.isArray(payload.parts)) {
    let firstMessageId = replyToMessageId;
    for (const part of payload.parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'table') {
        try {
          const png = await renderMarkdownTableToPng(String(part.markdown || ''));
          if (png && png.length) {
            await sendPhotoReply(chatId, firstMessageId, png);
            firstMessageId = undefined;
            continue;
          }
        } catch (err) {
          console.error(`table render error: ${err.message}`);
        }
        const fallback = String(part.markdown || '').trim() || '(table)';
        const chunks = chunkText(fallback, TELEGRAM_MAX_MESSAGE);
        for (let i = 0; i < chunks.length; i += 1) {
          await sendMessageWithLog(chatId, {
            chat_id: chatId,
            text: chunks[i],
            reply_to_message_id: firstMessageId,
            allow_sending_without_reply: true,
            disable_web_page_preview: true,
          }, {
            kind: 'table-fallback',
            chunkIndex: i + 1,
            chunkTotal: chunks.length,
          });
          firstMessageId = undefined;
        }
        continue;
      }

      const partText = String(part.text || '');
      const partParseMode = part.parseMode ? String(part.parseMode) : '';
      const partChunks = partParseMode === 'HTML'
        ? chunkHtmlText(partText || '(No response)', TELEGRAM_MAX_MESSAGE)
        : chunkText(partText || '(No response)', TELEGRAM_MAX_MESSAGE);
      for (let i = 0; i < partChunks.length; i += 1) {
        const messagePayload = {
          chat_id: chatId,
          text: partChunks[i],
          reply_to_message_id: firstMessageId,
          allow_sending_without_reply: true,
          disable_web_page_preview: true,
        };
        if (partParseMode) messagePayload.parse_mode = partParseMode;
        await sendMessageWithLog(chatId, messagePayload, {
          kind: 'part-text',
          chunkIndex: i + 1,
          chunkTotal: partChunks.length,
        });
        firstMessageId = undefined;
      }
    }
    return;
  }

  const text = isRich ? String(payload.text || '') : String(payload || '');
  const parseMode = isRich && payload.parseMode ? String(payload.parseMode) : '';
  const normalized = text || '(No response)';
  const chunks = parseMode === 'HTML'
    ? chunkHtmlText(normalized, TELEGRAM_MAX_MESSAGE)
    : chunkText(normalized, TELEGRAM_MAX_MESSAGE);
  for (let i = 0; i < chunks.length; i += 1) {
    const messagePayload = {
      chat_id: chatId,
      text: chunks[i],
      reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    };
    if (parseMode) messagePayload.parse_mode = parseMode;
    await sendMessageWithLog(chatId, messagePayload, {
      kind: 'text',
      chunkIndex: i + 1,
      chunkTotal: chunks.length,
    });
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseSourceReferences(text) {
  const sourceMap = new Map();
  const kept = [];
  const lines = String(text || '').split('\n');
  const sourceLine = /^\[(\d+)\]\s+\[[^\]]+\]\((https?:\/\/[^)\s]+(?:\)[^)\s]*)?)\)\s*$/i;
  for (const line of lines) {
    const m = line.trim().match(sourceLine);
    if (m) {
      sourceMap.set(Number(m[1]), m[2]);
      continue;
    }
    kept.push(line);
  }
  return {
    body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    sourceMap,
  };
}

function inlineCitationsAsHtml(text, sourceMap) {
  if (!sourceMap || !sourceMap.size) return escapeHtml(text);
  const placeholders = new Map();
  let seq = 0;
  const withTokens = String(text || '').replace(/\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g, (full, numsRaw) => {
    const nums = numsRaw
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!nums.length) return full;

    let linkedCount = 0;
    const rendered = nums.map((n) => {
      const url = sourceMap.get(n);
      if (!url) return String(n);
      linkedCount += 1;
      return `<a href="${escapeHtml(url)}">${n}</a>`;
    });
    if (!linkedCount) return full;

    const key = `__CITE_${seq++}__`;
    placeholders.set(key, `[${rendered.join(', ')}]`);
    return key;
  });

  let escaped = escapeHtml(withTokens);
  for (const [key, html] of placeholders) {
    escaped = escaped.split(key).join(html);
  }
  return escaped;
}

function applyBasicMarkdownToTelegramHtml(text) {
  const placeholders = new Map();
  let seq = 0;
  const stash = (value) => {
    const key = `__MD_SEG_${seq++}__`;
    placeholders.set(key, value);
    return key;
  };

  let out = String(text || '');

  out = out.replace(/```[ \t]*([^\n`]*)\n([\s\S]*?)```/g, (_full, _lang, code) => {
    const trimmed = String(code || '').replace(/\n+$/, '');
    return stash(`<pre><code>${trimmed}</code></pre>`);
  });

  out = out.replace(/`([^`\n]+)`/g, (_full, code) => stash(`<code>${code}</code>`));

  out = out
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');

  for (const [key, value] of placeholders) {
    out = out.split(key).join(value);
  }
  return out;
}

function formatTelegramHtmlFromModelText(text, sourceMap) {
  const withCitations = inlineCitationsAsHtml(text, sourceMap);
  return applyBasicMarkdownToTelegramHtml(withCitations);
}

function splitMarkdownRow(line) {
  let row = String(line || '').trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
}

function looksLikeMarkdownTableHeader(line) {
  const raw = String(line || '');
  if (!raw.includes('|')) return false;
  const cells = splitMarkdownRow(raw);
  return cells.length >= 2 && cells.some((c) => c.length > 0);
}

function splitMarkdownTables(text) {
  const lines = String(text || '').split('\n');
  const parts = [];
  const pendingText = [];
  const flushText = () => {
    const block = pendingText.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    pendingText.length = 0;
    if (block) parts.push({ type: 'text', text: block });
  };

  for (let i = 0; i < lines.length;) {
    const a = lines[i] || '';
    const b = lines[i + 1] || '';
    if (i + 1 < lines.length && looksLikeMarkdownTableHeader(a) && isMarkdownTableSeparator(b)) {
      flushText();
      const tableLines = [a, b];
      i += 2;
      while (i < lines.length) {
        const cur = lines[i] || '';
        if (!cur.trim()) break;
        if (!cur.includes('|')) break;
        tableLines.push(cur);
        i += 1;
      }
      parts.push({ type: 'table', markdown: tableLines.join('\n').trim() });
      continue;
    }
    pendingText.push(a);
    i += 1;
  }
  flushText();
  return parts;
}

function parseMarkdownTable(markdown) {
  const lines = String(markdown || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  if (!looksLikeMarkdownTableHeader(lines[0]) || !isMarkdownTableSeparator(lines[1])) return null;
  const headers = splitMarkdownRow(lines[0]);
  if (headers.length < 2) return null;
  const rows = [];
  for (let i = 2; i < lines.length; i += 1) {
    if (!lines[i].includes('|')) continue;
    const row = splitMarkdownRow(lines[i]);
    if (!row.length) continue;
    while (row.length < headers.length) row.push('');
    if (row.length > headers.length) row.length = headers.length;
    rows.push(row);
  }
  return { headers, rows };
}

function buildTableHtml(table) {
  const head = table.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
  const body = table.rows.map((row) => {
    const cells = row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; padding: 16px; background: #f4f6fb; }
    #capture { display: inline-block; background: #ffffff; padding: 8px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    table { border-collapse: collapse; font-family: "Segoe UI", Arial, sans-serif; font-size: 14px; color: #1f2937; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #0ea5e9; color: #ffffff; font-weight: 600; }
    tr:nth-child(even) td { background: #f8fafc; }
  </style>
</head>
<body>
  <div id="capture">
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
</body>
</html>`;
}

async function renderMarkdownTableToPng(markdown) {
  const table = parseMarkdownTable(markdown);
  if (!table) return null;

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${BROWSER_PORT}`,
    defaultViewport: null,
  });
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
    await page.setContent(buildTableHtml(table), { waitUntil: 'domcontentloaded' });
    const capture = await page.$('#capture');
    if (!capture) return null;
    const png = await capture.screenshot({ type: 'png' });
    return Buffer.isBuffer(png) ? png : Buffer.from(png);
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

function formatModelReplyForTelegram(text) {
  let output = (text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  if (!output) return { text: '(No response)', parseMode: 'HTML' };
  output = output
    .split('\n')
    .filter((line) => !/^export to sheets$/i.test(String(line || '').trim()))
    .join('\n')
    .trim();
  if (!output) return { text: '(No response)', parseMode: 'HTML' };

  const hasLineBreaks = output.includes('\n');
  if (!hasLineBreaks) {
    output = output
      .replace(/\s(\d{1,2}\.)\s+/g, '\n\n$1 ')
      .replace(/\s([A-Z][A-Za-z'() -]{2,40}:)\s+/g, '\n- $1 ');
  }

  const normalized = output
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const { body, sourceMap } = parseSourceReferences(normalized);
  const base = body || normalized;
  const segments = splitMarkdownTables(base);
  if (segments.some((s) => s.type === 'table')) {
    const parts = [];
    for (const seg of segments) {
      if (seg.type === 'table') {
        parts.push({ type: 'table', markdown: seg.markdown });
        continue;
      }
      const html = formatTelegramHtmlFromModelText(seg.text || '', sourceMap).trim();
      if (html) parts.push({ type: 'text', text: html, parseMode: 'HTML' });
    }
    if (!parts.length) return { text: '(No response)', parseMode: 'HTML' };
    return { parts };
  }

  const htmlText = formatTelegramHtmlFromModelText(base, sourceMap);
  return { text: htmlText || '(No response)', parseMode: 'HTML' };
}

function formatChatTitlePreview(title, model) {
  const clean = (title || '').replace(/\s+/g, ' ').trim() || 'Untitled chat';
  if (model !== 'aimode') return clean;
  if (clean.length <= AI_MODE_CHAT_PREVIEW_MAX) return clean;
  return `${clean.slice(0, AI_MODE_CHAT_PREVIEW_MAX - 3).trimEnd()}...`;
}

function toChatRefKey(chat) {
  if (!chat) return '';
  const href = (chat.href || '').trim();
  const clickIndex = Number.isInteger(chat.clickIndex) ? chat.clickIndex : -1;
  const title = (chat.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${href}|${clickIndex}|${title}`;
}

function formatChatsReply(chats, model, session = null) {
  const selectedKey = session && session.selectedChatKey ? session.selectedChatKey : '';
  const hasSelected = Boolean(session && session.chatSelected);
  const selectedTitle = session && session.selectedChatTitle ? session.selectedChatTitle : '';

  const selectedIndex = selectedKey
    ? chats.findIndex((chat) => toChatRefKey(chat) === selectedKey)
    : -1;

  const selectedLine = (() => {
    if (!hasSelected) return 'Current selected chat: (none)';
    if (selectedIndex >= 0) {
      return `Current selected chat: ${selectedIndex + 1}. ${formatChatTitlePreview(chats[selectedIndex].title, model)}`;
    }
    if (selectedTitle) return `Current selected chat: ${selectedTitle}`;
    return 'Current selected chat: (active, not in recent list)';
  })();

  if (!chats.length) {
    return `${selectedLine}\n\nNo recent chats found.`;
  }

  const lines = chats.map((chat, idx) => {
    const base = `${idx + 1}. ${formatChatTitlePreview(chat.title, model)}`;
    return idx === selectedIndex ? `${base} [selected]` : base;
  });
  return `${selectedLine}\n\nRecent chats:\n${lines.join('\n')}\n\nUse /chat <number> to switch.`;
}

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start + 500) end = lastBreak;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function isInsideHtmlTag(text, index) {
  const lt = text.lastIndexOf('<', index - 1);
  if (lt < 0) return false;
  const gt = text.lastIndexOf('>', index - 1);
  return lt > gt;
}

function chunkHtmlText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      let cut = text.lastIndexOf('\n', end);
      if (cut <= start + 200) cut = text.lastIndexOf(' ', end);
      if (cut > start + 50) end = cut;
      while (end > start + 50 && isInsideHtmlTag(text, end)) {
        end -= 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function registerTelegramCommands() {
  const commands = [
    { command: 'help', description: 'Show usage instructions' },
    { command: 'newchat', description: 'Start a fresh chat in current model' },
    { command: 'chat', description: 'List or switch chats: /chat [number]' },
    { command: 'whoami', description: 'Show your Telegram user ID' },
    { command: 'model', description: 'Show or set model' },
  ];
  const scopes = [
    null,
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
  ];
  for (const scope of scopes) {
    const payload = scope ? { commands, scope } : { commands };
    await telegramCall('setMyCommands', payload);
  }
}

function getUserLogMeta(message) {
  const userId = String((message && message.from && message.from.id) || '');
  const username = message && message.from && message.from.username ? `@${message.from.username}` : '(none)';
  const chatId = String((message && message.chat && message.chat.id) || '');
  return { userId: userId || '(unknown)', username, chatId: chatId || '(unknown)' };
}

function logIncomingEvent(message, type, content) {
  const { userId, username, chatId } = getUserLogMeta(message);
  const compact = (content || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  console.log(
    `[incoming] type=${type} chat_id=${chatId} user_id=${userId} username=${username} text=${JSON.stringify(compact)}`
  );
}

function detectTriggerType(message, text, entities) {
  if (entities.some((entity) => isTriggerMentionEntity(entity, text))) return 'tag';
  if (!TELEGRAM_TRIGGER_USERNAME) return 'message';
  const mentionRegex = new RegExp(`(^|\\s)@${escapeRegex(TELEGRAM_TRIGGER_USERNAME)}\\b`, 'i');
  return mentionRegex.test(text || '') ? 'tag' : 'message';
}

function getChatSession(sessionByChatId, chatId) {
  const existing = sessionByChatId.get(chatId);
  if (existing) return existing;
  const created = {
    model: 'aimode',
    chatSelected: true,
    selectedChatKey: '',
    selectedChatTitle: '(auto new chat pending)',
    autoNewChatPending: true,
  };
  sessionByChatId.set(chatId, created);
  return created;
}

async function main() {
  const me = await telegramCall('getMe', {});
  const botUsername = me && me.username ? me.username : '';
  const bridge = new GeminiBridge(BROWSER_PORT, { gemini: GEMINI_URL, ai: AI_MODE_URL });
  try {
    await registerTelegramCommands();
  } catch (err) {
    console.error(`setMyCommands failed: ${err.message}`);
  }

  console.log(`Telegram bot ready as @${botUsername || 'unknown'}.`);
  console.log(`Trigger username: ${TELEGRAM_TRIGGER_USERNAME ? '@' + TELEGRAM_TRIGGER_USERNAME : '(reply-only mode)'}`);
  console.log(`Browser endpoint: http://127.0.0.1:${BROWSER_PORT}`);
  console.log(`Startup state: default model=${formatModelDisplayName('aimode')} [aimode], chat=(auto new chat pending)`);
  console.log(`Include staging: private bot chat forwards (window=${Math.round(INCLUDE_STAGING_WINDOW_MS / 60000)}m)`);
  console.log(`Name map TSV: ${TELEGRAM_NAME_MAP_TSV || '(disabled)'} (entries=${NAME_MAP_ENTRIES.length})`);

  let offset = 0;
  let queue = Promise.resolve();
  const recentChatsByTelegramChatId = new Map();
  const sessionByTelegramChatId = new Map();
  const recentMessageHistoryByChatId = new Map();
  const includeForwardedByUserId = new Map();

  while (true) {
    try {
      const updates = await telegramCall('getUpdates', {
        timeout: POLL_TIMEOUT_SECONDS,
        offset,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message) continue;
        if (addForwardedStagingMessage(includeForwardedByUserId, message)) {
          logIncomingEvent(message, 'staging:forward', getMessageTextData(message).text || '[forwarded]');
          continue;
        }
        addMessageToChatHistory(recentMessageHistoryByChatId, message);
        if (!isSenderAllowed(message)) continue;

        const text = (message.text || message.caption || '').trim();
        const telegramChatId = String(message.chat.id);
        const session = getChatSession(sessionByTelegramChatId, telegramChatId);
        const currentModel = session.model;

        if (isWhoAmICommand(text, botUsername)) {
          logIncomingEvent(message, 'command:/whoami', text);
          const userId = String(message.from && message.from.id ? message.from.id : '');
          const username = message.from && message.from.username ? `@${message.from.username}` : '(none)';
          await sendReply(
            message.chat.id,
            message.message_id,
            `user_id: ${userId || '(unknown)'}\nusername: ${username}\nchat_id: ${telegramChatId}`
          );
          continue;
        }

        if (isHelpCommand(text, botUsername)) {
          logIncomingEvent(message, 'command:/help', text);
          await sendReply(message.chat.id, message.message_id, buildHelpText(botUsername));
          continue;
        }

        const modelCommand = parseModelCommand(text, botUsername);
        if (modelCommand) {
          logIncomingEvent(message, 'command:/model', text);
          if (modelCommand.error) {
            await sendReply(message.chat.id, message.message_id, modelCommand.error);
            continue;
          }
          if (modelCommand.query) {
            if (!currentModel) {
              await sendReply(
                message.chat.id,
                message.message_id,
                `Current model: (not set)\n${buildModelUsageText()}`
              );
            } else {
              const chatState = session.autoNewChatPending
                ? 'auto new chat pending'
                : (session.chatSelected ? 'selected' : 'not selected');
              await sendReply(
                message.chat.id,
                message.message_id,
                `Current model: ${formatModelDisplayName(currentModel)} [${currentModel}]\nCurrent chat: ${chatState}\n${buildModelUsageText()}`
              );
            }
            continue;
          }
          session.model = modelCommand.model;
          session.chatSelected = false;
          session.selectedChatKey = '';
          session.selectedChatTitle = '';
          session.autoNewChatPending = false;
          recentChatsByTelegramChatId.delete(telegramChatId);
          if (modelCommand.model === 'none') {
              await sendReply(
                message.chat.id,
                message.message_id,
                'Model set to None (Disabled) [none].\nBot responses are now disabled for prompts in this chat.\nUse /model geminifast, /model geminithinking, or /model aimode to re-enable.'
              );
          } else {
            session.chatSelected = true;
            session.selectedChatTitle = '(auto new chat pending)';
            session.autoNewChatPending = true;
            queue = queue.then(async () => {
              await bridge.startNewChat(modelCommand.model);
              session.autoNewChatPending = false;
              session.selectedChatTitle = '(new chat started automatically)';
              await sendReply(
                message.chat.id,
                message.message_id,
                `Model set to ${formatModelDisplayName(modelCommand.model)} [${modelCommand.model}].\nStarted a new ${formatModelDisplayName(modelCommand.model)} chat automatically.`
              );
            }).catch(async (err) => {
              session.autoNewChatPending = true;
              session.chatSelected = true;
              console.error('model switch auto-newchat error:', err.message);
              await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
            });
          }
          continue;
        }

        if (isNewChatCommand(text, botUsername)) {
          logIncomingEvent(message, 'command:/newchat', text);
          if (!currentModel) {
              await sendReply(
                message.chat.id,
                message.message_id,
                'Model not selected. Use /model geminifast, /model geminithinking, or /model aimode first.'
              );
            continue;
          }
          if (currentModel === 'none') {
              await sendReply(
                message.chat.id,
                message.message_id,
                'Model is None (Disabled). Use /model geminifast, /model geminithinking, or /model aimode first.'
              );
            continue;
          }
          queue = queue.then(async () => {
            await bridge.startNewChat(currentModel);
            session.chatSelected = true;
            session.selectedChatKey = '';
            session.selectedChatTitle = '(new chat started via /newchat)';
            session.autoNewChatPending = false;
            await sendReply(
              message.chat.id,
              message.message_id,
              `Started a new ${formatModelDisplayName(currentModel)} chat.`
            );
          }).catch(async (err) => {
            console.error('newchat error:', err.message);
            await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
          });
          continue;
        }

        const chatCommand = parseChatCommand(text, botUsername);
        if (chatCommand) {
          logIncomingEvent(message, 'command:/chat', text);
          if (!currentModel) {
              await sendReply(
                message.chat.id,
                message.message_id,
                'Model not selected. Use /model geminifast, /model geminithinking, or /model aimode first.'
              );
            continue;
          }
          if (currentModel === 'none') {
              await sendReply(
                message.chat.id,
                message.message_id,
                'Model is None (Disabled). Use /model geminifast, /model geminithinking, or /model aimode first.'
              );
            continue;
          }
          if (chatCommand.error) {
            await sendReply(message.chat.id, message.message_id, chatCommand.error);
            continue;
          }
          queue = queue.then(async () => {
            if (chatCommand.list) {
              const chats = await bridge.listRecentChats(currentModel, 20);
              recentChatsByTelegramChatId.set(telegramChatId, chats.map((c) => ({ ...c, model: currentModel })));
              await sendReply(message.chat.id, message.message_id, formatChatsReply(chats, currentModel, session));
              return;
            }
            const chats = recentChatsByTelegramChatId.get(telegramChatId) || [];
            if (!chats.length) {
              await sendReply(message.chat.id, message.message_id, 'No chat list is cached yet. Run /chat first.');
              return;
            }
            const selected = chats[chatCommand.index - 1];
            if (!selected) {
              await sendReply(
                message.chat.id,
                message.message_id,
                `Invalid chat number. Choose 1-${chats.length} from the latest /chat list.`
              );
              return;
            }
            await bridge.selectChat(selected);
            session.chatSelected = true;
            session.selectedChatKey = toChatRefKey(selected);
            session.selectedChatTitle = formatChatTitlePreview(selected.title, currentModel);
            session.autoNewChatPending = false;
            await sendReply(
              message.chat.id,
              message.message_id,
              `Switched to chat ${chatCommand.index}: ${formatChatTitlePreview(selected.title, currentModel)}\n(No previous messages were sent to Telegram.)`
            );
          }).catch(async (err) => {
            console.error('chat command error:', err.message);
            await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
          });
          continue;
        }

        if (!shouldHandleMessage(message)) continue;
        const { entities } = getMessageTextData(message);
        const triggerType = detectTriggerType(message, text, entities);
        logIncomingEvent(message, `prompt:${triggerType}`, text);

        if (currentModel === 'none') {
          // Silent mode: ignore triggered prompts while model is explicitly set to none.
          continue;
        }
        if (!currentModel) {
          await sendReply(
            message.chat.id,
            message.message_id,
            'Model not selected. Use /model geminifast, /model geminithinking, or /model aimode first.'
          );
          continue;
        }
        if (!session.chatSelected) {
          await sendReply(
            message.chat.id,
            message.message_id,
            'No chat selected. Run /newchat to start one, or /chat then /chat <number> to select one.'
          );
          continue;
        }

        const prompt = extractPrompt(message);
        if (!prompt) {
          await sendReply(message.chat.id, message.message_id, 'I saw the trigger, but there was no message text to send.');
          continue;
        }
        const directive = parseChatContextDirective(prompt);
        if (directive.error) {
          await sendReply(message.chat.id, message.message_id, directive.error);
          continue;
        }
        const promptWithMode = applyTelegramPromptMode(directive.prompt);
        if (!promptWithMode && !directive.includeForwarded) {
          await sendReply(
            message.chat.id,
            message.message_id,
            'Usage: [[include]] <message> (also works with leading ~).'
          );
          continue;
        }

        queue = queue.then(async () => {
          if (currentModel !== 'none' && session.autoNewChatPending) {
            await bridge.startNewChat(currentModel);
            session.autoNewChatPending = false;
            session.chatSelected = true;
            session.selectedChatKey = '';
            session.selectedChatTitle = '(new chat started automatically)';
          }
          let includeTempDir = '';
          let includeImagePaths = [];
          let promptForAi = promptWithMode;
          const extraContextBlocks = [];
          if (directive.includeForwarded) {
            const includeConsume = consumeRecentForwardedMessages(
              includeForwardedByUserId,
              String((message.from && message.from.id) || '')
            );
            const includeResult = buildIncludedMessagesContextFromForwarded(includeConsume.picked);
            console.log(
              `[include-buffer] consume picked=${includeConsume.picked.length} stale=${includeConsume.stale} context_lines=${includeResult.count} image_refs=${Array.isArray(includeResult.imageRefs) ? includeResult.imageRefs.length : 0}`
            );
            if (includeResult.context) {
              extraContextBlocks.push(
                ['Forwarded messages:', includeResult.context].join('\n\n')
              );
            }
            if (includeResult.truncated) {
              extraContextBlocks.push(
                `More than ${CHAT_CONTEXT_DIRECTIVE_MAX} forwarded messages found; using the latest ${CHAT_CONTEXT_DIRECTIVE_MAX}.`
              );
            }
            if (includeConsume.stale > 0) {
              extraContextBlocks.push(
                `Skipped ${includeConsume.stale} forwarded staging messages older than ${Math.round(INCLUDE_STAGING_WINDOW_MS / 60000)} minutes.`
              );
            }
            if (Array.isArray(includeResult.imageRefs) && includeResult.imageRefs.length) {
              const prepared = await prepareIncludeImageUploads(includeResult.imageRefs);
              includeImagePaths = prepared.imagePaths;
              includeTempDir = prepared.tempDir;
              console.log(
                `[include-image] prepared uploaded_candidates=${includeImagePaths.length} dropped=${prepared.dropped} temp_dir=${includeTempDir || '(none)'}`
              );
              if (prepared.dropped > 0) {
                extraContextBlocks.push(
                  `Skipped ${prepared.dropped} forwarded images due to max ${INCLUDE_MAX_IMAGES} image upload limit.`
                );
              }
            }
            if (!includeResult.context && (!promptWithMode || !promptWithMode.trim())) {
              await sendReply(
                message.chat.id,
                message.message_id,
                `No forwarded messages from the last ${Math.round(INCLUDE_STAGING_WINDOW_MS / 60000)} minutes found in your private chat with the bot. Forward messages there, then use [[include]].`
              );
              await cleanupIncludeImageUploads(includeTempDir);
              return;
            }
            await deleteForwardedStagingMessages(includeConsume.picked);
          }
          if (extraContextBlocks.length) {
            const requestLine = promptWithMode
              ? promptWithMode
              : 'Analyze the included messages.';
            promptForAi = [
              ...extraContextBlocks,
              requestLine,
            ].join('\n\n');
          }
          promptForAi = applyNameMappingsToText(promptForAi);
          if (promptForAi.length > AI_PROMPT_MAX_CHARS) {
            await sendReply(
              message.chat.id,
              message.message_id,
              `Message too large (${promptForAi.length} chars). Limit is ${AI_PROMPT_MAX_CHARS}. Use gemini for this request.`
            );
            await cleanupIncludeImageUploads(includeTempDir);
            return;
          }
          await telegramCall('sendChatAction', { chat_id: message.chat.id, action: 'typing' });
          try {
            const answer = await bridge.ask(promptForAi, currentModel, { imagePaths: includeImagePaths });
            const answerWithOriginalNames = reverseNameMappingsInText(answer);
            const formattedAnswer = formatModelReplyForTelegram(answerWithOriginalNames);
            await sendReply(message.chat.id, message.message_id, formattedAnswer);
          } finally {
            await cleanupIncludeImageUploads(includeTempDir);
          }
        }).catch(async (err) => {
          console.error('message error:', err.message);
          await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
        });
      }
    } catch (err) {
      console.error('polling error:', err.message);
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
