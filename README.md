# Gemini CLI Chatbot

A powerful command-line interface for interacting with Google's Gemini (formerly Bard) via a controlled Chromium browser instance.

## Features

- **Terminal-based Chat:** Full chat interface directly in your terminal.
- **Markdown Rendering:** Beautifully renders Markdown responses with syntax highlighting.
- **Persistent Session:** Reuses your browser login session so you don't have to log in every time.
- **Streaming Responses:** See the response type out in real-time, just like on the web.
- **Chat History:** Access and continue your recent conversations (`/chats` command).
- **Gemini Flash Support:** Automatically selects the faster "Flash" model if available.
- **Background Running:** Keeps the browser window open and active even when minimized or detached.

## Prerequisites

- Node.js (v14 or higher)
- Chromium or Google Chrome installed
- `lsof` (for port checking)

## Installation

1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Starting the Chatbot

Use the provided helper script to launch the chatbot. This handles the browser process isolation and ensures the window stays open.

```bash
./run-chatbot.sh
```

**Note:** This will launch a Chromium window. You need to log in to your Google account in this window the first time you run it.

### Commands

- **Type your prompt:** Just type and press Enter to chat.
- **/chats:** Open the menu to select from recent chat history.
- **exit / quit:** Close the CLI (the browser window will remain open for quick reconnection).

## Configuration

- The script uses port `9233` for remote debugging by default. You can change this in `run-chatbot.sh`.
- Session data is stored in `.browser-session`.

## Troubleshooting

- **Browser closes on Ctrl+C:** The script now uses `setsid` to detach the browser. Ensure you are using `./run-chatbot.sh`.
- **Text stops appearing when minimized:** We have enabled background flags to prevent throttling. If this persists, try keeping the window partially visible or on a separate workspace.

## License

MIT
