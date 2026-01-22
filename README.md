# Gemini CLI Chatbot

A powerful command-line interface for interacting with Google's Gemini (formerly Bard) via a controlled Chromium browser instance.

## Features

- **Terminal-based Chat:** Full chat interface directly in your terminal.
- **Markdown Rendering:** Beautifully renders Markdown responses with syntax highlighting.
- **Persistent Session:** Uses a dedicated profile (`~/.config/chromium-chatbot`) to keep your session isolated and persistent.
- **Streaming Responses:** See the response type out in real-time, just like on the web.
- **Chat History & New Chat:** Access recent conversations or start a new one using the `/chats` command.
- **Tools:** 
    - **YouTube Transcripts:** Fetch video transcripts directly into the chat context using `#transcript <url>`.
    - **Local File Inclusion:** Use `@include "filename"` to paste file contents into your prompt.
- **Robustness:** 
    - Works over **SSH** (requires X11 forwarding or access to desktop display).
    - Prevents background throttling when the browser is minimized.
    - Handles browser crashes and reloads gracefully.

## Prerequisites

- Node.js (v14 or higher)
- Chromium or Google Chrome installed
- `lsof` (for port checking)
- `xdpyinfo` (for X server checking)
- `yt-dlp` (optional, for transcript fetching; script handles local fallback)

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

### Options

- `--gemini-fast`: Force selection of the Gemini Flash model.
- `--gemini-pro`: Force selection of the Gemini Pro/Advanced model.
- `--reload`: Force a complete restart of the browser process (useful if it freezes).

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

## SSH Usage

If running from SSH, you must ensure the script can access your desktop's X server (to launch the browser window on your remote screen) or use X11 forwarding.

- **Remote Screen:** `export DISPLAY=:0` (The script attempts to auto-detect this).
- **Forwarding:** Connect with `ssh -X user@host`.

## Troubleshooting

- **Login issues:** If you get "This browser may not be secure", close everything and run `./chatbot-login` again.
- **Transcript 429 Errors:** If fetching transcripts fails, the script automatically retries using browser cookies or different languages. Ensure `yt-dlp` is installed.

## License

MIT