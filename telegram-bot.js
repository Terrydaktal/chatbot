#!/usr/bin/env node
'use strict';

const puppeteer = require('puppeteer-core');
const { BrowserAiInterface } = require('./lib/browser-ai-interface');

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
    }
  }

  async ask(promptText, model) {
    const prompt = (promptText || '').trim();
    if (!prompt) throw new Error('Empty prompt.');
    const page = await this.ensurePage(model, false);
    return this.ai.ask(page, {
      prompt,
      model,
      preferAiMode: model === 'aimode',
    });
  }

  async ensureGeminiFastSelected(page) {
    await this.ai.ensureGeminiFastSelected(page);
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

function isSenderAllowed(message) {
  if (!TELEGRAM_ALLOWED_USER_IDS || !TELEGRAM_ALLOWED_USER_IDS.size) return true;
  const senderId = String((message && message.from && message.from.id) || '');
  return TELEGRAM_ALLOWED_USER_IDS.has(senderId);
}

function shouldHandleMessage(message) {
  if (!message) return false;
  if (message.from && message.from.is_bot) return false;
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
  if (!input) return { count: 0, includeBots: false, prompt: '' };

  const direct = input.match(/^\[\[last:(\d{1,3})(:all)?\]\]\s*/i);
  if (direct) {
    const count = Math.max(1, Math.min(CHAT_CONTEXT_DIRECTIVE_MAX, Number(direct[1])));
    return { count, includeBots: Boolean(direct[2]), prompt: input.slice(direct[0].length).trim() };
  }

  const conciseFirst = input.match(/^~\s*\[\[last:(\d{1,3})(:all)?\]\]\s*/i);
  if (conciseFirst) {
    const count = Math.max(1, Math.min(CHAT_CONTEXT_DIRECTIVE_MAX, Number(conciseFirst[1])));
    const rest = input.slice(conciseFirst[0].length).trim();
    return { count, includeBots: Boolean(conciseFirst[2]), prompt: rest ? `~ ${rest}` : '~' };
  }

  return { count: 0, includeBots: false, prompt: input };
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

function buildChatContext(historyMap, chatId, currentMessageId, count, includeBots = false) {
  const bucket = historyMap.get(chatId) || [];
  if (!bucket.length || !count) return '';

  const entries = bucket
    .filter((item) => item.messageId !== Number(currentMessageId) && (includeBots || !item.isBot))
    .slice(-count);
  if (!entries.length) return '';

  const lines = entries.map((item, idx) => {
    const who = item.username || item.displayName || (item.userId ? `user_${item.userId}` : 'user');
    return `[${idx + 1}] ${who}: ${item.text}`;
  });
  return lines.join('\n');
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

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatSenderLabel(sender) {
  if (!sender) return 'unknown';
  if (sender.username) return `@${sender.username}`;
  const first = sender.first_name || '';
  const last = sender.last_name || '';
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (sender.id) return `user_${sender.id}`;
  return 'unknown';
}

function buildReplyQuoteContext(message) {
  if (!message || !message.reply_to_message) return '';

  const replied = message.reply_to_message;
  const repliedText = normalizeInlineText(getMessageTextData(replied).text);
  const selectedQuote = normalizeInlineText(message.quote && message.quote.text);
  if (!repliedText && !selectedQuote) return '';

  const lines = [
    'Quoted/replied message context:',
    `- From: ${formatSenderLabel(replied.from)}`,
  ];
  if (repliedText) lines.push(`- Referenced message: ${repliedText}`);
  if (selectedQuote && selectedQuote !== repliedText) lines.push(`- Quoted excerpt: ${selectedQuote}`);
  return lines.join('\n');
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
    '1. Default model is aimode (or change with /model <geminifast|aimode|none>)',
    '2. Run /newchat  (or /chat then /chat <number>)',
    '',
    'Commands:',
    '/help - Show this help text',
    '/whoami - Show your Telegram user ID and chat ID',
    '/model - Show current model + available models',
    '/model geminifast - Enable Gemini Fast mode',
    '/model aimode - Enable Google AI Mode',
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
    '- If you tag while replying/quoting, referenced text is included as context',
    '',
    'Extra context directives (start of prompt):',
    '- [[last:X]] include last X non-bot messages (max 50)',
    '- [[last:X:all]] include last X messages including bot',
    '- Works with concise mode too: ~ [[last:20]] ...',
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
  if (!model) return { error: 'Usage: /model <geminifast|aimode|none>' };
  return { model };
}

function normalizeModel(value) {
  const v = (value || '').toString().trim().toLowerCase();
  if (v === 'none' || v === 'off' || v === 'silent') return 'none';
  if (v === 'ai' || v === 'aimode' || v === 'ai-mode') return 'aimode';
  if (v === 'geminifast' || v === 'fast' || v === 'flash' || v === 'gemini') return 'geminifast';
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

async function sendReply(chatId, replyToMessageId, payload) {
  const isRich = payload && typeof payload === 'object' && !Array.isArray(payload);
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
    await telegramCall('sendMessage', messagePayload);
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

function formatModelReplyForTelegram(text) {
  let output = (text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
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
  const htmlText = inlineCitationsAsHtml(body || normalized, sourceMap);
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
    { command: 'model', description: 'Show or set model: /model geminifast|aimode|none' },
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
  const created = { model: 'aimode', chatSelected: false, selectedChatKey: '', selectedChatTitle: '' };
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
  console.log('Startup state: default model=aimode, chat=(not selected)');

  let offset = 0;
  let queue = Promise.resolve();
  const recentChatsByTelegramChatId = new Map();
  const sessionByTelegramChatId = new Map();
  const recentMessageHistoryByChatId = new Map();

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
                'Current model: (not set)\nAvailable models: geminifast, aimode, none\nUse /model <geminifast|aimode|none>.'
              );
            } else {
              const chatState = session.chatSelected ? 'selected' : 'not selected';
              await sendReply(
                message.chat.id,
                message.message_id,
                `Current model: ${currentModel}\nCurrent chat: ${chatState}\nAvailable models: geminifast, aimode, none\nUse /model <geminifast|aimode|none>.`
              );
            }
            continue;
          }
          session.model = modelCommand.model;
          session.chatSelected = false;
          session.selectedChatKey = '';
          session.selectedChatTitle = '';
          recentChatsByTelegramChatId.delete(telegramChatId);
          if (modelCommand.model === 'none') {
            await sendReply(
              message.chat.id,
              message.message_id,
              'Model set to none.\nBot responses are now disabled for prompts in this chat.\nUse /model geminifast or /model aimode to re-enable.'
            );
          } else {
            await sendReply(
              message.chat.id,
              message.message_id,
              `Model set to ${modelCommand.model}.\nNow run /newchat or /chat then /chat <number>.`
            );
          }
          continue;
        }

        if (isNewChatCommand(text, botUsername)) {
          logIncomingEvent(message, 'command:/newchat', text);
          if (!currentModel) {
            await sendReply(
              message.chat.id,
              message.message_id,
              'Model not selected. Use /model geminifast or /model aimode first.'
            );
            continue;
          }
          if (currentModel === 'none') {
            await sendReply(
              message.chat.id,
              message.message_id,
              'Model is none (responses disabled). Use /model geminifast or /model aimode first.'
            );
            continue;
          }
          queue = queue.then(async () => {
            await bridge.startNewChat(currentModel);
            session.chatSelected = true;
            session.selectedChatKey = '';
            session.selectedChatTitle = '(new chat started via /newchat)';
            await sendReply(message.chat.id, message.message_id, `Started a new ${currentModel} chat.`);
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
              'Model not selected. Use /model geminifast or /model aimode first.'
            );
            continue;
          }
          if (currentModel === 'none') {
            await sendReply(
              message.chat.id,
              message.message_id,
              'Model is none (responses disabled). Use /model geminifast or /model aimode first.'
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
            'Model not selected. Use /model geminifast or /model aimode first.'
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
        const promptWithMode = applyTelegramPromptMode(directive.prompt);
        if (!promptWithMode) {
          await sendReply(
            message.chat.id,
            message.message_id,
            'Usage: [[last:20]] <message> or [[last:20:all]] <message> (also works with leading ~).'
          );
          continue;
        }

        let promptForAi = promptWithMode;
        const extraContextBlocks = [];
        if (directive.count > 0) {
          const chatContext = buildChatContext(
            recentMessageHistoryByChatId,
            telegramChatId,
            message.message_id,
            directive.count,
            directive.includeBots
          );
          if (chatContext) {
            const contextLabel = directive.includeBots
              ? `Chat context (last ${directive.count} messages, including bot):`
              : `Chat context (last ${directive.count} non-bot messages):`;
            extraContextBlocks.push([contextLabel, chatContext].join('\n'));
          }
        }
        const replyQuoteContext = buildReplyQuoteContext(message);
        if (replyQuoteContext) extraContextBlocks.push(replyQuoteContext);
        if (extraContextBlocks.length) {
          promptForAi = [
            ...extraContextBlocks,
            `User request: ${promptWithMode}`,
          ].join('\n\n');
        }

        queue = queue.then(async () => {
          await telegramCall('sendChatAction', { chat_id: message.chat.id, action: 'typing' });
          const answer = await bridge.ask(promptForAi, currentModel);
          const formattedAnswer = formatModelReplyForTelegram(answer);
          await sendReply(message.chat.id, message.message_id, formattedAnswer);
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
