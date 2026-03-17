#!/bin/bash
# Build, sync to Windows, and launch the app in dev mode
# Usage: bash sync-to-windows.sh

WIN_DEV="/mnt/c/Users/goduk/chp-meet-scores-dev"

echo "Building..."
cd /home/goduk/chp-meet-scores
npm run build 2>&1 | tail -3

echo "Clearing Python cache..."
find python -name __pycache__ -exec rm -rf {} + 2>/dev/null

echo "Syncing to Windows..."
rsync -a --delete dist/ "$WIN_DEV/dist/"
rsync -a --delete python/ "$WIN_DEV/python/"
rsync -a --delete skills/ "$WIN_DEV/skills/"
cp -f package.json "$WIN_DEV/package.json"

echo "Killing old instances..."
powershell.exe -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null
sleep 1

echo "Launching on Windows..."
powershell.exe -Command "Start-Process -FilePath 'C:\Users\goduk\chp-meet-scores-dev\node_modules\electron\dist\electron.exe' -ArgumentList 'C:\Users\goduk\chp-meet-scores-dev'"

echo "App launched!"
