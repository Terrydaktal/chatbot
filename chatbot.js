#!/usr/bin/env node

const puppeteerCore = require('puppeteer-core');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const chalk = require('chalk');
const readline = require('readline');
const { marked } = require('marked');
const TerminalRenderer = require('marked-terminal').default || require('marked-terminal'); // Fallback just in case
const highlight = require('highlight.js');
const { execSync } = require('child_process');

// Configure Markdown Renderer with Highlighting
const OUTPUT_WIDTH = 88;
const TABLE_COL_WIDTH = Math.max(12, Math.floor((OUTPUT_WIDTH - 10) / 3));
const TYPING_FRAMES = ['●○○○', '○●○○', '○○●○', '○○○●'];
const TYPING_INTERVAL_MS = 120;
const LINE_STREAM_DELAY_MS = 20;
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const renderer = new TerminalRenderer({
  width: OUTPUT_WIDTH,
  reflowText: false,
  showSectionPrefix: false,
  tab: 4, // More indentation
  heading: chalk.bold.blue, // Blue bold headers
  firstHeading: chalk.bold.blue.underline,
  strong: chalk.hex('#C8A2C8').bold,
  em: chalk.italic,
  blockquote: chalk.gray.italic,
  code: chalk.yellow, // Inline code color
  listitem: (text) => '  • ' + text, // Better bullet points
  tableOptions: {
    wordWrap: true,
    colWidths: [TABLE_COL_WIDTH, TABLE_COL_WIDTH, TABLE_COL_WIDTH, TABLE_COL_WIDTH]
  }
});

renderer.hr = function () {
  return '\n\n';
};

let globalBrowser = null;
let activeStopTyping = null;
let abortRequested = false;
process.on('SIGINT', () => {
  if (abortRequested) process.exit(130);
  abortRequested = true;
  if (activeStopTyping) {
    activeStopTyping();
    activeStopTyping = null;
  }
  console.log(chalk.yellow('\nInterrupted. Exiting.'));
  if (globalBrowser) {
      try {
          globalBrowser.disconnect();
      } catch (e) {}
  }
  process.exit(130);
});

// Ensure inline tokens (like **bold**) are parsed inside text nodes
renderer.text = function (text) {
  if (typeof text === 'object') {
    if (text.tokens) {
      return this.parser.parseInline(text.tokens);
    }
    text = text.text;
  }
  return this.o.text(text);
};

marked.setOptions({
  renderer,
  highlight: (code, lang) => {
    const rawLang = (lang || '').toString().trim().toLowerCase();
    const aliasMap = {
      'bash': 'bash',
      'sh': 'bash',
      'shell': 'bash',
      'zsh': 'bash',
      'ksh': 'bash',
      'fish': 'bash',
      'console': 'bash',
      'terminal': 'bash',
      'cmd': 'dos',
      'bat': 'dos',
      'batch': 'dos',
      'powershell': 'powershell',
      'ps': 'powershell',
      'ps1': 'powershell',
      'javascript': 'javascript',
      'js': 'javascript',
      'node': 'javascript',
      'typescript': 'typescript',
      'ts': 'typescript',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'html': 'xml',
      'xml': 'xml',
      'svg': 'xml',
      'css': 'css',
      'scss': 'scss',
      'less': 'less',
      'python': 'python',
      'py': 'python',
      'ruby': 'ruby',
      'rb': 'ruby',
      'go': 'go',
      'golang': 'go',
      'rust': 'rust',
      'rs': 'rust',
      'java': 'java',
      'kotlin': 'kotlin',
      'kt': 'kotlin',
      'c': 'c',
      'h': 'c',
      'cpp': 'cpp',
      'c++': 'cpp',
      'hpp': 'cpp',
      'cc': 'cpp',
      'csharp': 'csharp',
      'cs': 'csharp',
      'fsharp': 'fsharp',
      'fs': 'fsharp',
      'php': 'php',
      'sql': 'sql',
      'sqlite': 'sql',
      'postgres': 'pgsql',
      'postgresql': 'pgsql',
      'mysql': 'sql',
      'md': 'markdown',
      'markdown': 'markdown',
      'dockerfile': 'dockerfile',
      'makefile': 'makefile',
      'ini': 'ini',
      'toml': 'toml',
      'diff': 'diff',
      'git': 'diff'
    };
    const normalized = aliasMap[rawLang] || rawLang;
    if (normalized && highlight.getLanguage(normalized)) {
      return highlight.highlight(code, { language: normalized }).value;
    }
    const commonLanguages = [
      'bash', 'dos', 'powershell',
      'javascript', 'typescript', 'json',
      'python', 'go', 'rust', 'java', 'kotlin',
      'cpp', 'c', 'csharp',
      'html', 'xml', 'css', 'scss',
      'sql', 'yaml', 'markdown'
    ].filter((name) => highlight.getLanguage(name));
    return highlight.highlightAuto(code, commonLanguages.length ? commonLanguages : undefined).value;
  }
});

function stripAnsi(value) {
  return value.replace(ANSI_REGEX, '');
}

function startStatusAnimation(initialText = 'Gemini is typing') {
  let frameIndex = 0;
  let currentText = initialText;
  const cols = process.stdout.columns || OUTPUT_WIDTH;
  process.stdout.write('\n');

  const render = () => {
    const frame = TYPING_FRAMES[frameIndex % TYPING_FRAMES.length];
    const text = chalk.yellow(`${currentText} ${frame}`);
    const pad = Math.max(0, cols - stripAnsi(text).length);
    process.stdout.write(`\r${text}${' '.repeat(pad)}`);
    frameIndex += 1;
  };

  render();
  const interval = setInterval(render, TYPING_INTERVAL_MS);

  return {
      update: (newText) => { currentText = newText; },
      stop: () => {
        clearInterval(interval);
        process.stdout.write(`\r${' '.repeat(cols)}\r`);
      }
  };
}

function normalizeMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inFence = false;
  let inTable = false;
  let tablePipeCount = 0;

  function isTableSepLine(value) {
    return /^\s*\|?[-:\s]+\|[-:\s|]*$/.test(value);
  }
  function countPipes(value) {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '|' && value[i - 1] !== '\\') count++;
    }
    return count;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1] || '';
    const pipeCount = countPipes(line);

    if (!inTable && pipeCount >= 2 && isTableSepLine(next)) {
      inTable = true;
      tablePipeCount = pipeCount;
      out.push(line);
      continue;
    }

    if (inTable) {
      if (trimmed === '') {
        out.push('');
        inTable = false;
        tablePipeCount = 0;
        continue;
      }
      if (isTableSepLine(line) || pipeCount >= tablePipeCount) {
        out.push(line);
        continue;
      }
      if (out.length) {
        out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`;
      } else {
        out.push(trimmed);
      }
      continue;
    }

    if (trimmed === '') {
      out.push('');
      continue;
    }

    const isBlockStart = /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|---$|___$|\*\*\*$|\s*•\s)/.test(line);
    if (isBlockStart) {
      out.push(line);
      continue;
    }

    const prev = out[out.length - 1] || '';
    const prevBlock = /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|---$|___$|\*\*\*$|\s*•\s)/.test(prev);
    if (out.length && prev !== '' && !prevBlock && !prev.trim().endsWith('  ')) {
      out[out.length - 1] = `${prev} ${trimmed}`;
    } else {
      out.push(trimmed);
    }
  }
  return out.join('\n');
}

function looksLikeMarkdown(text) {
  if (!text) return false;
  return /```|^\s{0,3}#{1,6}\s|\n\s*[-*+]\s|\n\s*\d+\.\s|\|\s*---|\[[^\]]+\]\([^)]+\)|`[^`]+`/m.test(text);
}

async function fetchDomMarkdown(page) {
  try {
    return await page.evaluate((responseSelector, responseContainerSelector) => {
      function domToMarkdown(node) {
        if (!node) return '';
        let md = '';
        const listStack = [];

        function append(text) { if (text) md += text; }
        function trailingNewlines() {
          const match = md.match(/\n*$/);
          return match ? match[0].length : 0;
        }
        function ensureNewlines(count) {
          const current = trailingNewlines();
          if (current < count) md += '\n'.repeat(count - current);
        }
        function fenceFor(text) {
          const matches = text.match(/`+/g) || [];
          let max = 0;
          for (const m of matches) max = Math.max(max, m.length);
          return '`'.repeat(Math.max(3, max + 1));
        }
        function inlineFence(text) {
          const matches = text.match(/`+/g) || [];
          let max = 0;
          for (const m of matches) max = Math.max(max, m.length);
          return '`'.repeat(Math.max(1, max + 1));
        }
        function escapeTableCell(text) {
          return (text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
        }
        function extractTable(table) {
          const rows = [];
          let headerCells = [];
          const thead = table.querySelector('thead');
          if (thead) {
            const headerRow = thead.querySelector('tr');
            if (headerRow) {
              headerCells = Array.from(headerRow.children)
                .filter(el => el.tagName && el.tagName.toLowerCase() === 'th')
                .map(el => escapeTableCell(el.textContent));
            }
          }
          const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr'));
          for (const row of bodyRows) {
            const cells = Array.from(row.children)
              .filter(el => el.tagName && (el.tagName.toLowerCase() === 'td' || el.tagName.toLowerCase() === 'th'))
              .map(el => escapeTableCell(el.textContent));
            if (cells.length) rows.push(cells);
          }
          if (!headerCells.length && rows.length) {
            headerCells = rows.shift();
          }
          if (!headerCells.length) return;
          const colCount = Math.max(headerCells.length, ...rows.map(r => r.length));
          const pad = (arr) => {
            while (arr.length < colCount) arr.push('');
            return arr;
          };
          const header = pad([...headerCells]);
          const sep = header.map(() => '---');
          let out = `\n\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
          for (const row of rows) {
            const cells = pad([...row]);
            out += `| ${cells.join(' | ')} |\n`;
          }
          out += '\n';
          append(out);
        }
        function extractCodeBlock(block) {
          let lang = '';
          const langEl = block.querySelector('.code-block-decoration span, .header-formatted span, .code-block-decoration');
          if (langEl) lang = langEl.textContent.trim().toLowerCase();
          const codeEl = block.querySelector('code[data-test-id=\"code-content\"], pre code, code, pre');
          let codeText = codeEl ? codeEl.textContent : '';
          codeText = codeText.replace(/\n$/, '');
          const fence = fenceFor(codeText);
          append(`\n\n${fence}${lang ? ' ' + lang : ''}\n${codeText}\n${fence}\n\n`);
        }
        function renderChildren(el, inListItem) {
          el.childNodes.forEach(child => render(child, inListItem));
        }
        function render(child, inListItem) {
          if (child.nodeType === 3) {
            append(child.textContent);
            return;
          }
          if (child.nodeType !== 1) return;
          const tag = child.tagName.toLowerCase();
          const isCodeBlock = tag === 'code-block' || child.classList.contains('code-block');
          if (isCodeBlock) {
            extractCodeBlock(child);
            return;
          }
          if (tag === 'pre') {
            extractCodeBlock(child);
            return;
          }
          if (tag === 'table') {
            extractTable(child);
            return;
          }
          if (tag === 'br') { append('\n'); return; }
          if (tag === 'hr') { ensureNewlines(2); append('---'); ensureNewlines(2); return; }
          if (tag === 'p') {
            if (inListItem) {
              renderChildren(child, true);
            } else {
              ensureNewlines(2);
              renderChildren(child, false);
              ensureNewlines(2);
            }
            return;
          }
          if (tag === 'h1') { ensureNewlines(2); append('# '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h2') { ensureNewlines(2); append('## '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h3') { ensureNewlines(2); append('### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h4') { ensureNewlines(2); append('#### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h5') { ensureNewlines(2); append('##### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h6') { ensureNewlines(2); append('###### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'ul') {
            listStack.push({ type: 'ul', index: 0 });
            ensureNewlines(2);
            renderChildren(child, false);
            listStack.pop();
            ensureNewlines(2);
            return;
          }
          if (tag === 'ol') {
            listStack.push({ type: 'ol', index: 0 });
            ensureNewlines(2);
            renderChildren(child, false);
            listStack.pop();
            ensureNewlines(2);
            return;
          }
          if (tag === 'li') {
            ensureNewlines(1);
            const depth = Math.max(0, listStack.length - 1);
            const indent = '  '.repeat(depth);
            const top = listStack[listStack.length - 1];
            let marker = '-';
            if (top && top.type === 'ol') marker = `${++top.index}.`;
            append(`${indent}${marker} `);
            renderChildren(child, true);
            return;
          }
          if (tag === 'blockquote') {
            ensureNewlines(2);
            const original = md;
            md = '';
            renderChildren(child, false);
            const content = md.trim().split('\n');
            md = original;
            for (const line of content) append(`> ${line}\n`);
            ensureNewlines(2);
            return;
          }
          if (tag === 'strong' || tag === 'b') { append('**'); renderChildren(child, inListItem); append('**'); return; }
          if (tag === 'em' || tag === 'i') { append('_'); renderChildren(child, inListItem); append('_'); return; }
          if (tag === 'code') {
            const text = child.textContent || '';
            const fence = inlineFence(text);
            append(`${fence}${text}${fence}`);
            return;
          }
          if (tag === 'a') {
            const href = child.getAttribute('href') || '';
            append('[');
            renderChildren(child, inListItem);
            append(`](${href})`);
            return;
          }
          renderChildren(child, inListItem);
        }
        renderChildren(node, false);
        return md.trim();
      }

      const allCandidates = Array.from(document.querySelectorAll(responseSelector));
      const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
      const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
      const candidate = candidates[candidates.length - 1];
      if (!candidate) return '';
      let finalMarkdown = domToMarkdown(candidate);
      if (!finalMarkdown || finalMarkdown.trim().length === 0) {
        finalMarkdown = candidate.innerText || '';
      }
      return finalMarkdown;
    }, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
  } catch (err) {
    return '';
  }
}

async function fetchCopyMarkdown(page) {
  try {
    return await page.evaluate((responseSelector, responseContainerSelector) => {
      const allCandidates = Array.from(document.querySelectorAll(responseSelector));
      const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
      const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
      const latest = candidates[candidates.length - 1];
      const container = latest ? latest.closest(responseContainerSelector) : null;
      const copyBtn = container ? container.querySelector('button[data-test-id="copy-button"]') : null;
      if (!copyBtn) return null;

      let captured = null;
      const onCopy = (e) => {
        try {
          captured = e.clipboardData.getData('text/plain');
        } catch (err) {}
        e.preventDefault();
      };
      document.addEventListener('copy', onCopy);

      let originalWriteText = null;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          captured = text;
          return Promise.resolve();
        };
      }

      const originalExecCommand = document.execCommand;
      document.execCommand = function () { return true; };

      copyBtn.click();

      return new Promise((resolve) => {
        setTimeout(() => {
          document.removeEventListener('copy', onCopy);
          if (originalWriteText) {
            navigator.clipboard.writeText = originalWriteText;
          }
          document.execCommand = originalExecCommand;
          resolve(captured);
        }, 50);
      });
    }, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
  } catch (err) {
    return null;
  }
}

async function applyVisibilityOverride(page) {
  const overrideScript = () => {
    const define = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, {
          get: () => value,
          configurable: true,
        });
      } catch (e) {}
    };
    define(document, 'hidden', false);
    define(document, 'visibilityState', 'visible');
    define(document, 'webkitHidden', false);
    define(document, 'webkitVisibilityState', 'visible');
    define(document, 'mozHidden', false);
    define(document, 'mozVisibilityState', 'visible');
    define(document, 'msHidden', false);
    define(document, 'msVisibilityState', 'visible');
    try {
      document.hasFocus = () => true;
    } catch (e) {}
    try {
      Object.defineProperty(Document.prototype, 'hasFocus', {
        value: () => true,
        configurable: true,
      });
    } catch (e) {}
    
    // Override requestAnimationFrame to keep running even when backgrounded/minimized
    try {
        const target = window;
        const raf = (callback) => setTimeout(() => callback(Date.now()), 1000 / 60);
        const caf = (id) => clearTimeout(id);
        
        Object.defineProperty(target, 'requestAnimationFrame', { value: raf, configurable: true });
        Object.defineProperty(target, 'webkitRequestAnimationFrame', { value: raf, configurable: true });
        Object.defineProperty(target, 'cancelAnimationFrame', { value: caf, configurable: true });
        Object.defineProperty(target, 'webkitCancelAnimationFrame', { value: caf, configurable: true });
    } catch (e) {}
  };

  try {
    await page.evaluateOnNewDocument(overrideScript);
  } catch (e) {}

  try {
    await page.evaluate(overrideScript);
  } catch (e) {}
}

async function applyLifecycleOverrides(page) {
  try {
    const client = await page.target().createCDPSession();
    // Keep the page marked as active/visible to reduce background throttling.
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await client.send('Emulation.setIdleOverride', {
      isUserActive: true,
      isScreenUnlocked: true,
    });
    try {
      await client.send('Page.setWebLifecycleState', { state: 'active' });
    } catch (e) {}
    try {
      // Disable CPU throttling (set rate to 1 = no throttling)
      await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    } catch (e) {}
  } catch (e) {}
  
  // Also force visibility via JS (redundant but safe)
  try {
      await page.evaluate(() => {
          if (document.hidden) {
              Object.defineProperty(document, 'hidden', { value: false, writable: true });
              Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
              document.dispatchEvent(new Event('visibilitychange'));
          }
      });
  } catch(e) {}
}

async function waitForResponseAndRender(page, initialCount) {
  const status = startStatusAnimation('Gemini is thinking');
  activeStopTyping = status.stop;
  
  const keepAlive = setInterval(() => {
    void applyLifecycleOverrides(page);
    void page.evaluate(() => {
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
      } catch (e) {}
    });
  }, 1000);

  try {
    const start = Date.now();
    let lastLength = 0;
    let stableCount = 0;
    let hasStartedTyping = false;

    while (true) {
      if (abortRequested) break;
      const state = await page.evaluate((initialCount, responseSelector, responseContainerSelector) => {
        const allCandidates = Array.from(document.querySelectorAll(responseSelector));
        const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
        const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
        if (candidates.length <= initialCount) {
          return { hasCopy: false, textLength: 0 };
        }
        const latest = candidates[candidates.length - 1];
        const container = latest ? latest.closest(responseContainerSelector) : null;
        const copyBtn = container ? container.querySelector('button[data-test-id="copy-button"]') : null;
        const text = latest ? (latest.innerText || '') : '';
        return { hasCopy: !!copyBtn, textLength: text.length };
      }, initialCount, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);

      if (state.textLength > 0 && !hasStartedTyping) {
          hasStartedTyping = true;
          status.update('Gemini is typing');
      }

      if (state.hasCopy) break;
      if (state.textLength > 0) {
        if (state.textLength === lastLength) {
          stableCount += 1;
        } else {
          stableCount = 0;
          lastLength = state.textLength;
        }
        if (stableCount >= 6) break;
      }

      if (Date.now() - start > 300000) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    clearInterval(keepAlive);
  }

  status.stop();
  activeStopTyping = null;

  let finalText = await fetchCopyMarkdown(page);
  if (!finalText || !finalText.trim()) {
    finalText = await fetchDomMarkdown(page);
  } else if (!looksLikeMarkdown(finalText)) {
    const domMarkdown = await fetchDomMarkdown(page);
    if (domMarkdown && domMarkdown.trim()) {
      finalText = domMarkdown;
    }
  }

  finalText = normalizeMarkdown(finalText || '');
  const rendered = marked(finalText);
  const lines = rendered.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const suffix = i < lines.length - 1 ? '\n' : '';
    process.stdout.write(`${line}${suffix}`);
    if (LINE_STREAM_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, LINE_STREAM_DELAY_MS));
    }
  }
  if (!rendered.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

async function fetchRecentChats(page) {
  try {
    return await page.evaluate(() => {
      const tooltipMap = new Map();
      const tooltipContainer = document.querySelector('.cdk-describedby-message-container');
      if (tooltipContainer) {
        tooltipContainer.querySelectorAll('[id^="cdk-describedby-message"]').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text) tooltipMap.set(el.id, text);
        });
      }

      const items = [];
      const seen = new Set();

      // Strategy 1: Look for explicit conversation items (Angular/SPA structure)
      const convItems = Array.from(document.querySelectorAll('[data-test-id="conversation"]'));
      
      convItems.forEach((el, index) => {
          let title = '';
          const titleEl = el.querySelector('.conversation-title');
          if (titleEl) {
              title = titleEl.textContent.replace(/\s+/g, ' ').trim();
          }
          if (!title) {
              const aria = el.getAttribute('aria-label');
              if (aria) title = aria.trim();
          }
          if (!title) {
             const describedBy = el.getAttribute('aria-describedby');
             if (describedBy) title = tooltipMap.get(describedBy) || '';
          }
          
          if (!title) return; // Skip empty titles
          
          const href = el.getAttribute('href') || '';
          const key = href || `click:${index}`; // Unique key
          
          if (seen.has(key)) return;
          seen.add(key);
          
          items.push({ 
              title, 
              href, 
              clickIndex: href ? -1 : index 
          });
      });

      if (items.length > 0) return items.slice(0, 30);

      // Strategy 2: Fallback to finding links (older UI or different view)
      const navRoot = document.querySelector('side-navigation-v2') ||
        document.querySelector('bard-side-navigation') ||
        document.querySelector('nav') ||
        document.body;

      const links = Array.from(navRoot.querySelectorAll('a[href*="/app/"]'));

      const pickTitle = (el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
        const aria = el.getAttribute('aria-label') || '';
        if (aria.trim()) return aria.trim();
        const title = el.getAttribute('title') || '';
        if (title.trim()) return title.trim();
        const describedBy = el.getAttribute('aria-describedby') || '';
        const tooltip = tooltipMap.get(describedBy);
        if (tooltip) return tooltip;
        return '';
      };

      for (const link of links) {
        const href = link.getAttribute('href') || link.href || '';
        if (!href || !href.includes('/app/')) continue;
        const title = pickTitle(link);
        const key = href;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ title, href, clickIndex: -1 });
      }

      return items.slice(0, 30);
    });
  } catch (e) {
    return [];
  }
}

async function fetchConversationMessages(page) {
  try {
    return await page.evaluate(() => {
      function domToMarkdown(node) {
        if (!node) return '';
        let md = '';
        const listStack = [];
        function append(text) { if (text) md += text; }
        function trailingNewlines() {
          const match = md.match(/\n*$/);
          return match ? match[0].length : 0;
        }
        function ensureNewlines(count) {
          const current = trailingNewlines();
          if (current < count) md += '\n'.repeat(count - current);
        }
        function fenceFor(text) {
          const matches = text.match(/`+/g) || [];
          let max = 0;
          for (const m of matches) max = Math.max(max, m.length);
          return '`'.repeat(Math.max(3, max + 1));
        }
        function inlineFence(text) {
          const matches = text.match(/`+/g) || [];
          let max = 0;
          for (const m of matches) max = Math.max(max, m.length);
          return '`'.repeat(Math.max(1, max + 1));
        }
        function escapeTableCell(text) {
          return (text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
        }
        function extractTable(table) {
          const rows = [];
          let headerCells = [];
          const thead = table.querySelector('thead');
          if (thead) {
            const headerRow = thead.querySelector('tr');
            if (headerRow) {
              headerCells = Array.from(headerRow.children)
                .filter(el => el.tagName && el.tagName.toLowerCase() === 'th')
                .map(el => escapeTableCell(el.textContent));
            }
          }
          const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr'));
          for (const row of bodyRows) {
            const cells = Array.from(row.children)
              .filter(el => el.tagName && (el.tagName.toLowerCase() === 'td' || el.tagName.toLowerCase() === 'th'))
              .map(el => escapeTableCell(el.textContent));
            if (cells.length) rows.push(cells);
          }
          if (!headerCells.length && rows.length) {
            headerCells = rows.shift();
          }
          if (!headerCells.length) return;
          const colCount = Math.max(headerCells.length, ...rows.map(r => r.length));
          const pad = (arr) => {
            while (arr.length < colCount) arr.push('');
            return arr;
          };
          const header = pad([...headerCells]);
          const sep = header.map(() => '---');
          let out = `\n\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
          for (const row of rows) {
            const cells = pad([...row]);
            out += `| ${cells.join(' | ')} |\n`;
          }
          out += '\n';
          append(out);
        }
        function extractCodeBlock(block) {
          let lang = '';
          const langEl = block.querySelector('.code-block-decoration span, .header-formatted span, .code-block-decoration');
          if (langEl) lang = langEl.textContent.trim().toLowerCase();
          const codeEl = block.querySelector('code[data-test-id="code-content"], pre code, code, pre');
          let codeText = codeEl ? codeEl.textContent : '';
          codeText = codeText.replace(/\n$/, '');
          const fence = fenceFor(codeText);
          append(`\n\n${fence}${lang ? ' ' + lang : ''}\n${codeText}\n${fence}\n\n`);
        }
        function renderChildren(el, inListItem) {
          el.childNodes.forEach(child => render(child, inListItem));
        }
        function render(child, inListItem) {
          if (child.nodeType === 3) {
            append(child.textContent);
            return;
          }
          if (child.nodeType !== 1) return;
          const tag = child.tagName.toLowerCase();
          const isCodeBlock = tag === 'code-block' || child.classList.contains('code-block');
          if (isCodeBlock) { extractCodeBlock(child); return; }
          if (tag === 'pre') { extractCodeBlock(child); return; }
          if (tag === 'table') { extractTable(child); return; }
          if (tag === 'br') { append('\n'); return; }
          if (tag === 'hr') { ensureNewlines(2); append('---'); ensureNewlines(2); return; }
          if (tag === 'p') {
            if (inListItem) {
              renderChildren(child, true);
            } else {
              ensureNewlines(2);
              renderChildren(child, false);
              ensureNewlines(2);
            }
            return;
          }
          if (tag === 'h1') { ensureNewlines(2); append('# '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h2') { ensureNewlines(2); append('## '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h3') { ensureNewlines(2); append('### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h4') { ensureNewlines(2); append('#### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h5') { ensureNewlines(2); append('##### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'h6') { ensureNewlines(2); append('###### '); renderChildren(child, false); ensureNewlines(2); return; }
          if (tag === 'ul') {
            listStack.push({ type: 'ul', index: 0 });
            ensureNewlines(2);
            renderChildren(child, false);
            listStack.pop();
            ensureNewlines(2);
            return;
          }
          if (tag === 'ol') {
            listStack.push({ type: 'ol', index: 0 });
            ensureNewlines(2);
            renderChildren(child, false);
            listStack.pop();
            ensureNewlines(2);
            return;
          }
          if (tag === 'li') {
            ensureNewlines(1);
            const depth = Math.max(0, listStack.length - 1);
            const indent = '  '.repeat(depth);
            const top = listStack[listStack.length - 1];
            let marker = '-';
            if (top && top.type === 'ol') marker = `${++top.index}.`;
            append(`${indent}${marker} `);
            renderChildren(child, true);
            return;
          }
          if (tag === 'blockquote') {
            ensureNewlines(2);
            const original = md;
            md = '';
            renderChildren(child, false);
            const content = md.trim().split('\n');
            md = original;
            for (const line of content) append(`> ${line}\n`);
            ensureNewlines(2);
            return;
          }
          if (tag === 'strong' || tag === 'b') { append('**'); renderChildren(child, inListItem); append('**'); return; }
          if (tag === 'em' || tag === 'i') { append('_'); renderChildren(child, inListItem); append('_'); return; }
          if (tag === 'code') {
            const text = child.textContent || '';
            const fence = inlineFence(text);
            append(`${fence}${text}${fence}`);
            return;
          }
          if (tag === 'a') {
            const href = child.getAttribute('href') || '';
            append('[');
            renderChildren(child, inListItem);
            append(`](${href})`);
            return;
          }
          renderChildren(child, inListItem);
        }
        renderChildren(node, false);
        return md.trim();
      }

      const root = document.querySelector('chat-window-content') ||
        document.querySelector('chat-window') ||
        document.querySelector('main') ||
        document.body;

      const userSelectors = [
        'user-message',
        '[data-test-id="user-message"]',
        '.user-message',
        '.user-message-content',
        '.query-text',
        '.user-query'
      ];
      // Use Set to avoid duplicate nodes from overlapping selectors
      const userNodes = Array.from(new Set(Array.from(root.querySelectorAll(userSelectors.join(',')))));
      
      const aiSelectors = [
          'response-container', 
          'model-response', 
          '.model-response-text', 
          '.message-content', 
          '.markdown'
      ];
      // Filter out nodes that are descendants of other nodes in the list to avoid double counting
      const rawAiNodes = Array.from(root.querySelectorAll(aiSelectors.join(',')));
      const aiNodes = rawAiNodes.filter(node => {
          // If this node has an ancestor that is also in the list, ignore it (we want the top-level container)
          return !rawAiNodes.some(other => other !== node && other.contains(node));
      });

      const items = [];
      const seenTexts = new Set(); // Dedup by text content

      for (const node of userNodes) {
        const text = (node.innerText || node.textContent || '').trim();
        if (!text) continue;
        // Simple dedup: if we've seen this exact text recently, skip. 
        // (Assumes users don't type exact same thing twice in a row usually, or if they do, we can live with it for now to fix the bug)
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);
        items.push({ role: 'user', text, node });
      }

      for (const node of aiNodes) {
        let text = domToMarkdown(node);
        if (!text || !text.trim()) {
          text = (node.innerText || node.textContent || '').trim();
        }
        if (!text) continue;
        
        // Remove trailing "show drafts" or other UI noise
        text = text.replace(/Show drafts\s*$/, '').trim();
        
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);
        
        items.push({ role: 'ai', text, node });
      }

      items.sort((a, b) => {
        if (a.node === b.node) return 0;
        const pos = a.node.compareDocumentPosition(b.node);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      return items.map(({ role, text }) => ({ role, text }));
    });
  } catch (e) {
    return [];
  }
}

async function selectChatFromList(chats) {
  if (!process.stdin.isTTY) return null;
  // Ensure stdin is flowing (rl.close() often pauses it)
  process.stdin.resume();

  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (!wasRaw) stdin.setRawMode(true);

    let index = 0;
    let renderedLines = 0;

    const render = () => {
      if (renderedLines > 0) {
        process.stdout.write(`\x1b[${renderedLines}A`);
        process.stdout.write('\r');
        process.stdout.write('\x1b[J');
      }
      
      const header = chalk.cyan('Select a chat (↑/↓, Enter to open, Esc to cancel):');
      console.log(header);
      
      const maxToShow = Math.min(chats.length, 12);
      const start = Math.max(0, Math.min(index - Math.floor(maxToShow / 2), chats.length - maxToShow));
      const end = start + maxToShow;
      
      const cols = process.stdout.columns || 80;
      
      for (let i = start; i < end; i++) {
        const item = chats[i];
        let label = item.title || '(untitled)';
        
        // Truncate label to prevent wrapping
        // Prefix is " > " (3 chars) + 1 space = 4 chars roughly
        const maxLabelWidth = Math.max(10, cols - 6);
        if (label.length > maxLabelWidth) {
            label = label.substring(0, maxLabelWidth - 3) + '...';
        }

        const prefix = i === index ? ' > ' : '   ';
        const line = `${prefix}${label}`;
        
        if (i === index) {
          console.log(chalk.inverse(line));
        } else {
          console.log(line);
        }
      }
      renderedLines = 1 + maxToShow;
    };

    const cleanup = () => {
      if (!wasRaw) stdin.setRawMode(false);
      stdin.removeListener('keypress', onKeypress);
      process.stdout.write('\x1b[?25h');
    };

    const onKeypress = (_str, key) => {
      if (!key) return;
      if (key.name === 'up') {
        index = (index - 1 + chats.length) % chats.length;
        render();
        return;
      }
      if (key.name === 'down') {
        index = (index + 1) % chats.length;
        render();
        return;
      }
      if (key.name === 'return') {
        cleanup();
        process.stdout.write('\n');
        resolve(chats[index]);
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        process.stdout.write('\n');
        resolve(null);
      }
    };

    process.stdout.write('\x1b[?25l');
    stdin.on('keypress', onKeypress);
    render();
  });
}

// Configuration
const CHROMIUM_PATH = '/bin/chromium'; // Found via `which chromium`
const USER_DATA_DIR = '/home/lewis/.config/chromium-chatbot';
const SESSION_FILE = path.join(__dirname, '.browser-session');
const PID_FILE = path.join(__dirname, '.chatbot-pid');
const GEMINI_URL = 'https://gemini.google.com/app?hl=en-gb';
const RESPONSE_SELECTOR = '.model-response-text, .markdown, .message-content';
const RESPONSE_CONTAINER_SELECTOR = 'response-container, .response-container';

const streamHandlers = {
  onNewChunk: null,
  onFinalMarkdown: null,
  onResponseComplete: null,
};



const exposedPages = new WeakSet();

async function ensureStreamHooks(page) {
  if (exposedPages.has(page)) return;
  await page.exposeFunction('onNewChunk', (chunk) => {
    if (streamHandlers.onNewChunk) streamHandlers.onNewChunk(chunk);
  });
  await page.exposeFunction('onFinalMarkdown', (md) => {
    if (streamHandlers.onFinalMarkdown) streamHandlers.onFinalMarkdown(md);
  });
  await page.exposeFunction('onResponseComplete', () => {
    if (streamHandlers.onResponseComplete) streamHandlers.onResponseComplete();
  });
  exposedPages.add(page);
}

const helpText = `
NAME
    chatbot - A terminal-based CLI for Google Gemini.

SYNOPSIS
    chatbot [options]

DESCRIPTION
    A robust, terminal-based interface for Google Gemini using Puppeteer. 
    It supports persistent sessions, streaming responses, and chat history navigation.

OPTIONS
    --gemini-fast
        Use the Gemini Flash (Fast) model.
    
    --gemini-pro
        Use the Gemini Pro (Advanced) model.

    --temp
        Use a temporary profile instead of the default one.

    --port <number>
        Connect to an existing browser on the specified remote debugging port.

    --reload
        Force a page reload on startup. Useful if the browser session has timed out.

    --help
        Display this help message.

OPERATION
    The chatbot connects to a Chromium instance (either existing or new) and automates
    interactions with the Gemini web interface. It streams responses directly to the terminal
    using Markdown rendering.

EXAMPLES
    Start with default settings:
        chatbot

    Start with Gemini Fast model:
        chatbot --gemini-fast

    Start with Gemini Pro model:
        chatbot --gemini-pro

    Connect to specific port:
        chatbot --port 9222

FILES
    ~/.config/chromium
        Default user data directory for the browser profile.
    
    .browser-session
        Stores the WebSocket endpoint for persistent sessions.

PATHS
    ${__filename}
        Main application script.

SECURITY NOTES
    - This tool automates a real browser session. 
    - Ensure you are logged into Google in the browser instance.
    - Session data is stored locally.

EXIT STATUS
    0   Success
    1   Error
    130 Interrupted (Ctrl+C)

AUTHORS
    Terrydaktal <9lewis9@gmail.com>
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(helpText);
    process.exit(0);
}

program
  .option('--gemini-fast', 'Use the Gemini Flash (Fast) model')
  .option('--gemini-pro', 'Use the Gemini Pro (Advanced) model')
  .option('--gemini-flash', 'Alias for --gemini-fast (deprecated)')
  .option('--temp', 'Use a temporary profile instead of the default one')
  .option('--port <number>', 'Connect to an existing browser on the specified remote debugging port')
  .option('--reload', 'Force a page reload on startup to ensure a fresh session')
  .helpOption(false)
  .allowUnknownOption(true)
  .parse(process.argv);

const options = program.opts();
if (options.geminiFlash) options.geminiFast = true;

async function getBrowser() {
  let browser;

  if (options.reload) {
    console.log(chalk.yellow('Reload requested. Closing existing sessions and processes...'));
    
    // 1. Try to close via known session endpoint
    if (fs.existsSync(SESSION_FILE)) {
      try {
        const wsEndpoint = fs.readFileSync(SESSION_FILE, 'utf8').trim();
        const existingBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
        await existingBrowser.close();
        console.log(chalk.dim('Closed existing browser session via endpoint.'));
      } catch (e) {
        // Ignore if we can't connect/close
      }
      fs.unlinkSync(SESSION_FILE);
    }

    // 2. Kill the specific browser process we started previously
    if (fs.existsSync(PID_FILE)) {
      try {
        const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          console.log(chalk.dim(`Killing tracked browser process ${pid}...`));
          try {
             process.kill(pid, 'SIGTERM');
             // Wait a moment for process to exit
             await new Promise(r => setTimeout(r, 1000));
          } catch(e) {
             console.log(chalk.dim(`Process ${pid} already exited or cannot be killed.`));
          }
        }
      } catch (e) {
        console.error(chalk.red('Error reading/killing PID:'), e.message);
      }
      // Clean up the PID file
      try { fs.unlinkSync(PID_FILE); } catch(e) {}
    }

    // Fallback: Clear SingletonLock if we are sure we are reloading and targeting our profile
    // (Only if not temp, as temp doesn't use the main lock)
    if (!options.temp) {
      const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
      if (fs.existsSync(lockFile)) {
         // We do NOT use fuser here anymore to avoid killing other random Chrome instances.
         // If the lock persists after killing the specific PID, we assume it's stale and remove it.
         // But we only remove it if we successfully killed our PID or if we are forced.
         /* 
            REMOVED: Deleting SingletonLock manually causes Chromium to detect a crash
            and reset preferences (search engine, login status) on next boot.
            We rely on process.kill(SIGTERM) to allow a reasonably clean exit,
            or let the user handle it if it's truly stuck.
         */
      }
    }
  }

  // 1. Connect via specified port (Skip if reload is requested, as we want to launch fresh)
  if (options.port && !options.reload) {
      try {
          const browserURL = `http://127.0.0.1:${options.port}`;
          console.log(chalk.blue(`Connecting to browser at ${browserURL}...`));
          // defaultViewport: null is crucial for the window to resize correctly
          browser = await puppeteer.connect({ browserURL, defaultViewport: null });
          console.log(chalk.green('Connected to existing browser instance via port.'));
      } catch (e) {
          console.error(chalk.red(`Failed to connect to browser on port ${options.port}:`), e.message);
          process.exit(1);
      }
  }
  
  // 2. Try to connect to existing session if not already connected (Skip if reload requested)
  if (!browser && !options.reload && fs.existsSync(SESSION_FILE)) {
    try {
      const wsEndpoint = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
      console.log(chalk.green('Connected to existing browser session.'));
    } catch (e) {
      console.log(chalk.yellow('Existing session invalid or closed.'));
      fs.unlinkSync(SESSION_FILE);
    }
  }

  // 3. Launch new browser if still not connected
  if (!browser) {
      // Check for DISPLAY to prevent immediate crash over SSH
      // We explicitly check if we can reach the desktop display (:0) using the home Xauthority
      const targetDisplay = process.env.DISPLAY || ':0';
      const targetAuth = process.env.XAUTHORITY || path.join(process.env.HOME, '.Xauthority');
      
      try {
         // Try to connect to the target display with the target authority
         execSync(`XAUTHORITY="${targetAuth}" xdpyinfo -display "${targetDisplay}" >/dev/null 2>&1`);
         console.log(chalk.dim(`Confirmed access to X server at ${targetDisplay}`));
      } catch (e) {
         console.error(chalk.red('\nError: Unable to connect to X server.'));
         console.error(chalk.yellow(`Could not access display "${targetDisplay}" using authority "${targetAuth}".`));
         console.error(chalk.white('If running from SSH, this prevents launching the browser on the remote desktop to avoid crashing the profile.'));
         console.error(chalk.white('Solution: Run "export DISPLAY=:0" and ensure you have access to .Xauthority, or use "ssh -X".'));
         process.exit(1);
      }

      console.log(chalk.blue('Launching new browser instance...'));
      console.log(chalk.dim(`DBUS_SESSION_BUS_ADDRESS: ${process.env.DBUS_SESSION_BUS_ADDRESS}`));
      console.log(chalk.dim(`XDG_CURRENT_DESKTOP: ${process.env.XDG_CURRENT_DESKTOP}`));
      
      const launchOptions = {
        executablePath: CHROMIUM_PATH,
        userDataDir: options.temp ? undefined : USER_DATA_DIR,
        headless: false,
        defaultViewport: null,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-session-crashed-bubble', // Prevent "Restore pages?" popup
          '--disable-infobars',
          '--restore-last-session'
        ],
        ignoreDefaultArgs: ['--enable-automation', '--disable-blink-features=AutomationControlled'],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        env: {
            ...process.env,
            DISPLAY: process.env.DISPLAY || ':0',
            XAUTHORITY: process.env.XAUTHORITY || path.join(process.env.HOME, '.Xauthority')
        }
      };

      if (options.port) {
        launchOptions.args.push(`--remote-debugging-port=${options.port}`);
      }

      try {
          browser = await puppeteer.launch(launchOptions);
      } catch (err) {
          if (err.message.includes('Failed to launch') || err.message.includes('SingletonLock')) {
              console.error(chalk.red('\nError: Could not open the browser with your profile.'));
              console.error(chalk.white('This usually means Chromium is already running with this profile.'));
              
              const answer = await askQuestion(chalk.cyan('Would you like to (r)etry after closing Chrome, or use a (t)emporary profile? [r/t]: '));
              
              if (answer.toLowerCase().startsWith('t')) {
                  console.log(chalk.yellow('Switching to temporary profile...'));
                  launchOptions.userDataDir = undefined;
                  browser = await puppeteer.launch(launchOptions);
              } else {
                  console.log(chalk.yellow('Please close Chromium and press Enter...'));
                  await askQuestion('');
                  browser = await puppeteer.launch(launchOptions);
              }
          } else {
              throw err;
          }
      }
  }

  if (browser && browser.process()) {
      fs.writeFileSync(PID_FILE, browser.process().pid.toString());
  }

  // Save the WS Endpoint for reuse in subsequent calls
  const wsEndpoint = browser.wsEndpoint();
  fs.writeFileSync(SESSION_FILE, wsEndpoint);
  
  return browser;
}

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function main() {
  const browser = await getBrowser();
  globalBrowser = browser;
  
  const pages = await browser.pages();
  console.log(chalk.dim(`Found ${pages.length} open tabs.`));

  // Priority: 
  // 1. Existing Gemini tab
  // 2. The active tab (if it's empty/new tab)
  // 3. New tab
  
  let page = pages.find(p => p.url().includes('gemini.google.com'));
  
  if (!page) {
      // Check if the first tab is a blank "New Tab"
      const firstPage = pages[0];
      const url = firstPage.url();
      if (url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') {
          page = firstPage;
          console.log(chalk.blue('Navigating existing new tab to Gemini...'));
      } else {
          console.log(chalk.blue('Opening new tab for Gemini...'));
          page = await browser.newPage();
      }
      await applyVisibilityOverride(page);
      await applyLifecycleOverrides(page);
      await page.goto(GEMINI_URL);
  } else {
    console.log(chalk.green('Found existing Gemini tab. Switching to it...'));
    // await page.bringToFront(); // Disable auto-focus on reconnect

    await applyVisibilityOverride(page);
    await applyLifecycleOverrides(page);
    if (page.url() !== GEMINI_URL) {
         await page.goto(GEMINI_URL);
    }
  }

  // Visual confirmation
  try {
      const title = await page.title();
      console.log(chalk.cyan(`Controlling page: "${title}"`));
      
      // Flash the body to show the user which tab we have
      await page.evaluate(() => {
          document.body.style.transition = 'opacity 0.5s';
          document.body.style.opacity = '0.5';
          setTimeout(() => document.body.style.opacity = '1.0', 500);
      });
  } catch(e) {}

  console.log(chalk.cyan('Waiting for Gemini interface to load...'));
  
  try {
      // Wait for the specific input area container to ensure app is loaded
      // Increased timeout to 5 minutes to allow for login
      console.log(chalk.dim('Waiting up to 5 minutes for page to be ready (please log in if prompted)...'));
      await page.waitForSelector('.ql-editor, textarea, [contenteditable="true"]', { timeout: 300000 });
  } catch(e) {
      console.error(chalk.red('Timeout waiting for page load. Please check the browser window.'));
  }

  if (options.geminiFast) {
    console.log(chalk.magenta('Ensuring Gemini Fast/Flash model is selected...'));
    await ensureModel(page, ['Flash', 'Fast']);
  } else if (options.geminiPro) {
    console.log(chalk.magenta('Ensuring Gemini Pro/Advanced model is selected...'));
    await ensureModel(page, ['Advanced', 'Pro', 'Ultra']);
  }

  // Start the interactive chat loop
  startChatInterface(page, browser);
}

async function ensureModel(page, modelKeywords) {
    try {
        console.log(chalk.yellow(`Checking model selector for: ${modelKeywords.join(' or ')}...`));
        
        const modelBadgeSelectors = [
            '[data-test-id="bard-mode-menu-button"]',
            'button.input-area-switch',
            'button[aria-haspopup="menu"]',
            '.model-selector', 
            'button[data-test-id="model-selector"]'
        ];
        
        let modelBadge;
        for (const sel of modelBadgeSelectors) {
             modelBadge = await page.$(sel);
             if (modelBadge) break;
        }

        if (modelBadge) {
            const text = await page.evaluate(el => el.innerText, modelBadge);
            console.log(chalk.dim(`Current model badge text: "${text}"`));
            
            if (modelKeywords.some(kw => text.includes(kw))) {
                console.log(chalk.green(`Target model (${modelKeywords[0]}) is already active.`));
                return;
            }
            
            console.log(chalk.yellow('Opening model menu...'));
            await modelBadge.click();
            
            try {
                let targetOption;
                
                // Strategy 1: Look for data-test-id based on keywords
                // Keywords: ['Flash', 'Fast'] -> data-test-id="bard-mode-option-fast"
                // Keywords: ['Advanced', 'Pro', 'Ultra'] -> data-test-id="bard-mode-option-pro"
                
                const isFast = modelKeywords.some(k => ['Flash', 'Fast'].includes(k));
                const isPro = modelKeywords.some(k => ['Advanced', 'Pro', 'Ultra'].includes(k));
                
                if (isFast) {
                    try {
                        targetOption = await page.waitForSelector('button[data-test-id="bard-mode-option-fast"]', { timeout: 1000 });
                    } catch(e) {}
                } else if (isPro) {
                     try {
                        targetOption = await page.waitForSelector('button[data-test-id="bard-mode-option-pro"]', { timeout: 1000 });
                    } catch(e) {}
                }

                // Strategy 2: Fallback to text matching if explicit IDs fail
                if (!targetOption) {
                    for (const kw of modelKeywords) {
                        try {
                            targetOption = await page.waitForSelector(`xpath/.//button//span[contains(text(), "${kw}")]`, { timeout: 500 });
                            if (targetOption) break;
                        } catch(e) {}
                    }
                }
                
                if (targetOption) {
                    console.log(chalk.yellow(`Selecting model...`));
                    await targetOption.click();
                    await new Promise(r => setTimeout(r, 2000));
                    return;
                } else {
                     console.log(chalk.red(`Model option '${modelKeywords.join('/')}' not found in menu.`));
                }
            } catch (e) {
                console.log(chalk.yellow('Could not find model option in menu (timeout).'));
            }
        } else {
             console.log(chalk.red('Could not find model selector dropdown.'));
        }
    } catch (error) {
        console.error(chalk.red('Failed to switch model automatically:'), error.message);
    }
}

async function startChatInterface(page, browser) {
  const runLoop = () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.bold.green('\nYou > ')
    });

    rl.on('SIGINT', () => {
        // Pass to process listener
        process.emit('SIGINT');
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        rl.close();
        console.log(chalk.blue('Exiting CLI. Browser session remains open for reuse.'));
        browser.disconnect();
        process.exit(0);
      }

      if (input.toLowerCase() === '/chats') {
        rl.close(); // Close RL to free up stdin for raw mode
        
        const chats = await fetchRecentChats(page);
        
        // Add "New Chat" option at the beginning
        chats.unshift({ title: chalk.bold.green('+ New Chat'), isNewChat: true });

        if (!chats.length) {
          console.log(chalk.yellow('No recent chats found in the sidebar.'));
        } else {
          const selected = await selectChatFromList(chats);
          if (selected) {
            if (selected.isNewChat) {
                console.log(chalk.cyan('\nStarting new chat...'));
                await page.goto(GEMINI_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            } else {
                console.log(chalk.cyan(`\nLoading chat: ${selected.title || 'Untitled'}`));
                
                if (selected.clickIndex >= 0) {
                     console.log(chalk.dim('Clicking chat item in sidebar...'));
                     try {
                         await page.evaluate((index) => {
                             const items = document.querySelectorAll('[data-test-id="conversation"]');
                             if (items[index]) items[index].click();
                         }, selected.clickIndex);
                         
                         // Wait for some network activity or DOM change
                         try {
                             await page.waitForNetworkIdle({ timeout: 10000, idleTime: 500 });
                         } catch(e) { /* ignore timeout */ }
                         
                     } catch (e) {
                         console.error(chalk.red('Failed to click chat item:'), e.message);
                     }
                } else {
                    const targetUrl = selected.href
                      ? new URL(selected.href, GEMINI_URL).toString()
                      : GEMINI_URL;
                    console.log(chalk.dim(`Navigating to: ${targetUrl}`)); // Debug log
                    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                }
            }

            // Wait for input first (basic app load)
            await page.waitForSelector('.ql-editor, textarea, [contenteditable="true"]', { timeout: 300000 });
            
            if (!selected.isNewChat) {
                // Try to wait for any message content to appear, to avoid premature "No messages"
                try {
                    await page.waitForSelector('user-message, response-container, .message-content', { timeout: 5000 });
                } catch (e) {
                    // It's okay if this times out (e.g. empty new chat), we'll check manually next
                }
            }

            await applyVisibilityOverride(page);
            await applyLifecycleOverrides(page);

            if (!selected.isNewChat) {
                let history = await fetchConversationMessages(page);
                
                // Retry once if empty, in case of slow hydration
                if (!history.length) {
                    console.log(chalk.dim('Waiting for messages to render...'));
                    await new Promise(r => setTimeout(r, 3000));
                    history = await fetchConversationMessages(page);
                }

                if (!history.length) {
                  console.log(chalk.yellow('No messages found in this chat.'));
                } else {
                  console.log(chalk.magenta('\nChat history:\n'));
                  for (const msg of history) {
                    if (msg.role === 'user') {
                      console.log(chalk.bold.green('You > ') + msg.text);
                    } else {
                      console.log(chalk.bold.cyan('Gemini > '));
                      const rendered = marked(normalizeMarkdown(msg.text || ''));
                      console.log(rendered.trimEnd());
                    }
                    console.log('');
                  }
                }
            }
          }
        }
        
        // Restart loop
        runLoop();
        return;
      }

      if (input) {
        let finalPrompt = input;
        
        // Handle @include expansion
        const includeRegex = /@include\s+("([^"]+)"|'([^']+)'|([^\s]+))/g;
        let match;
        let expansionError = false;

        // Collect replacements first to avoid issues with regex index when modifying string
        const replacements = [];
        
        while ((match = includeRegex.exec(input)) !== null) {
            const fullMatch = match[0];
            const filePath = match[2] || match[3] || match[4];
            
            try {
                const absolutePath = path.resolve(process.cwd(), filePath);
                if (fs.existsSync(absolutePath)) {
                    const content = fs.readFileSync(absolutePath, 'utf8');
                    replacements.push({ 
                        original: fullMatch, 
                        content: `\n\n--- Start of ${path.basename(filePath)} ---\n${content}\n--- End of ${path.basename(filePath)} ---\n` 
                    });
                } else {
                    console.log(chalk.red(`Error: File not found: ${filePath}`));
                    expansionError = true;
                }
            } catch (err) {
                console.log(chalk.red(`Error reading file ${filePath}: ${err.message}`));
                expansionError = true;
            }
        }

        // Handle #transcript expansion
        // Supports flags: #transcript --all --lang "ru" <url>
        const transcriptRegex = /#transcript\s+(?:(.+?)\s+)?(https?:\/\/[^\s]+)/g;
        while ((match = transcriptRegex.exec(input)) !== null) {
            const fullMatch = match[0];
            const flags = match[1] || ''; // e.g. "--all --lang \"ru\""
            const url = match[2];

            // Validate YouTube URL
            const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
            if (!ytRegex.test(url)) {
                console.log(chalk.red(`Error: Invalid YouTube URL: ${url}`));
                expansionError = true;
                continue;
            }

            try {
                console.log(chalk.cyan(`Fetching transcript for: ${url} ${flags ? `(${flags})` : ''}...`));
                const transcriptPath = path.resolve(__dirname, 'transcript');
                
                // Construct command
                const cmd = flags ? `"${transcriptPath}" ${flags} "${url}"` : `"${transcriptPath}" "${url}"`;
                
                const output = execSync(cmd, { encoding: 'utf8' }).trim();
                
                let expansion = `\n\n--- Transcript for YouTube video ---\n`;
                if (flags.includes('--all')) {
                    try {
                        const data = JSON.parse(output);
                        if (data.title) expansion += `Title: ${data.title}\n`;
                        if (data.description) expansion += `Description: ${data.description}\n`;
                        expansion += `Transcript: ${data.transcript}\n`;
                    } catch(e) {
                        expansion += `Transcript: ${output}\n`;
                    }
                } else {
                    expansion += `Transcript: ${output}\n`;
                }
                expansion += `--- End of Transcript ---\n`;
                
                replacements.push({ original: fullMatch, content: expansion });
            } catch (err) {
                console.log(chalk.red(`Error fetching transcript for ${url}: ${err.message}`));
                expansionError = true;
            }
        }


        if (expansionError) {
             rl.prompt();
             return;
        }

        for (const rep of replacements) {
            finalPrompt = finalPrompt.replace(rep.original, rep.content);
        }

        rl.pause(); // Stop input while processing
        await sendPromptToGemini(page, finalPrompt);
        rl.resume();
      }
      rl.prompt();
    });
  };

  runLoop();
}

async function sendPromptToGemini(page, promptText) {
  // Enhanced selector list for the main chat input
  const inputSelectors = [
      '.ql-editor.textarea',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]', 
      'textarea[placeholder*="Ask"]',
      'textarea'
  ];
  
  let inputElement;
  for (const selector of inputSelectors) {
      try {
          inputElement = await page.waitForSelector(selector, { timeout: 2000 });
          if (inputElement) {
              // Double check visibility
              const isVisible = await page.evaluate(el => {
                  const style = window.getComputedStyle(el);
                  return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
              }, inputElement);
              
              if (isVisible) break;
          }
      } catch (e) { continue; }
  }

  if (!inputElement) {
       console.error(chalk.red('Could not find chat input box. The page layout might have changed.'));
       return;
  }
  
  // Wake up the tab before interaction to prevent background throttling
  await applyLifecycleOverrides(page);
  await applyVisibilityOverride(page);
  
  try {
    await inputElement.focus();

    // Check for stuck "Stop" button and click it if present
    try {
        // Expanded selectors for the Stop button
        const stopSelectors = [
            'button[aria-label*="Stop"]', 
            'button[data-test-id="stop-response-button"]',
            'button.send-button.stop', // Class based
            'button:has(mat-icon[data-mat-icon-name="stop"])' // Inner icon based
        ];
        
        let stopBtn = null;
        for (const sel of stopSelectors) {
            try {
                stopBtn = await page.$(sel);
                if (stopBtn) break;
            } catch(e) {} // :has pseudo-class might require newer Puppeteer/Chrome
        }

        if (stopBtn) {
            // console.log(chalk.dim('Clearing stuck "Stop" button...'));
            await stopBtn.click();
            await new Promise(r => setTimeout(r, 500)); // Wait for UI to update
        }
    } catch (e) {}

    // Count existing message bubbles before sending
    const initialCount = await page.evaluate((responseSelector, responseContainerSelector) => {
        const allCandidates = Array.from(document.querySelectorAll(responseSelector));
        const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
        return (scopedCandidates.length ? scopedCandidates : allCandidates).length;
    }, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
    
    // Send prompt
    if (promptText.length > 200) {
        // Use clipboard paste for large text
        await page.evaluate((text) => {
            const data = new DataTransfer();
            data.setData('text/plain', text);
            const event = new ClipboardEvent('paste', {
                clipboardData: data,
                bubbles: true,
                cancelable: true
            });
            document.activeElement.dispatchEvent(event);
            
            // Fallback if paste event doesn't trigger native insertion (often blocked)
            // But for Gemini's rich text editor, we might need execCommand
            if (document.activeElement.innerText.trim() === '') {
                 document.execCommand('insertText', false, text);
            }
        }, promptText);
    } else {
        await page.keyboard.type(promptText);
        
        // Verify text was entered
        const currentText = await page.evaluate(el => el.innerText, inputElement);
        if (!currentText || currentText.trim() === '') {
            // console.log(chalk.dim('Typing failed, forcing text insertion...'));
            await page.evaluate((el, text) => {
                el.focus();
                document.execCommand('insertText', false, text);
            }, inputElement, promptText);
        }
    }
    
    await new Promise(r => setTimeout(r, 300)); // Small delay for UI update
    await page.keyboard.press('Enter');

    await waitForResponseAndRender(page, initialCount);

  } catch (error) {
    console.error(chalk.red('Error interacting with page:'), error.message);
  }
}

async function streamResponse(page, initialCount) {
    let resolveStream;
    const streamPromise = new Promise(resolve => { resolveStream = resolve; });

    const charQueue = [];
    let isTyping = false;
    let fullText = '';
    let responseCompleteTriggered = false;
    let streamedText = '';
    let finalizeStarted = false;
    let streamCol = 0;
    let streamLines = 1;

    // ANSI Strip Regex for accurate line counting
    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    function stripAnsi(str) {
        return str.replace(ansiRegex, '');
    }

    // Helper to calculate roughly how many lines the raw text occupied
    function calculateRawLines(text) {
        const columns = process.stdout.columns || 80;
        const lines = text.split('\n');
        let visualLineCount = 0;
        for (const line of lines) {
            const cleanLine = stripAnsi(line);
            const rows = Math.max(1, Math.ceil(cleanLine.length / columns));
            visualLineCount += rows;
        }
        return visualLineCount;
    }

    async function fetchCopyMarkdown() {
        try {
            return await page.evaluate((responseSelector, responseContainerSelector) => {
                const allCandidates = Array.from(document.querySelectorAll(responseSelector));
                const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
                const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
                const latest = candidates[candidates.length - 1];
                const container = latest ? latest.closest(responseContainerSelector) : null;
                const copyBtn = container ? container.querySelector('button[data-test-id="copy-button"]') : null;
                if (!copyBtn) return null;

                let captured = null;
                const onCopy = (e) => {
                    try {
                        captured = e.clipboardData.getData('text/plain');
                    } catch (err) {}
                    e.preventDefault();
                };
                document.addEventListener('copy', onCopy);

                let originalWriteText = null;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
                    navigator.clipboard.writeText = async (text) => {
                        captured = text;
                        return Promise.resolve();
                    };
                }

                const originalExecCommand = document.execCommand;
                document.execCommand = function () { return true; };

                copyBtn.click();

                return new Promise((resolve) => {
                    setTimeout(() => {
                        document.removeEventListener('copy', onCopy);
                        if (originalWriteText) {
                            navigator.clipboard.writeText = originalWriteText;
                        }
                        document.execCommand = originalExecCommand;
                        resolve(captured);
                    }, 50);
                });
            }, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
        } catch (err) {
            return null;
        }
    }

    function normalizeMarkdown(md) {
        const lines = md.split('\n');
        const out = [];
        let inFence = false;
        let inTable = false;
        let tablePipeCount = 0;

        function isTableSepLine(value) {
            return /^\s*\|?[-:\s]+\|[-:\s|]*$/.test(value);
        }
        function countPipes(value) {
            let count = 0;
            for (let i = 0; i < value.length; i++) {
                if (value[i] === '|' && value[i - 1] !== '\\') count++;
            }
            return count;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('```')) {
                inFence = !inFence;
                out.push(line);
                continue;
            }
            if (inFence) {
                out.push(line);
                continue;
            }

            const next = lines[i + 1] || '';
            const pipeCount = countPipes(line);

            if (!inTable && pipeCount >= 2 && isTableSepLine(next)) {
                inTable = true;
                tablePipeCount = pipeCount;
                out.push(line);
                continue;
            }

            if (inTable) {
                if (trimmed === '') {
                    out.push('');
                    inTable = false;
                    tablePipeCount = 0;
                    continue;
                }
                if (isTableSepLine(line) || pipeCount >= tablePipeCount) {
                    out.push(line);
                    continue;
                }
                if (out.length) {
                    out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`;
                } else {
                    out.push(trimmed);
                }
                continue;
            }

            if (trimmed === '') {
                out.push('');
                continue;
            }

            const isBlockStart = /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|---$|___$|\*\*\*$|\s*•\s)/.test(line);
            if (isBlockStart) {
                out.push(line);
                continue;
            }

            const prev = out[out.length - 1] || '';
            const prevBlock = /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|---$|___$|\*\*\*$|\s*•\s)/.test(prev);
            if (out.length && prev !== '' && !prevBlock && !prev.trim().endsWith('  ')) {
                out[out.length - 1] = `${prev} ${trimmed}`;
            } else {
                out.push(trimmed);
            }
        }
        return out.join('\n');
    }

    async function finalizeResponse() {
        let finalText = fullText;
        const copied = await fetchCopyMarkdown();
        if (copied && copied.trim()) {
            finalText = copied;
        }
        finalText = normalizeMarkdown(finalText);
        fullText = finalText;

        const rawLineCount = calculateRawLines(streamedText || fullText);
        const linesToClear = Math.max(streamLines, rawLineCount);

        if (process.stdout.isTTY && linesToClear > 0) {
            if (linesToClear > 1) {
                process.stdout.write(`\x1b[${linesToClear - 1}A`);
            }
            process.stdout.write('\r');
            process.stdout.write('\x1b[J'); // clear to end of screen
        } else {
            process.stdout.write('\n');
        }

        try {
            console.log(marked(finalText));
        } catch (e) {
            console.log(finalText);
        }
        resolveStream();
    }

    function typeNextChar() {
        if (charQueue.length === 0) {
            isTyping = false;
            // Check if we are done
            if (responseCompleteTriggered) {
                if (!finalizeStarted) {
                    finalizeStarted = true;
                    void finalizeResponse();
                }
            }
            return;
        }

        isTyping = true;
        const char = charQueue.shift();
        fullText += char;
        streamedText += char;
        
        // --- Direct Output ---
        if (char === '\n') {
            process.stdout.write('\n');
            streamLines += 1;
            streamCol = 0;
        } else {
            process.stdout.write(char);
            streamCol += 1;
            const cols = process.stdout.columns || OUTPUT_WIDTH;
            if (streamCol >= cols) {
                streamLines += 1;
                streamCol = 0;
            }
        }

        // Speed control
        let delay = 2; 
        if (charQueue.length > 50) delay = 0;
        setTimeout(typeNextChar, delay);
    }

    streamHandlers.onNewChunk = (chunk) => {
        charQueue.push(...chunk.split(''));
        if (!isTyping) typeNextChar();
    };

    streamHandlers.onFinalMarkdown = (md) => {
        fullText = md; // Replace accumulated raw text with the perfect DOM-converted markdown
    };

    streamHandlers.onResponseComplete = () => {
        responseCompleteTriggered = true;
        if (!isTyping && charQueue.length === 0) {
            typeNextChar(); // Trigger finish logic
        }
    };

    await ensureStreamHooks(page);

    await page.evaluate(async (initialCount, responseSelector, responseContainerSelector) => {
        function domToMarkdown(node) {
            if (!node) return '';
            let md = '';
            const listStack = [];

            function append(text) { if (text) md += text; }
            function trailingNewlines() {
                const match = md.match(/\n*$/);
                return match ? match[0].length : 0;
            }
            function ensureNewlines(count) {
                const current = trailingNewlines();
                if (current < count) md += '\n'.repeat(count - current);
            }
            function fenceFor(text) {
                const matches = text.match(/`+/g) || [];
                let max = 0;
                for (const m of matches) max = Math.max(max, m.length);
                return '`'.repeat(Math.max(3, max + 1));
            }
            function inlineFence(text) {
                const matches = text.match(/`+/g) || [];
                let max = 0;
                for (const m of matches) max = Math.max(max, m.length);
                return '`'.repeat(Math.max(1, max + 1));
            }
            function escapeTableCell(text) {
                return (text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
            }
            function extractTable(table) {
                const rows = [];
                let headerCells = [];
                const thead = table.querySelector('thead');
                if (thead) {
                    const headerRow = thead.querySelector('tr');
                    if (headerRow) {
                        headerCells = Array.from(headerRow.children)
                            .filter(el => el.tagName && el.tagName.toLowerCase() === 'th')
                            .map(el => escapeTableCell(el.textContent));
                    }
                }
                const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr'));
                for (const row of bodyRows) {
                    const cells = Array.from(row.children)
                        .filter(el => el.tagName && (el.tagName.toLowerCase() === 'td' || el.tagName.toLowerCase() === 'th'))
                        .map(el => escapeTableCell(el.textContent));
                    if (cells.length) rows.push(cells);
                }
                if (!headerCells.length && rows.length) {
                    headerCells = rows.shift();
                }
                if (!headerCells.length) return;
                const colCount = Math.max(headerCells.length, ...rows.map(r => r.length));
                const pad = (arr) => {
                    while (arr.length < colCount) arr.push('');
                    return arr;
                };
                const header = pad([...headerCells]);
                const sep = header.map(() => '---');
                let out = `\n\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
                for (const row of rows) {
                    const cells = pad([...row]);
                    out += `| ${cells.join(' | ')} |\n`;
                }
                out += '\n';
                append(out);
            }
            function extractCodeBlock(block) {
                let lang = '';
                const langEl = block.querySelector('.code-block-decoration span, .header-formatted span, .code-block-decoration');
                if (langEl) lang = langEl.textContent.trim().toLowerCase();
                const codeEl = block.querySelector('code[data-test-id="code-content"], pre code, code, pre');
                let codeText = codeEl ? codeEl.textContent : '';
                codeText = codeText.replace(/\n$/, '');
                const fence = fenceFor(codeText);
                append(`\n\n${fence}${lang ? ' ' + lang : ''}\n${codeText}\n${fence}\n\n`);
            }
            function renderChildren(el, inListItem) {
                el.childNodes.forEach(child => render(child, inListItem));
            }
            function render(child, inListItem) {
                if (child.nodeType === 3) {
                    append(child.textContent);
                    return;
                }
                if (child.nodeType !== 1) return;
                const tag = child.tagName.toLowerCase();
                const isCodeBlock = tag === 'code-block' || child.classList.contains('code-block');
                if (isCodeBlock) {
                    extractCodeBlock(child);
                    return;
                }
                if (tag === 'pre') {
                    extractCodeBlock(child);
                    return;
                }
                if (tag === 'table') {
                    extractTable(child);
                    return;
                }
                if (tag === 'br') { append('\n'); return; }
                if (tag === 'hr') { ensureNewlines(2); append('---'); ensureNewlines(2); return; }
                if (tag === 'p') {
                    if (inListItem) {
                        renderChildren(child, true);
                    } else {
                        ensureNewlines(2);
                        renderChildren(child, false);
                        ensureNewlines(2);
                    }
                    return;
                }
                if (tag === 'h1') { ensureNewlines(2); append('# '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'h2') { ensureNewlines(2); append('## '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'h3') { ensureNewlines(2); append('### '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'h4') { ensureNewlines(2); append('#### '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'h5') { ensureNewlines(2); append('##### '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'h6') { ensureNewlines(2); append('###### '); renderChildren(child, false); ensureNewlines(2); return; }
                if (tag === 'ul') {
                    listStack.push({ type: 'ul', index: 0 });
                    ensureNewlines(2);
                    renderChildren(child, false);
                    listStack.pop();
                    ensureNewlines(2);
                    return;
                }
                if (tag === 'ol') {
                    listStack.push({ type: 'ol', index: 0 });
                    ensureNewlines(2);
                    renderChildren(child, false);
                    listStack.pop();
                    ensureNewlines(2);
                    return;
                }
                if (tag === 'li') {
                    ensureNewlines(1);
                    const depth = Math.max(0, listStack.length - 1);
                    const indent = '  '.repeat(depth);
                    const top = listStack[listStack.length - 1];
                    let marker = '-';
                    if (top && top.type === 'ol') marker = `${++top.index}.`;
                    append(`${indent}${marker} `);
                    renderChildren(child, true);
                    return;
                }
                if (tag === 'blockquote') {
                    ensureNewlines(2);
                    const original = md;
                    md = '';
                    renderChildren(child, false);
                    const content = md.trim().split('\n');
                    md = original;
                    for (const line of content) append(`> ${line}\n`);
                    ensureNewlines(2);
                    return;
                }
                if (tag === 'strong' || tag === 'b') { append('**'); renderChildren(child, inListItem); append('**'); return; }
                if (tag === 'em' || tag === 'i') { append('_'); renderChildren(child, inListItem); append('_'); return; }
                if (tag === 'code') {
                    const text = child.textContent || '';
                    const fence = inlineFence(text);
                    append(`${fence}${text}${fence}`);
                    return;
                }
                if (tag === 'a') {
                    const href = child.getAttribute('href') || '';
                    append('[');
                    renderChildren(child, inListItem);
                    append(`](${href})`);
                    return;
                }
                renderChildren(child, inListItem);
            }
            renderChildren(node, false);
            return md.trim();
        }

        return new Promise((resolve) => {
            let lastTextLength = 0;
            let stableCount = 0;
            const startTime = Date.now();

            const findResponse = setInterval(() => {
                const allCandidates = Array.from(document.querySelectorAll(responseSelector));
                let candidates = allCandidates;
                const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
                if (scopedCandidates.length) {
                    candidates = scopedCandidates;
                }
                
                if (candidates.length > initialCount) {
                    const candidate = candidates[candidates.length - 1];

                    if (candidate) {
                        let currentText = candidate.innerText || '';
                        
                        if (currentText.length > lastTextLength) {
                            const newChunk = currentText.substring(lastTextLength);
                            window.onNewChunk(newChunk);
                            lastTextLength = currentText.length;
                            stableCount = 0; 
                        } else if (currentText.length === lastTextLength && currentText.length > 0) {
                            stableCount++;
                        }
                        
                        const container = candidate.closest(responseContainerSelector);
                        let isUIComplete = false;
                        if (container) {
                            if (container.querySelector('regenerate-button') || container.querySelector('thumb-up-button')) {
                                isUIComplete = true;
                            }
                        }

                        if (isUIComplete || (stableCount > 5 && lastTextLength > 0) || (Date.now() - startTime > 120000)) { 
                            clearInterval(findResponse);
                            
                            // Get final markdown
                            let finalMarkdown = domToMarkdown(candidate);
                            if (!finalMarkdown || finalMarkdown.trim().length === 0) {
                                finalMarkdown = candidate.innerText || '';
                            }
                            window.onFinalMarkdown(finalMarkdown);
                            
                            window.onResponseComplete();
                            resolve();
                        }
                    }
                } else if (Date.now() - startTime > 30000) {
                     clearInterval(findResponse);
                     console.log(chalk.red('\nResponse timed out (>30s). The session might be stale.'));
                     console.log(chalk.yellow('Try running with --reload to fix connection issues.'));
                     window.onResponseComplete();
                     resolve();
                }
            }, 200);
        });
    }, initialCount, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
    return streamPromise;
}

main().catch(err => console.error(err));
