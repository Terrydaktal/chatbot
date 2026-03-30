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
const AI_RESPONSE_SELECTOR = '[data-xid="VpUvz"], [data-xid="aim-mars-turn-root"]';
const AI_RESPONSE_CONTAINER_SELECTOR = '[data-xid="aim-mars-turn-root"]';

const AI_COPY_BUTTON_SELECTOR = 'button[aria-label="Copy text"]';
const AI_SEND_SELECTORS = ['button[aria-label="Send"]', 'button[data-xid="input-plate-send-button"]', '.OEueve'];
const BROWSER_AI_DEBUG = !/^(0|false|no|off)$/i.test(String(process.env.BROWSER_AI_DEBUG || '1').trim());
const AIMODE_PRE_SEND_BASELINE_COPY = /^(1|true|yes|on)$/i.test(
  String(process.env.AIMODE_PRE_SEND_BASELINE_COPY || '').trim()
);
const AIMODE_COPY_ENABLE_FALLBACK = !/^(0|false|no|off)$/i.test(
  String(process.env.AIMODE_COPY_ENABLE_FALLBACK || '1').trim()
);
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

function tokenOverlapScore(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  const aSet = new Set(aNorm.split(/\s+/).filter(Boolean));
  const bSet = new Set(bNorm.split(/\s+/).filter(Boolean));
  if (!aSet.size || !bSet.size) return 0;
  let shared = 0;
  for (const token of aSet) {
    if (bSet.has(token)) shared += 1;
  }
  return shared / Math.max(1, Math.min(aSet.size, bSet.size));
}

function isMateriallyDifferent(nextNorm, prevNorm, nextRaw = '', prevRaw = '') {
  if (!nextNorm) return false;
  if (!prevNorm) return true;
  if (nextNorm === prevNorm) return false;
  const overlap = tokenOverlapScore(nextNorm, prevNorm);
  const lenDelta = Math.abs(String(nextRaw || '').length - String(prevRaw || '').length);
  return overlap < 0.985 || lenDelta >= 120;
}

class BrowserAiInterface {
  log(message) {
    if (!BROWSER_AI_DEBUG) return;
    console.log(`[browser-ai-interface] ${message}`);
  }

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

  async getChatSnapshot(page, model) {
    const config = this.getModelConfig(model);
    return page.evaluate((containerSel, textSel) => {
      const isVisible = (el) => el.offsetWidth > 0 && el.offsetHeight > 0;
      const turns = Array.from(document.querySelectorAll(containerSel)).filter(isVisible);
      if (!turns.length) return { turnCount: 0, lastText: '' };

      const messageBlocks = Array.from(document.querySelectorAll('[data-xid="VpUvz"]'))
        .filter(isVisible)
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
      let text = '';
      if (messageBlocks.length > 0) {
        const latestLeaf = messageBlocks[messageBlocks.length - 1];
        text = latestLeaf.innerText || latestLeaf.textContent || '';
      } else {
        turns.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
        const latestTurn = turns[turns.length - 1];
        const scopedBlocks = Array.from(latestTurn.querySelectorAll(textSel))
          .filter(isVisible)
          .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
        if (scopedBlocks.length) {
          const latestScoped = scopedBlocks[scopedBlocks.length - 1];
          text = latestScoped.innerText || latestScoped.textContent || '';
        } else {
          text = latestTurn.innerText || latestTurn.textContent || '';
        }
      }

      // FIX 2: Strip out loading text and timers so the text can stabilize
      text = text.replace(/(Generating\.\.\.|\d{1,2}:\d{2})\s*$/ig, '').trim();

      const turnCount = messageBlocks.length > 0 ? messageBlocks.length : turns.length;
      return { turnCount, lastText: text };
    }, config.responseContainerSelector, config.responseSelector);
  }

  async countResponses(page, model) {
    const snap = await this.getChatSnapshot(page, model);
    return snap.turnCount;
  }

  async getVisibleAiModeCopyButtonCount(page) {
    return page.evaluate((selector) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      return Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
    }, AI_COPY_BUTTON_SELECTOR).catch(() => 0);
  }

  async getVisibleAiModeTurnCount(page) {
    return page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      return Array.from(document.querySelectorAll('[data-xid="aim-mars-turn-root"]')).filter(isVisible).length;
    }).catch(() => 0);
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

    const snapshot = await this.getChatSnapshot(page, model);
    const initialCount = Number.isFinite(options && options.initialCount) ? options.initialCount : snapshot.turnCount;
    const initialCopyButtonCount = model === 'aimode'
      ? await this.getVisibleAiModeCopyButtonCount(page)
      : 0;
    const initialTurnRootCount = model === 'aimode'
      ? await this.getVisibleAiModeTurnCount(page)
      : 0;
    const initialCopiedText = model === 'aimode' && AIMODE_PRE_SEND_BASELINE_COPY
      ? await this.copyLatestAiModeResponse(page, '', 0)
      : '';
    if (model === 'aimode') {
      this.log(
        `sendPrompt baseline: copyCount=${initialCopyButtonCount} turnRootCount=${initialTurnRootCount} baselineCopyEnabled=${AIMODE_PRE_SEND_BASELINE_COPY} baselineCopiedLen=${initialCopiedText.length} baselineTurnCount=${initialCount} baselineTextLen=${snapshot.lastText.length}`
      );
    }

    await page.evaluate((el, text) => {
      el.focus();
      const next = String(text || '');
      if ('value' in el) {
        el.value = next;
      } else if (el.isContentEditable) {
        el.textContent = next;
      } else {
        el.textContent = next;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input, prompt);

    if (model === 'aimode') {
      const clicked = await page.evaluate((sendSelectors) => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetWidth > 0 && el.offsetHeight > 0;
        };
        const isClickable = (btn) => {
          if (!btn) return false;
          if (!isVisible(btn)) return false;
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
          return true;
        };
        const candidates = [];
        for (const selector of sendSelectors) {
          document.querySelectorAll(selector).forEach((btn) => {
            if (!isClickable(btn)) return;
            const rect = btn.getBoundingClientRect();
            candidates.push({ btn, bottom: rect.bottom });
          });
        }
        if (!candidates.length) return false;
        candidates.sort((a, b) => b.bottom - a.bottom);
        const target = candidates[0].btn;
        target.click();
        return true;
      }, AI_SEND_SELECTORS).catch(() => false);
      this.log(`sendPrompt aimode: sendButtonClicked=${clicked}`);
      if (!clicked) {
        await page.keyboard.press('Enter');
        this.log('sendPrompt aimode: fallback Enter keypress sent');
      } else {
        const remainingLen = await page.evaluate((el) => {
          const v = 'value' in el ? String(el.value || '') : String(el.textContent || '');
          return v.trim().length;
        }, input).catch(() => 0);
        this.log(`sendPrompt aimode: inputRemainingLenAfterClick=${remainingLen}`);
      }
    } else {
      await page.keyboard.press('Enter');
    }

    await input.dispose().catch(() => {});

    return {
      initialCount,
      initialText: snapshot.lastText,
      initialCopyButtonCount,
      initialTurnRootCount,
      initialCopiedText,
      responseSelector: config.responseSelector,
      responseContainerSelector: config.responseContainerSelector,
    };
  }

  async waitForStableResponse(page, options) {
    const initialCount = Number(options && options.initialCount ? options.initialCount : 0);
    const initialTextNorm = normalizeText(options && options.initialText ? options.initialText : '');
    const prompt = options && options.prompt ? String(options.prompt) : '';
    const model = options && options.model ? options.model : 'geminifast';
    const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 180000;
    const pollMs = Number.isFinite(options && options.pollMs) ? options.pollMs : 900;

    const timeoutAt = Date.now() + timeoutMs;
    const promptNorm = normalizeText(prompt);
    let previous = '';
    let stableTicks = 0;

    if (model === 'aimode') {
      const initialCopyCount = Number(options && options.initialCopyButtonCount ? options.initialCopyButtonCount : 0);
      const initialTurnRootCount = Number(options && options.initialTurnRootCount ? options.initialTurnRootCount : 0);
      const initialTextRaw = options && options.initialText ? String(options.initialText) : '';
      const initialCopiedNorm = normalizeText(options && options.initialCopiedText ? options.initialCopiedText : '');
      const waitStartedAt = Date.now();
      this.log(
        `aimode wait start: initialCopyCount=${initialCopyCount} initialTurnCount=${initialCount} initialTurnRootCount=${initialTurnRootCount} initialTextLen=${(options && options.initialText ? String(options.initialText).length : 0)} initialCopiedNormLen=${initialCopiedNorm.length} timeoutMs=${timeoutMs} pollMs=${pollMs}`
      );
      let pollIndex = 0;
      let noResponsePolls = 0;
      let sawNewCopyButton = false;
      let targetedTurnCopyAttempted = false;
      let lastCandidateLen = initialTextRaw.length;
      let lastVisibleCopyCount = initialCopyCount;
      let lastTurnCount = initialCount;

      while (Date.now() < timeoutAt) {
        pollIndex += 1;
        const snapshot = await this.getChatSnapshot(page, model);
        const candidate = normalizeResponseTextPreservingBreaks(snapshot.lastText);
        const candidateNorm = normalizeText(candidate);
        const candidateLooksLikePrompt = candidateNorm === promptNorm;

        const visibleCopyCount = await this.getVisibleAiModeCopyButtonCount(page);
        const hasNewCopyButton = visibleCopyCount > initialCopyCount;
        const materiallyChangedFromInitial = isMateriallyDifferent(candidateNorm, initialTextNorm, candidate, initialTextRaw);
        const elapsedMs = Date.now() - waitStartedAt;
        const candidateLenDelta = candidate.length - lastCandidateLen;
        this.log(
          `aimode poll #${pollIndex} t+${elapsedMs}ms: copyCount=${visibleCopyCount} hasNewCopy=${hasNewCopyButton} turnCount=${snapshot.turnCount} candidateLen=${candidate.length} candidateLenDelta=${candidateLenDelta} looksLikePrompt=${candidateLooksLikePrompt} materiallyChanged=${materiallyChangedFromInitial}`
        );
        if (visibleCopyCount !== lastVisibleCopyCount) {
          this.log(`aimode copyCount change at poll #${pollIndex}: ${lastVisibleCopyCount} -> ${visibleCopyCount}`);
          lastVisibleCopyCount = visibleCopyCount;
        }
        if (snapshot.turnCount !== lastTurnCount) {
          this.log(`aimode turnCount change at poll #${pollIndex}: ${lastTurnCount} -> ${snapshot.turnCount}`);
          lastTurnCount = snapshot.turnCount;
        }
        lastCandidateLen = candidate.length;

        const isNewResponse =
          hasNewCopyButton ||
          (snapshot.turnCount > initialCount) ||
          materiallyChangedFromInitial;

        const responseStarted = Boolean(candidate) && !candidateLooksLikePrompt && isNewResponse;
        this.log(
          `aimode response state #${pollIndex}: isNewResponse=${isNewResponse} responseStarted=${responseStarted} stableTicks=${stableTicks}`
        );

        if (!responseStarted) {
          noResponsePolls += 1;
          if (noResponsePolls >= 75) {
            this.log('aimode abort: no response start detected after ~30s');
            throw new Error('AI Mode did not start a new response after sending the prompt.');
          }
        } else {
          noResponsePolls = 0;
        }

        if (responseStarted) {
          const likelyNewTurnContext = snapshot.turnCount > initialCount || hasNewCopyButton;
          if (!targetedTurnCopyAttempted && likelyNewTurnContext) {
            targetedTurnCopyAttempted = true;
            const targetedStartedAt = Date.now();
            const targeted = await this.copyFromNewAiModeTurn(page, {
              baselineTurnCount: initialTurnRootCount,
              promptNorm,
              baselineNorm: initialCopiedNorm,
              expectedNorm: candidateNorm,
              timeoutMs: Math.min(900, Math.max(500, timeoutAt - Date.now() - 500)),
              settleMs: 300,
            });
            this.log(
              `aimode targeted new-turn copy returned len=${targeted.length} afterMs=${Date.now() - targetedStartedAt}`
            );
            if (targeted) return targeted;
          }

          if (candidate === previous) {
            stableTicks += 1;
          } else {
            previous = candidate;
            stableTicks = 0;
          }

          // Primary trigger: a newly appeared copy button.
          if (hasNewCopyButton) {
            sawNewCopyButton = true;
            await sleep(250);
            const preferredMin = hasNewCopyButton ? initialCopyCount + 1 : 0;
            const copyAttemptStartedAt = Date.now();
            const copied = await this.copyLatestAiModeResponse(page, promptNorm, preferredMin, {
              baselineNorm: initialCopiedNorm,
              expectedNorm: candidateNorm,
            });
            const copiedNorm = normalizeText(copied);
            this.log(
              `aimode copy attempt (required min=${preferredMin}) returned len=${copied.length} normChangedFromBaseline=${copiedNorm !== initialCopiedNorm} afterMs=${Date.now() - copyAttemptStartedAt}`
            );
            if (copied && copiedNorm !== initialCopiedNorm) return copied;

            const copyRetryStartedAt = Date.now();
            const copiedAny = await this.copyLatestAiModeResponse(page, promptNorm, 0, {
              baselineNorm: initialCopiedNorm,
              expectedNorm: candidateNorm,
            });
            const copiedAnyNorm = normalizeText(copiedAny);
            this.log(
              `aimode copy retry (required min=0) returned len=${copiedAny.length} normChangedFromBaseline=${copiedAnyNorm !== initialCopiedNorm} afterMs=${Date.now() - copyRetryStartedAt}`
            );
            if (copiedAny && copiedAnyNorm !== initialCopiedNorm) return copiedAny;
            await sleep(Math.min(400, pollMs));
            continue;
          }

          // Secondary fallback: only after waiting a while with no new copy button signal.
          const allowPreCopyFallback = !sawNewCopyButton && snapshot.turnCount > initialCount && pollIndex >= 40;
          if (stableTicks >= 2 && (sawNewCopyButton || allowPreCopyFallback)) {
            const scopedFallback = await this.extractLatestAiModeTurnText(page, promptNorm);
            this.log(`aimode fallback extract returned len=${scopedFallback.length}`);
            const scopedFallbackNorm = normalizeText(scopedFallback);
            if (
              scopedFallback &&
              isMateriallyDifferent(scopedFallbackNorm, initialTextNorm, scopedFallback, initialTextRaw)
            ) return scopedFallback;

            if (stableTicks >= 5 && candidate && materiallyChangedFromInitial) {
              this.log(`aimode returning stabilized candidate text len=${candidate.length}`);
              return candidate;
            }
          }
        }

        await sleep(Math.min(400, pollMs));
      }
      this.log('aimode timeout reached, running final forced copy/fallback attempts');
      const timeoutSnapshot = await this.getChatSnapshot(page, model);
      const forcedCopy = await this.copyLatestAiModeResponse(page, promptNorm, 0, {
        baselineNorm: initialCopiedNorm,
        expectedNorm: normalizeText(normalizeResponseTextPreservingBreaks(timeoutSnapshot.lastText || '')),
      });
      const forcedCopyNorm = normalizeText(forcedCopy);
      this.log(`aimode forced copy returned len=${forcedCopy.length} normChangedFromBaseline=${forcedCopyNorm !== initialCopiedNorm}`);
      if (forcedCopy && forcedCopyNorm !== initialCopiedNorm) return forcedCopy;
      const forcedFallback = await this.extractLatestAiModeTurnText(page, promptNorm);
      this.log(`aimode forced fallback returned len=${forcedFallback.length}`);
      const forcedFallbackNorm = normalizeText(forcedFallback);
      if (
        forcedFallback &&
        isMateriallyDifferent(forcedFallbackNorm, initialTextNorm, forcedFallback, initialTextRaw)
      ) return forcedFallback;
      throw new Error('Timed out waiting for response.');
    }

    while (Date.now() < timeoutAt) {
      const snapshot = await this.getChatSnapshot(page, model);
      const candidate = normalizeResponseTextPreservingBreaks(snapshot.lastText);
      const candidateNorm = normalizeText(candidate);
      const candidateLooksLikePrompt = candidateNorm === promptNorm;

      const isNewResponse = (snapshot.turnCount > initialCount) || (candidateNorm !== initialTextNorm && candidateNorm !== '');
      const responseStarted = Boolean(candidate) && !candidateLooksLikePrompt && isNewResponse;

      if (responseStarted) {
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

  async copyFromNewAiModeTurn(page, options = {}) {
    const baselineTurnCount = Number(options && options.baselineTurnCount ? options.baselineTurnCount : 0);
    const promptNorm = normalizeText(options && options.promptNorm ? options.promptNorm : '');
    const baselineNorm = normalizeText(options && options.baselineNorm ? options.baselineNorm : '');
    const expectedNorm = normalizeText(options && options.expectedNorm ? options.expectedNorm : '');
    const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 20000;
    const settleMs = Number.isFinite(options && options.settleMs) ? options.settleMs : 300;

    const copied = await page.evaluate(async ({ initialTurnCount, copySelector, maxWaitMs, settleDelayMs }) => {
      const sleepLocal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      const normalizeLocal = (text) => {
        return String(text || '')
          .split('\n')
          .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      const getVisibleTurns = () => Array.from(document.querySelectorAll('[data-xid="aim-mars-turn-root"]'))
        .filter(isVisible)
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);

      const deadline = Date.now() + Math.max(1000, Number(maxWaitMs) || 20000);
      let targetTurn = null;

      while (Date.now() < deadline) {
        const turns = getVisibleTurns();
        if (turns.length > initialTurnCount) {
          targetTurn = turns[turns.length - 1];
          break;
        }
        await sleepLocal(120);
      }
      if (!targetTurn) return '';

      while (Date.now() < deadline) {
        if (!targetTurn.isConnected || !isVisible(targetTurn)) {
          const turns = getVisibleTurns();
          if (turns.length > initialTurnCount) {
            targetTurn = turns[turns.length - 1];
          } else {
            await sleepLocal(120);
            continue;
          }
        }

        const copyBtns = Array.from(targetTurn.querySelectorAll(copySelector))
          .filter(isVisible)
          .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
        if (!copyBtns.length) {
          await sleepLocal(120);
          continue;
        }

        const copyBtn = copyBtns[copyBtns.length - 1];
        await sleepLocal(Math.max(0, Number(settleDelayMs) || 0));

        let captured = '';
        const onCopy = (event) => {
          try {
            const raw = event && event.clipboardData ? event.clipboardData.getData('text/plain') : '';
            const text = normalizeLocal(raw);
            if (text) captured = text;
          } catch {}
        };
        document.addEventListener('copy', onCopy, true);

        let originalWriteText = null;
        let originalWrite = null;
        let hadClipboardWrite = false;
        try {
          if (navigator.clipboard) {
            if (typeof navigator.clipboard.writeText === 'function') {
              originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText = async (text) => {
                const normalized = normalizeLocal(text);
                if (normalized) captured = normalized;
                return Promise.resolve();
              };
              hadClipboardWrite = true;
            }
            if (typeof navigator.clipboard.write === 'function') {
              originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
              navigator.clipboard.write = async (data) => {
                try {
                  for (const item of data || []) {
                    if (!item || !Array.isArray(item.types) || !item.types.includes('text/plain')) continue;
                    const blob = await item.getType('text/plain');
                    const text = await blob.text();
                    const normalized = normalizeLocal(text);
                    if (normalized) captured = normalized;
                  }
                } catch {}
                return Promise.resolve();
              };
              hadClipboardWrite = true;
            }
          }
        } catch {}

        const originalExecCommand = typeof document.execCommand === 'function'
          ? document.execCommand.bind(document)
          : null;
        if (originalExecCommand) {
          try {
            document.execCommand = function () { return true; };
          } catch {}
        }

        try {
          copyBtn.click();
          for (let i = 0; i < 20; i += 1) {
            await sleepLocal(120);
            if (captured) break;
          }
        } finally {
          document.removeEventListener('copy', onCopy, true);
          if (hadClipboardWrite) {
            try {
              if (originalWriteText) navigator.clipboard.writeText = originalWriteText;
              if (originalWrite) navigator.clipboard.write = originalWrite;
            } catch {}
          }
          if (originalExecCommand) {
            try {
              document.execCommand = originalExecCommand;
            } catch {}
          }
        }

        if (captured) return captured;
        await sleepLocal(120);
      }
      return '';
    }, {
      initialTurnCount: baselineTurnCount,
      copySelector: AI_COPY_BUTTON_SELECTOR,
      maxWaitMs: timeoutMs,
      settleDelayMs: settleMs,
    }).catch(() => '');

    const normalized = normalizeResponseTextPreservingBreaks(copied);
    const norm = normalizeText(normalized);
    if (!normalized) return '';
    if (norm === promptNorm) return '';
    if (baselineNorm && norm === baselineNorm) return '';
    if (expectedNorm && tokenOverlapScore(norm, expectedNorm) < 0.2) {
      return '';
    }
    return normalized;
  }

  async copyLatestAiModeResponse(page, promptNorm = '', minVisibleCount = 0, hints = null) {
    const baselineNorm = hints && hints.baselineNorm ? String(hints.baselineNorm) : '';
    const expectedNorm = hints && hints.expectedNorm ? String(hints.expectedNorm) : '';
    const isAcceptable = (normalized) => {
      const norm = normalizeText(normalized);
      if (!normalized) return false;
      if (norm === promptNorm) return false;
      if (baselineNorm && norm === baselineNorm) return false;
      if (expectedNorm && tokenOverlapScore(norm, expectedNorm) < 0.2) return false;
      return true;
    };

    const fast = await page.evaluate(async ({ requiredMinCount, copySelector }) => {
      const sleepLocal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      const normalizeLocal = (text) => {
        return String(text || '')
          .split('\n')
          .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      const copyBtns = Array.from(document.querySelectorAll(copySelector))
        .filter(isVisible)
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);

      const totalButtons = copyBtns.length;
      if (copyBtns.length < Math.max(0, Number(requiredMinCount) || 0)) {
        return { text: '', totalButtons };
      }
      if (!copyBtns.length) return { text: '', totalButtons };

      let captured = '';
      const onCopy = (event) => {
        try {
          const raw = event && event.clipboardData ? event.clipboardData.getData('text/plain') : '';
          const text = normalizeLocal(raw);
          if (text) captured = text;
        } catch {}
      };
      document.addEventListener('copy', onCopy, true);

      let originalWriteText = null;
      let originalWrite = null;
      let hadClipboardWrite = false;
      try {
        if (navigator.clipboard) {
          if (typeof navigator.clipboard.writeText === 'function') {
            originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = async (text) => {
              const normalized = normalizeLocal(text);
              if (normalized) captured = normalized;
              return Promise.resolve();
            };
            hadClipboardWrite = true;
          }
          if (typeof navigator.clipboard.write === 'function') {
            originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async (data) => {
              try {
                for (const item of data || []) {
                  if (!item || !Array.isArray(item.types) || !item.types.includes('text/plain')) continue;
                  const blob = await item.getType('text/plain');
                  const text = await blob.text();
                  const normalized = normalizeLocal(text);
                  if (normalized) captured = normalized;
                }
              } catch {}
              return Promise.resolve();
            };
            hadClipboardWrite = true;
          }
        }
      } catch {}

      const originalExecCommand = typeof document.execCommand === 'function'
        ? document.execCommand.bind(document)
        : null;
      if (originalExecCommand) {
        try {
          document.execCommand = function () { return true; };
        } catch {}
      }

      try {
        const copyBtn = copyBtns[copyBtns.length - 1];
        copyBtn.click();
        for (let j = 0; j < 8; j += 1) {
          await sleepLocal(90);
          if (captured) break;
        }
      } finally {
        document.removeEventListener('copy', onCopy, true);
        if (hadClipboardWrite) {
          try {
            if (originalWriteText) navigator.clipboard.writeText = originalWriteText;
            if (originalWrite) navigator.clipboard.write = originalWrite;
          } catch {}
        }
        if (originalExecCommand) {
          try {
            document.execCommand = originalExecCommand;
          } catch {}
        }
      }

      return { text: captured || '', totalButtons };
    }, { requiredMinCount: minVisibleCount, copySelector: AI_COPY_BUTTON_SELECTOR }).catch(() => ({ text: '', totalButtons: 0 }));

    const fastText = fast && typeof fast.text === 'string' ? fast.text : '';
    const fastTotalButtons = fast && Number.isFinite(Number(fast.totalButtons))
      ? Number(fast.totalButtons)
      : 0;
    const fastNormalized = normalizeResponseTextPreservingBreaks(fastText);
    const fastNorm = normalizeText(fastNormalized);
    this.log(
      `copyLatestAiModeResponse: fast requiredMin=${minVisibleCount} totalButtons=${fastTotalButtons} len=${fastNormalized.length}`
    );
    if (isAcceptable(fastNormalized)) {
      this.log('copyLatestAiModeResponse: fast path accepted');
      return fastNormalized;
    }

    this.log(
      `copyLatestAiModeResponse: fast path rejected promptMatch=${fastNorm === promptNorm} baselineMatch=${Boolean(baselineNorm) && fastNorm === baselineNorm} overlap=${expectedNorm ? tokenOverlapScore(fastNorm, expectedNorm).toFixed(3) : 'n/a'}`
    );
    if (!AIMODE_COPY_ENABLE_FALLBACK) return '';

    const attempts = await page.evaluate(async ({ requiredMinCount, copySelector }) => {
      const sleepLocal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      const normalizeLocal = (text) => {
        return String(text || '')
          .split('\n')
          .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      const copyBtns = Array.from(document.querySelectorAll(copySelector))
        .filter(isVisible)
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);

      if (copyBtns.length < Math.max(0, Number(requiredMinCount) || 0)) return [];

      let captured = '';
      const onCopy = (event) => {
        try {
          const raw = event && event.clipboardData ? event.clipboardData.getData('text/plain') : '';
          const text = normalizeLocal(raw);
          if (text) captured = text;
        } catch {}
      };
      document.addEventListener('copy', onCopy, true);

      let originalWriteText = null;
      let originalWrite = null;
      let hadClipboardWrite = false;
      try {
        if (navigator.clipboard) {
          if (typeof navigator.clipboard.writeText === 'function') {
            originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = async (text) => {
              const normalized = normalizeLocal(text);
              if (normalized) captured = normalized;
              return Promise.resolve();
            };
            hadClipboardWrite = true;
          }
          if (typeof navigator.clipboard.write === 'function') {
            originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async (data) => {
              try {
                for (const item of data || []) {
                  if (!item || !Array.isArray(item.types) || !item.types.includes('text/plain')) continue;
                  const blob = await item.getType('text/plain');
                  const text = await blob.text();
                  const normalized = normalizeLocal(text);
                  if (normalized) captured = normalized;
                }
              } catch {}
              return Promise.resolve();
            };
            hadClipboardWrite = true;
          }
        }
      } catch {}

      const originalExecCommand = typeof document.execCommand === 'function'
        ? document.execCommand.bind(document)
        : null;
      if (originalExecCommand) {
        try {
          document.execCommand = function () { return true; };
        } catch {}
      }

      const results = [];
      const lastIdx = copyBtns.length - 1;
      const candidateIndices = [];
      if (copyBtns.length <= 6) {
        for (let i = lastIdx; i >= 0; i -= 1) candidateIndices.push(i);
      } else {
        candidateIndices.push(lastIdx);
        if (lastIdx - 1 >= 0) candidateIndices.push(lastIdx - 1);
        if (lastIdx - 2 >= 0) candidateIndices.push(lastIdx - 2);
        if (lastIdx - 3 >= 0 && copyBtns.length <= 10) candidateIndices.push(lastIdx - 3);
        candidateIndices.push(0);
      }
      const dedupedIndices = [];
      const seenIndices = new Set();
      for (const idx of candidateIndices) {
        if (idx < 0 || idx > lastIdx) continue;
        if (seenIndices.has(idx)) continue;
        seenIndices.add(idx);
        dedupedIndices.push(idx);
      }
      try {
        for (const i of dedupedIndices) {
          const copyBtn = copyBtns[i];
          captured = '';
          copyBtn.click();
          const waitTicks = i === lastIdx ? 8 : 5;
          for (let j = 0; j < waitTicks; j += 1) {
            await sleepLocal(90);
            if (captured) break;
          }
          results.push({
            order: i,
            bottom: copyBtn.getBoundingClientRect().bottom,
            text: captured || '',
            totalButtons: copyBtns.length,
          });
        }
      } finally {
        document.removeEventListener('copy', onCopy, true);
        if (hadClipboardWrite) {
          try {
            if (originalWriteText) navigator.clipboard.writeText = originalWriteText;
            if (originalWrite) navigator.clipboard.write = originalWrite;
          } catch {}
        }
        if (originalExecCommand) {
          try {
            document.execCommand = originalExecCommand;
          } catch {}
        }
      }

      return results;
    }, { requiredMinCount: minVisibleCount, copySelector: AI_COPY_BUTTON_SELECTOR }).catch(() => []);

    const attemptList = Array.isArray(attempts) ? attempts : [];
    const totalButtons = attemptList.length ? Math.max(...attemptList.map((a) => Number(a.totalButtons || 0))) : 0;
    this.log(`copyLatestAiModeResponse: fallback requiredMin=${minVisibleCount} attempts=${attemptList.length} totalButtons=${totalButtons}`);

    const candidates = attemptList.map((item, idx) => {
      const normalized = normalizeResponseTextPreservingBreaks(item && item.text ? item.text : '');
      const norm = normalizeText(normalized);
      let score = 0;
      if (!normalized) score -= 1000;
      if (norm === promptNorm) score -= 1000;
      if (baselineNorm) {
        if (norm === baselineNorm) score -= 500;
        else score += 150;
      }
      if (expectedNorm) {
        if (norm === expectedNorm) score += 600;
        else if (expectedNorm.includes(norm) || norm.includes(expectedNorm)) score += 300;
        score += Math.floor(tokenOverlapScore(norm, expectedNorm) * 200);
      }
      score += Math.min(normalized.length, 12000) / 200;
      return { idx, score, normalized, norm };
    });

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return '';
    this.log(`copyLatestAiModeResponse: fallback bestScore=${best.score} bestLen=${best.normalized.length}`);
    if (!isAcceptable(best.normalized)) return '';
    return best.normalized;
  }

  async extractLatestAiModeTurnText(page, promptNorm = '') {
    const text = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };

      const leafBlocks = Array.from(document.querySelectorAll('[data-xid="VpUvz"]'))
        .filter(isVisible)
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);

      let text = '';
      if (leafBlocks.length) {
        const latestLeaf = leafBlocks[leafBlocks.length - 1];
        text = latestLeaf.innerText || latestLeaf.textContent || '';
      } else {
        const turns = Array.from(document.querySelectorAll('[data-xid="aim-mars-turn-root"]')).filter(isVisible);
        if (!turns.length) return '';
        turns.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
        const latestTurn = turns[turns.length - 1];
        text = latestTurn.innerText || latestTurn.textContent || '';
      }

      // Strip leftover timers from fallback text
      return text.replace(/(Generating\.\.\.|\d{1,2}:\d{2})\s*$/ig, '').trim();
    }).catch(() => '');

    const normalized = normalizeResponseTextPreservingBreaks(text);
    if (!normalized) return '';
    if (normalizeText(normalized) === promptNorm) return '';
    return normalized;
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
      initialText: sent.initialText,
      initialCopyButtonCount: sent.initialCopyButtonCount,
      initialTurnRootCount: sent.initialTurnRootCount,
      initialCopiedText: sent.initialCopiedText,
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
