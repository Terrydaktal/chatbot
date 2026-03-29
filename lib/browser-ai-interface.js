'use strict';

const INPUT_SELECTORS = [
  '.ITIRGe',
  'textarea[aria-label="Ask anything"]',
  '.ql-editor',
  'textarea',
  '[contenteditable="true"]',
];

const AI_INPUT_SELECTORS = [
  '.ITIRGe',
  'textarea[aria-label="Ask anything"]',
  'textarea',
  '[contenteditable="true"]',
];

const RESPONSE_SELECTOR = '.model-response-text, .markdown, .message-content';
const RESPONSE_CONTAINER_SELECTOR = 'response-container, .response-container';
const AI_RESPONSE_SELECTOR = '[data-xid="aim-mars-turn-root"] [data-xid="VpUvz"], [data-xid="aim-mars-turn-root"]';
const AI_RESPONSE_CONTAINER_SELECTOR = '[data-xid="aim-mars-turn-root"]';
const AI_SEND_SELECTORS = ['button[aria-label="Send"]', 'button[data-xid="input-plate-send-button"]', '.OEueve'];
const MODEL_BADGE_SELECTORS = [
  '[data-test-id="bard-mode-menu-button"]',
  'button.input-area-switch',
  'button[aria-haspopup="menu"]',
  '.model-selector',
  'button[data-test-id="model-selector"]',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeResponseTextPreservingBreaks(text) {
  const raw = (text || '').replace(/\u00a0/g, ' ');
  return raw
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class BrowserAiInterface {
  getModelConfig(model) {
    if (model === 'aimode') {
      return {
        inputSelectors: AI_INPUT_SELECTORS,
        responseSelector: AI_RESPONSE_SELECTOR,
        responseContainerSelector: AI_RESPONSE_CONTAINER_SELECTOR,
      };
    }
    return {
      inputSelectors: INPUT_SELECTORS,
      responseSelector: RESPONSE_SELECTOR,
      responseContainerSelector: RESPONSE_CONTAINER_SELECTOR,
    };
  }

  async findVisibleInput(page, selectors, options = {}) {
    const preferAiMode = Boolean(options.preferAiMode);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
    const selector = selectors.join(', ');

    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
    } catch {}

    const handle = await page.evaluateHandle((selectorList, preferAi) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetHeight > 0 && el.offsetWidth > 0;
      };

      const candidates = [];
      selectorList.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (!isVisible(el)) return;
          const rect = el.getBoundingClientRect();
          candidates.push({
            el,
            bottom: rect.bottom,
            inInputPlate: Boolean(el.closest('div[data-xid="aim-mars-input-plate"]')),
          });
        });
      });
      if (!candidates.length) return null;

      let pool = candidates;
      if (preferAi) {
        const inPlate = candidates.filter((c) => c.inInputPlate);
        if (inPlate.length) pool = inPlate;
      }
      pool.sort((a, b) => b.bottom - a.bottom);
      return pool[0].el;
    }, selectors, preferAiMode);

    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    return element;
  }

  async countResponses(page, model) {
    const config = this.getModelConfig(model);
    return page.evaluate((responseSelector, responseContainerSelector) => {
      const allCandidates = Array.from(document.querySelectorAll(responseSelector));
      const scopedCandidates = allCandidates.filter((el) => el.closest(responseContainerSelector));
      return (scopedCandidates.length ? scopedCandidates : allCandidates).length;
    }, config.responseSelector, config.responseContainerSelector);
  }

  async ensureGeminiModel(page, model) {
    if (model !== 'geminifast' && model !== 'geminipro') return false;

    let modelBadge = null;
    for (const selector of MODEL_BADGE_SELECTORS) {
      modelBadge = await page.$(selector);
      if (modelBadge) break;
    }
    if (!modelBadge) return false;

    const targetKeywords = model === 'geminifast'
      ? ['flash', 'fast']
      : ['advanced', 'pro', 'ultra'];
    const targetDataTestId = model === 'geminifast'
      ? 'button[data-test-id="bard-mode-option-fast"]'
      : 'button[data-test-id="bard-mode-option-pro"]';

    const badgeText = await page.evaluate((el) => (el.innerText || '').trim().toLowerCase(), modelBadge).catch(() => '');
    if (targetKeywords.some((kw) => badgeText.includes(kw))) return false;

    await modelBadge.click().catch(() => {});
    await sleep(300);

    let targetOption = await page.$(targetDataTestId);
    if (!targetOption) {
      targetOption = await page.evaluateHandle((keywords) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find((b) => {
          const text = (b.innerText || '').trim().toLowerCase();
          return keywords.some((kw) => text.includes(kw));
        }) || null;
      }, targetKeywords).then((h) => (h && h.asElement ? h.asElement() : null)).catch(() => null);
    }
    if (!targetOption) return false;

    await targetOption.click().catch(() => {});
    await sleep(800);
    return true;
  }

  async ensureGeminiFastSelected(page) {
    return this.ensureGeminiModel(page, 'geminifast');
  }

  async sendPrompt(page, options) {
    const prompt = (options && options.prompt ? String(options.prompt) : '').trim();
    if (!prompt) throw new Error('Empty prompt.');

    const model = options && options.model ? options.model : 'geminifast';
    const config = this.getModelConfig(model);
    const preferAiMode = Boolean(options && options.preferAiMode);
    const selectors = (options && Array.isArray(options.inputSelectors) && options.inputSelectors.length)
      ? options.inputSelectors
      : config.inputSelectors;

    const input = await this.findVisibleInput(page, selectors, { preferAiMode, timeoutMs: 1500 });
    if (!input) throw new Error('Could not find a visible input field.');

    const initialCount = Number.isFinite(options && options.initialCount)
      ? options.initialCount
      : await this.countResponses(page, model);

    await page.evaluate((el) => {
      el.focus();
      if ('value' in el) {
        el.value = '';
      }
      if (el.isContentEditable) {
        // Avoid innerHTML writes: some surfaces enforce Trusted Types.
        el.textContent = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input);

    await input.focus();
    await page.keyboard.type(prompt);

    if (model === 'aimode') {
      const clicked = await page.evaluate((sendSelectors) => {
        const isClickable = (btn) => {
          if (!btn) return false;
          if (btn.disabled) return false;
          if (btn.getAttribute('aria-disabled') === 'true') return false;
          return true;
        };
        for (const selector of sendSelectors) {
          const btn = document.querySelector(selector);
          if (isClickable(btn)) {
            btn.click();
            return true;
          }
        }
        return false;
      }, AI_SEND_SELECTORS).catch(() => false);
      if (!clicked) {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    await input.dispose().catch(() => {});

    return {
      initialCount,
      responseSelector: config.responseSelector,
      responseContainerSelector: config.responseContainerSelector,
    };
  }

  async waitForStableResponse(page, options) {
    const initialCount = Number(options && options.initialCount ? options.initialCount : 0);
    const prompt = options && options.prompt ? String(options.prompt) : '';
    const model = options && options.model ? options.model : 'geminifast';
    const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 180000;
    const pollMs = Number.isFinite(options && options.pollMs) ? options.pollMs : 900;

    const config = this.getModelConfig(model);
    const timeoutAt = Date.now() + timeoutMs;
    const promptNorm = normalizeText(prompt);
    let previous = '';
    let stableTicks = 0;

    while (Date.now() < timeoutAt) {
      const { count, lastText } = await page.evaluate((selector) => {
        const texts = Array.from(document.querySelectorAll(selector))
          .map((el) => (el.innerText || el.textContent || ''))
          .map((text) => text.replace(/\u00a0/g, ' '))
          .map((text) => text
            .split('\n')
            .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim())
          .filter(Boolean);
        return { count: texts.length, lastText: texts[texts.length - 1] || '' };
      }, config.responseSelector);

      const candidate = normalizeResponseTextPreservingBreaks(lastText);
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

      await sleep(pollMs);
    }

    throw new Error('Timed out waiting for response.');
  }

  async ask(page, options) {
    const model = options && options.model ? options.model : 'geminifast';
    if (model === 'geminifast') {
      await this.ensureGeminiFastSelected(page);
    }

    const sent = await this.sendPrompt(page, options || {});
    if (options && typeof options.waitForResponse === 'function') {
      return options.waitForResponse({
        initialCount: sent.initialCount,
        responseSelector: sent.responseSelector,
        responseContainerSelector: sent.responseContainerSelector,
      });
    }

    return this.waitForStableResponse(page, {
      initialCount: sent.initialCount,
      prompt: options && options.prompt ? options.prompt : '',
      model,
    });
  }
}

module.exports = {
  BrowserAiInterface,
  SELECTORS: {
    INPUT_SELECTORS,
    AI_INPUT_SELECTORS,
    RESPONSE_SELECTOR,
    RESPONSE_CONTAINER_SELECTOR,
    AI_RESPONSE_SELECTOR,
    AI_RESPONSE_CONTAINER_SELECTOR,
    AI_SEND_SELECTORS,
  },
  sleep,
};
