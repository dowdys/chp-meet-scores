# Skill: Dev Launch (Windows)

## Overview
Launch the GMS app in dev mode on Windows for testing. Code lives in WSL, built files get synced to a Windows copy at `C:\Users\goduk\chp-meet-scores-dev\`.

## Steps

### 1. Build & Sync
```bash
cd /home/goduk/chp-meet-scores
npm run build
find python -name __pycache__ -exec rm -rf {} + 2>/dev/null
cp -r dist/ /mnt/c/Users/goduk/chp-meet-scores-dev/dist/
cp -r python/ /mnt/c/Users/goduk/chp-meet-scores-dev/python/
cp -r skills/ /mnt/c/Users/goduk/chp-meet-scores-dev/skills/
cp package.json /mnt/c/Users/goduk/chp-meet-scores-dev/package.json
```

Or use the shortcut: `bash sync-to-windows.sh`

### 2. Kill any existing instances
```bash
powershell.exe -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

### 3. Launch on Windows
```bash
powershell.exe -Command "Start-Process -FilePath 'C:\Users\goduk\chp-meet-scores-dev\node_modules\electron\dist\electron.exe' -ArgumentList 'C:\Users\goduk\chp-meet-scores-dev'"
```

**Important**: Do NOT use `npx electron .` — it opens Cursor IDE instead of Electron on this system.

### 4. Python in dev mode
In dev mode, Electron runs Python from source (`python/` directory) rather than a PyInstaller binary. Changes to `.py` files take effect after sync — no rebuild needed. But always clear `__pycache__` before syncing.

## One-time setup (already done)
- Windows Node.js v22 installed
- `C:\Users\goduk\chp-meet-scores-dev\` created with `npm install --ignore-scripts` + `npm install electron@28` + `npx @electron/rebuild -f -w better-sqlite3`
- If `node_modules` needs refreshing: repeat the one-time setup commands above
