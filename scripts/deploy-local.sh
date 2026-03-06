#!/bin/bash
# Deploy the current build directly to the locally installed Windows app.
# Skips GitHub entirely — just builds webpack, replaces files, done.
# Usage: ./scripts/deploy-local.sh

set -e

APP_DIR="/mnt/c/Users/goduk/AppData/Local/Programs/Gymnastics Meet Scores"
RESOURCES="$APP_DIR/resources"
ASAR="$RESOURCES/app.asar"
TMPDIR="/tmp/chp-asar-$$"

if [ ! -f "$ASAR" ]; then
  echo "ERROR: Installed app not found at $APP_DIR"
  echo "Install the app from GitHub releases first."
  exit 1
fi

echo "=== Building webpack ==="
npm run build --silent 2>&1 | tail -3

echo "=== Extracting app.asar ==="
npx asar extract "$ASAR" "$TMPDIR"

echo "=== Replacing dist/ files ==="
rm -rf "$TMPDIR/dist"
cp -r dist "$TMPDIR/dist"

echo "=== Updating package.json version ==="
cp package.json "$TMPDIR/package.json"

echo "=== Repacking app.asar ==="
npx asar pack "$TMPDIR" "$ASAR"

echo "=== Updating skills/ ==="
rm -rf "$RESOURCES/skills"
mkdir -p "$RESOURCES/skills"
cp skills/*.md "$RESOURCES/skills/"
# Copy detail skills if they exist
if [ -d "skills/details" ]; then
  mkdir -p "$RESOURCES/skills/details"
  cp skills/details/*.md "$RESOURCES/skills/details/"
fi

echo "=== Updating python/ ==="
# Only copy .py files (leave .exe intact from the installer build)
find python -name "*.py" | while read f; do
  mkdir -p "$RESOURCES/$(dirname "$f")"
  cp "$f" "$RESOURCES/$f"
done

echo "=== Cleanup ==="
rm -rf "$TMPDIR"

echo ""
echo "Done! Close and reopen the app to see changes."
