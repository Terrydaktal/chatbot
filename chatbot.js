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

function startTypingAnimation() {
  let frameIndex = 0;
  const cols = process.stdout.columns || OUTPUT_WIDTH;
  process.stdout.write('\n');

  const render = () => {
    const frame = TYPING_FRAMES[frameIndex % TYPING_FRAMES.length];
    const text = chalk.yellow(`Gemini is typing ${frame}`);
    const pad = Math.max(0, cols - stripAnsi(text).length);
    process.stdout.write(`\r${text}${' '.repeat(pad)}`);
    frameIndex += 1;
  };

  render();
  const interval = setInterval(render, TYPING_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    process.stdout.write(`\r${' '.repeat(cols)}\r`);
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
    await client.send('Emulation.setIdleOverride', {
      isUserActive: true,
      isScreenUnlocked: true,
    });
    try {
      await client.send('Page.setWebLifecycleState', { state: 'active' });
    } catch (e) {}
    try {
      await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    } catch (e) {}
  } catch (e) {}
}

async function waitForResponseAndRender(page, initialCount) {
  const stopTyping = startTypingAnimation();

  await page.waitForFunction(
    (initialCount, responseSelector, responseContainerSelector) => {
      const allCandidates = Array.from(document.querySelectorAll(responseSelector));
      const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
      const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
      if (candidates.length <= initialCount) return false;
      const latest = candidates[candidates.length - 1];
      const container = latest ? latest.closest(responseContainerSelector) : null;
      const copyBtn = container ? container.querySelector('button[data-test-id="copy-button"]') : null;
      return !!copyBtn;
    },
    { timeout: 300000 },
    initialCount,
    RESPONSE_SELECTOR,
    RESPONSE_CONTAINER_SELECTOR
  );

  stopTyping();

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

// Configuration
const CHROMIUM_PATH = '/bin/chromium'; // Found via `which chromium`
const USER_DATA_DIR = '/home/lewis/.config/chromium';
const SESSION_FILE = path.join(__dirname, '.browser-session');
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

program
  .option('--gemini-flash', 'Use the Gemini Flash model')
  .option('--temp', 'Use a temporary profile instead of the default one')
  .option('--port <number>', 'Connect to an existing browser on the specified remote debugging port')
  .parse(process.argv);

const options = program.opts();

async function getBrowser() {
  let browser;

  // 1. Connect via specified port
  if (options.port) {
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
  
  // 2. Try to connect to existing session if not already connected
  if (!browser && fs.existsSync(SESSION_FILE)) {
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
      console.log(chalk.blue('Launching new browser instance...'));
      
      const launchOptions = {
        executablePath: CHROMIUM_PATH,
        userDataDir: options.temp ? undefined : USER_DATA_DIR,
        headless: false,
        defaultViewport: null,
        args: [
          '--no-first-run',
          '--no-default-browser-check'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      };

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
    await page.bringToFront();
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

  if (options.geminiFlash) {
    console.log(chalk.magenta('Ensuring Gemini Flash model is selected...'));
    await ensureFlashModel(page);
  }

  // Start the interactive chat loop
  startChatInterface(page, browser);
}

async function ensureFlashModel(page) {
    try {
        console.log(chalk.yellow('Checking model selector...'));
        
        // Wait briefly for UI to settle
        await new Promise(r => setTimeout(r, 2000));

        // Selector for the model dropdown button. 
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
            
            // Gemini often labels Flash as "Fast"
            if (text.includes('Flash') || text.includes('Fast')) {
                console.log(chalk.green('Gemini Flash (Fast) is already active.'));
                return;
            }
            
            // Click to open menu
            console.log(chalk.yellow('Opening model menu...'));
            await modelBadge.click();
            
            // Wait for menu items
            try {
                // Look for "Flash" in the menu items
                // Using XPath to find text containing "Flash" more robustly
                const flashOption = await page.waitForSelector('xpath/.//*[contains(text(), "Flash")]', { timeout: 3000 });
                
                if (flashOption) {
                    console.log(chalk.yellow('Selecting Flash model...'));
                    await flashOption.click();
                    // Wait for reload or UI update
                    await new Promise(r => setTimeout(r, 2000));
                    return;
                } else {
                     console.log(chalk.red('Flash option not found in menu.'));
                }
            } catch (e) {
                console.log(chalk.yellow('Could not find Flash option in menu (timeout).'));
            }
        } else {
             console.log(chalk.red('Could not find model selector dropdown.'));
        }
    } catch (error) {
        console.error(chalk.red('Failed to switch model automatically:'), error.message);
    }
}

async function startChatInterface(page, browser) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.green('\nYou > ')
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

    if (input) {
      rl.pause(); // Stop input while processing
      await sendPromptToGemini(page, input);
      rl.resume();
    }
    rl.prompt();
  });
}

async function sendPromptToGemini(page, promptText) {
  // Enhanced selector list for the main chat input
  const inputSelectors = [
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
  
  try {
    await inputElement.focus();

    // Count existing message bubbles before sending
    const initialCount = await page.evaluate((responseSelector, responseContainerSelector) => {
        const allCandidates = Array.from(document.querySelectorAll(responseSelector));
        const scopedCandidates = allCandidates.filter(el => el.closest(responseContainerSelector));
        return (scopedCandidates.length ? scopedCandidates : allCandidates).length;
    }, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
    
    // Type and send
    await page.keyboard.type(promptText);
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
                     window.onResponseComplete();
                     resolve();
                }
            }, 200);
        });
    }, initialCount, RESPONSE_SELECTOR, RESPONSE_CONTAINER_SELECTOR);
    return streamPromise;
}

main().catch(err => console.error(err));
