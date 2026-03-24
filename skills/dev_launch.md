# Skill: Dev Launch (Windows)

## Overview
Launch the GMS app in dev mode on Windows for testing. Code lives in WSL, built files get synced to a Windows copy at `C:\Users\goduk\chp-meet-scores-dev\`.

## Steps

### 1. Build & Sync
**ALWAYS use the sync script** — never use `cp -r` manually. `cp -r` silently fails to overwrite Python files on the WSL→Windows mount due to file locking/caching. The script uses `rsync` which handles this correctly.

```bash
bash sync-to-windows.sh
```

This builds, clears Python cache, syncs via rsync, kills old instances, and launches. It is the ONLY reliable way to deploy changes.

### 2. Kill any existing instances
```bash
powershell.exe -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

### 3. Launch on Windows
```bash
powershell.exe -Command "Start-Process -FilePath 'C:\Users\goduk\chp-meet-scores-dev\node_modules\electron\dist\electron.exe' -ArgumentList 'C:\Users\goduk\chp-meet-scores-dev'"
```

**Important**: Do NOT use `npx electron .` — it opens Cursor IDE instead of Electron on this system.

### Troubleshooting: WSL interop broken (`cannot execute binary file: Exec format error`)

If `powershell.exe` fails with "cannot execute binary file: Exec format error", the WSL binfmt_misc interop registration has gone missing. This happens occasionally in long-running WSL sessions.

**Diagnosis**: Check if `/proc/sys/fs/binfmt_misc/WSLInterop` exists. If not, the registration is missing.

**Fix** — re-register via `/init` (the WSL interop broker, which still works even when binfmt is broken):

```bash
# Step 1: Write a fix script
cat > /tmp/fix-interop.sh << 'EOF'
echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register
echo "done"
EOF

# Step 2: Run it as root via cmd.exe → wsl.exe chain
/init /mnt/c/Windows/System32/cmd.exe /C "C:\Windows\System32\wsl.exe --user root bash /tmp/fix-interop.sh"

# Step 3: Verify
powershell.exe -Command "echo interop_fixed"
```

**Key insight**: Even when `powershell.exe` can't be called directly, `/init` can still broker Windows executables. Use `/init /mnt/c/Windows/System32/cmd.exe /C "..."` as a fallback to run any Windows command, including `wsl.exe --user root` to get elevated access for the fix.

**Workaround** (if fix doesn't work): Launch from a Windows terminal directly:
```
C:\Users\goduk\chp-meet-scores-dev\node_modules\electron\dist\electron.exe C:\Users\goduk\chp-meet-scores-dev
```

### 4. Python in dev mode
In dev mode, Electron runs Python from source (`python/` directory) rather than a PyInstaller binary. Changes to `.py` files take effect after sync — no rebuild needed. But always clear `__pycache__` before syncing.

## One-time setup (already done)
- Windows Node.js v22 installed
- `C:\Users\goduk\chp-meet-scores-dev\` created with `npm install --ignore-scripts` + `npm install electron@28` + `npx @electron/rebuild -f -w better-sqlite3`
- If `node_modules` needs refreshing: repeat the one-time setup commands above
