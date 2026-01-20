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
marked.setOptions({
  renderer: new TerminalRenderer({
    width: process.stdout.columns || 80,
    reflowText: true,
    showSectionPrefix: false,
    tab: 4, // More indentation
    heading: chalk.bold.blue, // Blue bold headers
    firstHeading: chalk.bold.blue.underline,
    strong: chalk.bold.white,
    em: chalk.italic,
    blockquote: chalk.gray.italic,
    code: chalk.yellow, // Inline code color
    listitem: (text) => '  • ' + text, // Better bullet points
  }),
  highlight: (code, lang) => {
    if (highlight.getLanguage(lang)) {
      return highlight.highlight(code, { language: lang }).value;
    }
    return highlight.highlightAuto(code).value;
  }
});

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
      await page.goto(GEMINI_URL);
  } else {
    console.log(chalk.green('Found existing Gemini tab. Switching to it...'));
    await page.bringToFront();
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

    console.log(chalk.yellow('\nGemini is typing...'));
    
    await streamResponse(page, initialCount);

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

    function typeNextChar() {
        if (charQueue.length === 0) {
            isTyping = false;
            // Check if we are done
            if (responseCompleteTriggered) {
                // Done! Just print a newline separation
                process.stdout.write('\n\n'); 
                
                // Render beautiful Markdown
                try {
                    console.log(marked(fullText));
                } catch(e) {
                    console.log(fullText);
                }
                resolveStream();
            }
            return;
        }

        isTyping = true;
        const char = charQueue.shift();
        fullText += char;
        
        // --- Direct Output ---
        process.stdout.write(char);

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
            function process(child) {
                if (child.nodeType === 3) { md += child.textContent; return; }
                if (child.nodeType !== 1) return;
                const tag = child.tagName.toLowerCase();
                const isCodeBlock = tag === 'code-block' || child.classList.contains('code-block');
                const isPre = tag === 'pre';
                if (isCodeBlock || isPre) {
                    let lang = '';
                    if (isCodeBlock) {
                        const langEl = child.querySelector('.code-block-decoration span, .header-formatted span');
                        if (langEl) lang = langEl.innerText.trim().toLowerCase();
                    }
                    const codeEl = isPre ? child : child.querySelector('code, pre');
                    if (codeEl) {
                        let codeText = codeEl.innerText;
                        codeText = codeText.replace(/^```/gm, '').replace(/```$/gm, '');
                        md += '\n```' + lang + '\n' + codeText + '\n```\n';
                        return;
                    }
                }
                if (tag === 'p') md += '\n\n';
                if (tag === 'li') md += '\n* ';
                if (tag === 'h1' || tag === 'h2') md += '\n## ';
                child.childNodes.forEach(c => process(c));
            }
            node.childNodes.forEach(child => process(child));
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
