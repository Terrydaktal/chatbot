# Gemini CLI Chatbot

A command-line interface for interacting with Google Gemini and Google AI Mode (Search) via a controlled Chromium browser session.

## Features

- **Gemini + AI Mode:** Use Gemini by default or Google AI Mode (Search) with `--ai-mode`.
- **Terminal-first UI:** Full chat experience in the terminal with Markdown rendering and syntax highlighting.
- **Smooth Typing:** Optimized rendering engine eliminates flicker and handles long input wrapping correctly.
- **Persistent Session:** Dedicated profile (`~/.config/chromium-chatbot`) keeps you logged in and isolated.
- **Fast Completion:** AI Mode finishes as soon as the UI footer appears and strips boilerplate text.
- **Background-Friendly:** Prevents background throttling; works minimized/hidden on X11.
- **Chat History & New Chat:** Switch chats or start a new one with `/chats`.
- **Tools:**
  - **YouTube Transcripts:** `#transcript <url>` pulls transcripts into your prompt.
  - **PDF to Text:** `#pdf <url_or_path>` downloads or reads a PDF and inlines its text into your prompt.
  - **Local File Inclusion:** `@include "filename"` inlines file content.
  - **One-Sentence Mode:** `~ <prompt>` requests a concise, one-sentence response.
- **Resilient Automation:** Handles reloads and recovers from stale sessions.
- **Telegram Bridge:** Optional bot that triggers on `@username` mentions, supports per-chat model/chat control, and can inject forwarded context with `[[include]]`.

## Prerequisites

- Node.js (v18+ recommended)
- Chromium or Google Chrome installed
- `lsof` (port checking)
- `xdpyinfo` (X server checking)
- `xvfb-run` (optional; for `--virtual`)
- `yt-dlp` (optional; for transcript fetching)

## Installation

1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```

## Setup & Login

This tool uses a dedicated browser profile to avoid interfering with your main browser. You must log in once manually.

1. Run the login helper script:
   ```bash
   ./chatbot-login
   ```
2. Log in to your Google account in the browser window that opens.
3. Close the browser window.
4. You are now ready to use the main chatbot.

## Usage

### Starting the Chatbot

Use the provided helper script to launch the chatbot.

```bash
./chatbot
```

Start in AI Mode (Google Search AI):

```bash
./chatbot --ai-mode
```

### Options

- `--ai-mode`: Use Google AI Mode (Search) instead of Gemini.
- `--gemini-fast`: Force selection of the Gemini Flash model.
- `--gemini-pro`: Force selection of the Gemini Pro/Advanced model.
- `--gemini-flash`: Alias for `--gemini-fast`.
- `--temp`: Use a temporary browser profile (no persistence).
- `--port <number>`: Connect to an existing Chrome/Chromium remote-debugging port.
- `--reload`: Force a complete restart of the browser process (useful if it freezes).
- `--virtual`: Launch Chromium in a virtual X display (best with `--reload`).
- `--help`: Show CLI help.

### In-Chat Commands

- **Type your prompt:** Just type and press Enter to chat.
- **/chats:** Open the menu to switch chats or start a **+ New Chat**.
- **/tools:** Display a list of all available expansion tools (#pdf, #transcript, etc).
- **/models:** Display current model or switch between `ai`, `fast`, or `pro`.
- **/mode:** Toggle response mode between `verbose` and `concise` (`/mode concise`, `/mode verbose`, `/mode toggle`). In `concise`, prompts are auto-prefixed with `~`.
- **/questions:** Browse questions in the current chat (arrow keys + Enter, newest first) and reprint the AI response.
- **/summarise** (or **/summarize**): Copy the current chat into a new Gemini Flash (fast) chat and ask it to summarise the conversation in a token-efficient way (keeps Fast selected if already on Fast).
- **/commands:** Display a list of all available CLI commands.
- **exit / quit:** Close the CLI.

### Keyboard Shortcuts

- **Navigation:**
  - `Left` / `Right`: Move cursor character by character.
  - `Ctrl + Left` / `Ctrl + Right`: Move cursor word by word.
  - `Up` / `Down`: Navigate command history.
- **Editing:**
  - `Backspace`: Delete character.
  - `Ctrl + Backspace` / `Ctrl + W`: Delete word.
  - `Alt + Backspace`: Delete word.
  - `Ctrl + U`: Clear line.

### Tools Syntax

- **Transcripts:**
  ```text
  Summarize this video: #transcript https://youtube.com/watch?v=...
  ```
  - Default: Fetches English transcript (fast).
  - Flags:
    - `--all`: Fetch Title and Description metadata.
    - `--lang "code"`: Fetch specific language (e.g., `--lang "ru"`).

- **PDF Conversion:**
  ```text
  Analyze this document: #pdf https://example.com/document.pdf
  Or local file: #pdf /path/to/local.pdf
  ```
  
- **File Include:**
  ```text
  Refactor this code: @include "src/main.js"
  ```

- **One-Sentence Mode:**
  ```text
  ~What is the capital of France?
  ```

## Advanced: AI Mode Script

There is a standalone script (`google-ai-mode.js`) for single-shot AI Mode queries and proxy/connection workflows.

```bash
node google-ai-mode.js --query "your question" --mode aimode
```

Use `--help` for all flags (connect to existing Chrome, reuse target, etc.).

## Telegram Bot Bridge

`telegram-bot.js` lets Telegram messages drive the same Chromium/Gemini browser session.

### Behavior

- Trigger rule: the message must contain `@TELEGRAM_TRIGGER_USERNAME`.
- Replies without a tag do not trigger.
- Forwarded messages sent to the bot in private chat are staging input only (they do not trigger prompts).
- The bot replies to the triggering message (`reply_to_message_id`), so responses stay threaded.
- Switching chats does not dump prior AI chat content into Telegram.
- On startup, the bot registers command menu entries via `setMyCommands` (default/private/group scopes).

#### Commands

- `/help`: show Telegram bot usage and trigger rules.
- `/whoami`: show your Telegram `user_id`, username, and chat ID.
- `/model`: show current model and available models.
- `/model aimode`: set model to **AI Mode**.
- `/model geminifast`: set model to **Gemini Fast (3.0 Flash)**.
- `/model geminithinking`: set model to **Gemini Thinking (3.0 Flash Thinking)**.
- `/model none`: disable prompt responses for that Telegram chat.
- `/newchat`: start a fresh chat in the current model.
- `/chat`: list recent chats in the current model and show the currently selected chat.
- `/chat <number>`: switch to a chat from the latest `/chat` list.

#### Model aliases

- `aimode`: `ai`, `ai-mode`
- `geminifast`: `fast`, `flash`, `gemini`
- `geminithinking`: `thinking`, `think`, `geminipro`, `pro`, `advanced`
- `none`: `off`, `silent`

#### Per-chat startup state

- New Telegram chats default to model `aimode`.
- Chat selection starts in `auto new chat pending`.
- The first prompt (or `/model` change away from `none`) auto-starts a new browser chat.

#### Include forwarded context (`[[include]]`)

- Send forwarded messages to your private chat with the bot first.
- Then send a tagged prompt with `[[include]]` in the destination group/chat.
- The bot will consume forwarded staging messages from the last 5 minutes, prepend them as context, and delete consumed staging messages from private chat.
- Include prompt format sent to AI:
  - `Forwarded messages:`
  - `<sender>: <message>`
  - `Analyze the included messages.` (unless you provided your own trailing prompt text)
- Forwarded images are downloaded and uploaded into the AI chat when uploader support is available.
- Max included images per request: `8`.

#### Limits and formatting

- Prompt payload (including injected include context) is capped at `8192` characters.
- Name mapping (if configured) is applied before send and reversed on AI output.
- Telegram output uses HTML formatting mode where possible.

### Environment Variables

- `TELEGRAM_BOT_TOKEN` (required): Bot token from BotFather.
- `TELEGRAM_TRIGGER_USERNAME` (required in practice): Mention trigger username without `@`.
- `BROWSER_PORT` (optional, default `9233`): Chromium remote debugging port.
- `GEMINI_URL` (optional): Override Gemini URL.
- `AI_MODE_URL` (optional): Override AI Mode URL.
- `TELEGRAM_POLL_TIMEOUT_SECONDS` (optional, default `30`): Telegram long-poll timeout.
- `TELEGRAM_ALLOWED_CHAT_IDS` (optional): Comma-separated allowlist of chat IDs.
- `TELEGRAM_ALLOWED_USER_IDS` (optional): Comma-separated allowlist of Telegram numeric user IDs. If set, only those users can interact with the bot.
- `TELEGRAM_NAME_MAP_TSV` (optional): Path to TSV name mapping file (default: `$XDG_CONFIG_HOME/chatbot/name-map.tsv` or `~/.config/chatbot/name-map.tsv`).

### Run

1. Start Chromium/Gemini as usual (for example with `./chatbot --reload --virtual`).
2. Start the Telegram bridge:
   ```bash
   TELEGRAM_BOT_TOKEN=... TELEGRAM_TRIGGER_USERNAME=yourtag npm run telegram-bot
   ```

## SSH Usage

If running from SSH, ensure the script can access your desktop's X server (to launch the browser window on your remote screen) or use X11 forwarding.

- **Remote Screen:** `export DISPLAY=:0` (The script attempts to auto-detect this).
- **Forwarding:** Connect with `ssh -X user@host`.

## Troubleshooting

- **Login issues:** If you get "This browser may not be secure", close everything and run `./chatbot-login` again.
- **Transcript 429 Errors:** If fetching transcripts fails, the script automatically retries using browser cookies or different languages. Ensure `yt-dlp` is installed.
- **AI Mode not sending:** Try `--reload` to restart the browser or make sure the window is not blocked by a modal.

## License

MIT
