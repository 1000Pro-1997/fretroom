#!/bin/bash
cd "$(dirname "$0")" || exit 1

if [ "$(uname -m)" = arm64 ]; then app="release/mac-arm64/fretroom.app"; else app="release/mac/fretroom.app"; fi

if [ ! -d "$app" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "The app is not built yet. Install Node.js from https://nodejs.org/ and run this file again."
    read -r -p "Press Enter to close."
    exit 1
  fi
  if [ ! -f node_modules/electron-builder/cli.js ]; then
    npm install || { echo "Could not build the app. Check the error above."; read -r -p "Press Enter to close."; exit 1; }
  fi
  npm run package:mac || { echo "Could not build the app. Check the error above."; read -r -p "Press Enter to close."; exit 1; }
fi

open "$app"
