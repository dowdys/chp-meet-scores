#!/bin/bash
# build-mac.sh - Build the Gymnastics Meet Scores DMG for macOS
#
# Prerequisites:
#   - Node.js 18+ (https://nodejs.org or `brew install node`)
#   - Python 3.10+ (https://python.org or `brew install python`)
#   - Google Chrome (required at runtime for web scraping)
#
# Usage:
#   Open Terminal, cd to the project directory, then run:
#     ./scripts/build-mac.sh

set -e

echo ""
echo "=== Gymnastics Meet Scores - macOS Build ==="

# --- Step 1: Check prerequisites ---
echo ""
echo "[1/8] Checking prerequisites..."

# Node.js
if command -v node &>/dev/null; then
    echo "  Node.js: $(node --version)"
else
    echo "  ERROR: Node.js not found. Install from https://nodejs.org or: brew install node"
    exit 1
fi

# Python
PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
    echo "  Python: $(python3 --version)"
elif command -v python &>/dev/null && python --version 2>&1 | grep -q "Python 3"; then
    PYTHON_CMD="python"
    echo "  Python: $(python --version)"
else
    echo "  ERROR: Python 3 not found. Install from https://python.org or: brew install python"
    exit 1
fi

# --- Step 2: Install Python dependencies ---
echo ""
echo "[2/8] Installing Python dependencies - PyInstaller, PyMuPDF..."
$PYTHON_CMD -m pip install --quiet pyinstaller pymupdf "qrcode[pil]"
echo "  Done"

# --- Step 3: Build process_meet with PyInstaller ---
echo ""
echo "[3/8] Building process_meet with PyInstaller..."
$PYTHON_CMD -m PyInstaller --onefile --name process_meet python/process_meet.py \
    --distpath dist/pyinstaller --workpath build/pyinstaller --specpath build/pyinstaller -y
echo "  Done"

# --- Step 4: Copy process_meet to python/ ---
echo ""
echo "[4/8] Copying process_meet to python/ directory..."
cp dist/pyinstaller/process_meet python/process_meet
chmod +x python/process_meet
echo "  Copied to python/process_meet ($(file python/process_meet | sed 's/.*: //'))"

# --- Step 5: npm install ---
echo ""
echo "[5/8] Installing Node.js dependencies..."
npm install
echo "  Done"

# --- Step 6: Webpack build ---
echo ""
echo "[6/8] Building app with Webpack..."
npm run build
echo "  Done"

# --- Step 7: Build DMG with electron-builder ---
echo ""
echo "[7/8] Building macOS DMG with electron-builder..."
npx electron-builder --mac --universal
echo "  Done"

# --- Step 8: Report ---
echo ""
echo "[8/8] Build complete!"
echo ""
echo "=== Output ==="

DMG_FILES=$(find release -name "*.dmg" 2>/dev/null)
if [ -n "$DMG_FILES" ]; then
    for f in $DMG_FILES; do
        SIZE=$(du -h "$f" | cut -f1)
        echo "  $(basename "$f") ($SIZE)"
        echo "  Path: $(pwd)/$f"
    done
else
    echo "  Check release/ directory for the DMG"
fi

echo ""
echo "Note: When built on a single-architecture Mac, the Python binary runs"
echo "natively on that architecture and under Rosetta 2 on the other."
echo "The GitHub Actions pipeline builds a true universal Python binary."
echo ""
echo "The app requires Google Chrome to be installed on the target machine."
echo ""
