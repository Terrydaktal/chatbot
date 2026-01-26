# Gemini CLI Chatbot

A command-line interface for interacting with Google Gemini and Google AI Mode (Search) via a controlled Chromium browser session.

## Features

- **Gemini + AI Mode:** Use Gemini by default or Google AI Mode (Search) with `--ai-mode`.
- **Terminal-first UI:** Full chat experience in the terminal with Markdown rendering and syntax highlighting.
- **Persistent Session:** Dedicated profile (`~/.config/chromium-chatbot`) keeps you logged in and isolated.
- **Fast Completion:** AI Mode finishes as soon as the UI footer appears and strips boilerplate text.
- **Background-Friendly:** Prevents background throttling; works minimized/hidden on X11.
- **Chat History & New Chat:** Switch chats or start a new one with `/chats`.
- **Tools:**
  - **YouTube Transcripts:** `#transcript <url>` pulls transcripts into your prompt.
  - **Local File Inclusion:** `@include "filename"` inlines file content.
- **Resilient Automation:** Handles reloads and recovers from stale sessions.

## Prerequisites

- Node.js (v18+ recommended)
- Chromium or Google Chrome installed
- `lsof` (port checking)
- `xdpyinfo` (X server checking)
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
- `--help`: Show CLI help.

### In-Chat Commands

- **Type your prompt:** Just type and press Enter to chat.
- **/chats:** Open the menu to switch chats or start a **+ New Chat**.
- **exit / quit:** Close the CLI.

### Tools Syntax

- **Transcripts:**
  ```text
  Summarize this video: #transcript https://youtube.com/watch?v=...
  ```
  - Default: Fetches English transcript (fast).
  - Flags:
    - `--all`: Fetch Title and Description metadata.
    - `--lang "code"`: Fetch specific language (e.g., `--lang "ru"`).
  
- **File Include:**
  ```text
  Refactor this code: @include "src/main.js"
  ```

## Advanced: AI Mode Script

There is a standalone script (`google-ai-mode.js`) for single-shot AI Mode queries and proxy/connection workflows.

```bash
node google-ai-mode.js --query "your question" --mode aimode
```

Use `--help` for all flags (connect to existing Chrome, reuse target, etc.).

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
