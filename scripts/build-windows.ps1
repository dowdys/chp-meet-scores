# build-windows.ps1 - Build the Gymnastics Meet Scores installer for Windows
#
# Prerequisites:
#   - Node.js 18+ (https://nodejs.org)
#   - Python 3.10+ (https://python.org) - check "Add to PATH" during install
#   - Google Chrome (required at runtime for web scraping)
#
# Usage:
#   Open PowerShell, cd to the project directory, then run:
#     .\scripts\build-windows.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Gymnastics Meet Scores - Windows Build ===" -ForegroundColor Cyan

# --- Step 1: Check prerequisites ---
Write-Host ""
Write-Host "[1/8] Checking prerequisites..." -ForegroundColor Yellow

# Node.js
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Python
$pythonCmd = $null
try {
    $pyVersion = & python --version 2>&1
    if ($pyVersion -match "Python 3") {
        $pythonCmd = "python"
        Write-Host "  Python: $pyVersion" -ForegroundColor Green
    }
} catch {}
if (-not $pythonCmd) {
    try {
        $pyVersion = & python3 --version 2>&1
        $pythonCmd = "python3"
        Write-Host "  Python: $pyVersion" -ForegroundColor Green
    } catch {
        Write-Host "  ERROR: Python 3 not found. Install from https://python.org" -ForegroundColor Red
        exit 1
    }
}

# --- Step 2: Install Python dependencies ---
Write-Host ""
Write-Host "[2/8] Installing Python dependencies - PyInstaller, PyMuPDF..." -ForegroundColor Yellow
& $pythonCmd -m pip install --quiet pyinstaller pymupdf
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: pip install failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done" -ForegroundColor Green

# --- Step 3: Build process_meet.exe with PyInstaller ---
Write-Host ""
Write-Host "[3/8] Building process_meet.exe with PyInstaller..." -ForegroundColor Yellow
& $pythonCmd -m PyInstaller --onefile --name process_meet python/process_meet.py --distpath dist/pyinstaller --workpath build/pyinstaller --specpath build/pyinstaller -y
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: PyInstaller build failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done" -ForegroundColor Green

# --- Step 4: Copy process_meet.exe to python/ ---
Write-Host ""
Write-Host "[4/8] Copying process_meet.exe to python/ directory..." -ForegroundColor Yellow
Copy-Item -Path "dist/pyinstaller/process_meet.exe" -Destination "python/process_meet.exe" -Force
Write-Host "  Copied to python/process_meet.exe" -ForegroundColor Green

# --- Step 5: npm install ---
Write-Host ""
Write-Host "[5/8] Installing Node.js dependencies..." -ForegroundColor Yellow
& npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm install failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done" -ForegroundColor Green

# --- Step 6: Webpack build ---
Write-Host ""
Write-Host "[6/8] Building app with Webpack..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Webpack build failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done" -ForegroundColor Green

# --- Step 7: Build installer with electron-builder ---
Write-Host ""
Write-Host "[7/8] Building Windows installer with electron-builder..." -ForegroundColor Yellow
& npx electron-builder --win --x64
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: electron-builder failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done" -ForegroundColor Green

# --- Step 8: Report ---
Write-Host ""
Write-Host "[8/8] Build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "=== Output ===" -ForegroundColor Cyan

$installerFiles = Get-ChildItem -Path "release" -Filter "*.exe" -ErrorAction SilentlyContinue
if ($installerFiles) {
    foreach ($file in $installerFiles) {
        $sizeInMB = [math]::Round($file.Length / 1048576, 1)
        $msg = "  " + $file.Name + " (" + $sizeInMB + " MB)"
        Write-Host $msg -ForegroundColor White
        $pathMsg = "  Path: " + $file.FullName
        Write-Host $pathMsg -ForegroundColor Gray
    }
} else {
    Write-Host "  Check release/ directory for the installer" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "The installer requires Google Chrome to be installed on the target machine." -ForegroundColor Yellow
Write-Host ""
