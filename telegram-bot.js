#!/usr/bin/env node
'use strict';

const puppeteer = require('puppeteer-core');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_TRIGGER_USERNAME = (process.env.TELEGRAM_TRIGGER_USERNAME || '')
  .replace(/^@/, '')
  .toLowerCase();
const TELEGRAM_ALLOWED_CHAT_IDS = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS || '');
const BROWSER_PORT = Number(process.env.BROWSER_PORT || 9233);
const GEMINI_URL = process.env.GEMINI_URL || 'https://gemini.google.com/app?hl=en-gb';
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);

const INPUT_SELECTORS = [
  '.ITIRGe',
  'textarea[aria-label="Ask anything"]',
  '.ql-editor',
  'textarea',
  '[contenteditable="true"]',
];
const RESPONSE_SELECTOR = '.model-response-text, .markdown, .message-content';
const TELEGRAM_MAX_MESSAGE = 4096;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable.');
  process.exit(1);
}

class GeminiBridge {
  constructor(port, url) {
    this.port = port;
    this.url = url;
    this.browser = null;
    this.page = null;
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

  async ensurePage(newChat = false) {
    await this.ensureConnected();
    if (!this.page || this.page.isClosed()) {
      const pages = await this.browser.pages();
      this.page = pages.find((p) => !p.url().startsWith('chrome-extension://')) || await this.browser.newPage();
    }

    const shouldNavigate = newChat || !this.page.url().includes('gemini.google.com');
    if (shouldNavigate) {
      await this.page.goto(this.url, { waitUntil: 'networkidle2', timeout: 60000 });
    }
    await this.page.waitForSelector(INPUT_SELECTORS.join(', '), { timeout: 120000 });
    return this.page;
  }

  async startNewChat() {
    await this.ensurePage(true);
  }

  async listRecentChats(limit = 20) {
    const page = await this.ensurePage(false);
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
    const page = await this.ensurePage(false);

    if (chatRef.href) {
      const targetUrl = chatRef.href.startsWith('http')
        ? chatRef.href
        : new URL(chatRef.href, this.url).toString();
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } else if (Number.isInteger(chatRef.clickIndex) && chatRef.clickIndex >= 0) {
      const clicked = await page.evaluate((index) => {
        const items = document.querySelectorAll('[data-test-id="conversation"]');
        if (!items[index]) return false;
        items[index].scrollIntoView({ block: 'center' });
        items[index].click();
        return true;
      }, chatRef.clickIndex);
      if (!clicked) throw new Error('Could not click selected chat item.');
      try {
        await page.waitForNetworkIdle({ timeout: 10000, idleTime: 500 });
      } catch {}
    } else {
      throw new Error('Selected chat has no usable navigation target.');
    }

    await page.waitForSelector(INPUT_SELECTORS.join(', '), { timeout: 120000 });
  }

  async ask(promptText) {
    const prompt = (promptText || '').trim();
    if (!prompt) throw new Error('Empty prompt.');

    const page = await this.ensurePage(false);
    const input = await findVisibleInput(page, INPUT_SELECTORS);
    if (!input) throw new Error('Could not find a visible Gemini input field.');

    const initialCount = await page.evaluate((selector) => {
      return document.querySelectorAll(selector).length;
    }, RESPONSE_SELECTOR).catch(() => 0);

    await page.evaluate((el) => {
      el.focus();
      if ('value' in el) {
        el.value = '';
      }
      if (el.isContentEditable) {
        el.innerHTML = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input);

    await input.focus();
    await page.keyboard.type(prompt);
    await page.keyboard.press('Enter');
    await input.dispose();

    return waitForGeminiResponse(page, initialCount, prompt);
  }
}

async function findVisibleInput(page, selectors) {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    const visible = await page.evaluate((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    }, handle).catch(() => false);
    if (visible) return handle;
    await handle.dispose();
  }
  return null;
}

async function waitForGeminiResponse(page, initialCount, prompt) {
  const timeoutAt = Date.now() + 180000;
  const promptNorm = normalizeText(prompt);
  let previous = '';
  let stableTicks = 0;

  while (Date.now() < timeoutAt) {
    const { count, lastText } = await page.evaluate((selector) => {
      const texts = Array.from(document.querySelectorAll(selector))
        .map((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return { count: texts.length, lastText: texts[texts.length - 1] || '' };
    }, RESPONSE_SELECTOR);

    const candidate = (lastText || '').trim();
    const candidateNorm = normalizeText(candidate);
    const candidateLooksLikePrompt = candidateNorm === promptNorm;

    if (count > initialCount && candidate && !candidateLooksLikePrompt) {
      if (candidate === previous) {
        stableTicks += 1;
      } else {
        previous = candidate;
        stableTicks = 0;
      }
      if (stableTicks >= 2) {
        return candidate;
      }
    }

    await sleep(900);
  }

  throw new Error('Timed out waiting for Gemini response.');
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

function shouldHandleMessage(message) {
  if (!message) return false;
  if (message.from && message.from.is_bot) return false;
  if (TELEGRAM_ALLOWED_CHAT_IDS && !TELEGRAM_ALLOWED_CHAT_IDS.has(String(message.chat.id))) return false;

  if (message.reply_to_message) return true;

  const body = `${message.text || ''} ${message.caption || ''}`.trim();
  if (!body) return false;
  if (!TELEGRAM_TRIGGER_USERNAME) return false;

  const mentionRegex = new RegExp(`(^|\\s)@${escapeRegex(TELEGRAM_TRIGGER_USERNAME)}\\b`, 'i');
  return mentionRegex.test(body);
}

function extractPrompt(message) {
  let body = `${message.text || ''} ${message.caption || ''}`.trim();
  if (!body) return '';

  if (TELEGRAM_TRIGGER_USERNAME) {
    const mentionRegex = new RegExp(`(^|\\s)@${escapeRegex(TELEGRAM_TRIGGER_USERNAME)}\\b`, 'ig');
    body = body.replace(mentionRegex, ' ').replace(/\s+/g, ' ').trim();
  }
  return body;
}

function isNewChatCommand(text, botUsername) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  const plain = '/newchat';
  const withBot = botUsername ? `/newchat@${botUsername.toLowerCase()}` : '';
  return lower === plain || (withBot && lower === withBot);
}

function isChatsCommand(text, botUsername) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  const plain = '/chats';
  const withBot = botUsername ? `/chats@${botUsername.toLowerCase()}` : '';
  return lower === plain || (withBot && lower === withBot);
}

function parseChatSelectCommand(text, botUsername) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const cmd = parts[0].toLowerCase();
  const plain = '/chat';
  const withBot = botUsername ? `/chat@${botUsername.toLowerCase()}` : '';
  if (cmd !== plain && (!withBot || cmd !== withBot)) return null;
  if (parts.length < 2) return { error: 'Usage: /chat <number>' };
  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 1) return { error: 'Usage: /chat <number>' };
  return { index };
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

async function sendReply(chatId, replyToMessageId, text) {
  const chunks = chunkText(text || '(No response)', TELEGRAM_MAX_MESSAGE);
  for (let i = 0; i < chunks.length; i += 1) {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    });
  }
}

function formatChatsReply(chats) {
  if (!chats.length) return 'No recent chats found.';
  const lines = chats.map((chat, idx) => `${idx + 1}. ${chat.title}`);
  return `Recent chats:\n${lines.join('\n')}`;
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

async function main() {
  const me = await telegramCall('getMe', {});
  const botUsername = me && me.username ? me.username : '';
  const bridge = new GeminiBridge(BROWSER_PORT, GEMINI_URL);

  console.log(`Telegram bot ready as @${botUsername || 'unknown'}.`);
  console.log(`Trigger username: ${TELEGRAM_TRIGGER_USERNAME ? '@' + TELEGRAM_TRIGGER_USERNAME : '(reply-only mode)'}`);
  console.log(`Browser endpoint: http://127.0.0.1:${BROWSER_PORT}`);

  let offset = 0;
  let queue = Promise.resolve();
  const recentChatsByTelegramChatId = new Map();

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

        const text = (message.text || message.caption || '').trim();

        if (isNewChatCommand(text, botUsername)) {
          queue = queue.then(async () => {
            await bridge.startNewChat();
            await sendReply(message.chat.id, message.message_id, 'Started a new Gemini chat.');
          }).catch((err) => console.error('newchat error:', err.message));
          continue;
        }

        if (isChatsCommand(text, botUsername)) {
          queue = queue.then(async () => {
            const chats = await bridge.listRecentChats(20);
            recentChatsByTelegramChatId.set(String(message.chat.id), chats);
            await sendReply(message.chat.id, message.message_id, formatChatsReply(chats));
          }).catch(async (err) => {
            console.error('chats error:', err.message);
            await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
          });
          continue;
        }

        const chatSelect = parseChatSelectCommand(text, botUsername);
        if (chatSelect) {
          if (chatSelect.error) {
            await sendReply(message.chat.id, message.message_id, chatSelect.error);
            continue;
          }
          queue = queue.then(async () => {
            const chats = recentChatsByTelegramChatId.get(String(message.chat.id)) || [];
            if (!chats.length) {
              await sendReply(message.chat.id, message.message_id, 'No chat list is cached yet. Run /chats first.');
              return;
            }
            const selected = chats[chatSelect.index - 1];
            if (!selected) {
              await sendReply(
                message.chat.id,
                message.message_id,
                `Invalid chat number. Choose 1-${chats.length} from the latest /chats list.`
              );
              return;
            }
            await bridge.selectChat(selected);
            await sendReply(
              message.chat.id,
              message.message_id,
              `Switched to chat ${chatSelect.index}: ${selected.title}\n(No previous messages were sent to Telegram.)`
            );
          }).catch(async (err) => {
            console.error('chat select error:', err.message);
            await sendReply(message.chat.id, message.message_id, `Error: ${err.message}`);
          });
          continue;
        }

        if (!shouldHandleMessage(message)) continue;

        const prompt = extractPrompt(message);
        if (!prompt) {
          await sendReply(message.chat.id, message.message_id, 'I saw the trigger, but there was no message text to send.');
          continue;
        }

        queue = queue.then(async () => {
          await telegramCall('sendChatAction', { chat_id: message.chat.id, action: 'typing' });
          const answer = await bridge.ask(prompt);
          await sendReply(message.chat.id, message.message_id, answer);
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
