#!/bin/bash
# run-chatbot.sh - Helper to launch Chromium securely and start the chatbot

CHROMIUM_BIN="/bin/chromium"
PORT="${PORT:-9233}"

# Check if port is already in use
if ! lsof -i:$PORT > /dev/null; then
    echo "Launching Chromium with your MAIN profile on port $PORT..."
    echo "IMPORTANT: Please close any other Chromium windows before running this."
    
    # Launching without --user-data-dir uses your default main profile
    # Flags prevent background throttling when the window is minimized/occluded.
    # Use setsid to run in a new session, completely detaching from the terminal's process group.
    setsid $CHROMIUM_BIN \
        --remote-debugging-port=$PORT \
        --no-first-run \
        --no-default-browser-check \
        --disable-background-timer-throttling \
        --disable-renderer-backgrounding \
        --disable-backgrounding-occluded-windows \
        --disable-features=CalculateNativeWinOcclusion \
        > /dev/null 2>&1 &
    
    echo "Waiting for Chromium to initialize..."
    sleep 2
else
    echo "Chromium is already running on port $PORT."
fi

echo "Starting Chatbot..."
./chatbot.js --gemini-flash --port $PORT
