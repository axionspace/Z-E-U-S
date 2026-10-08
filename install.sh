#!/usr/bin/env bash
# One-command installer for the hardened Zeus panel.
# Creates a zeus-wizard folder in the current directory, downloads wizard.mjs
# into it from this repository's mirrors, and runs it with Node.js.
# Usage:
#   bash <(curl -Ls https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/install.sh)
#   bash <(curl -Ls https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/install.sh) --token-link
# Requires Node.js 18+ (https://nodejs.org). Works on Linux, macOS, and Git Bash.
set -eu

INSTALL_DIR='zeus-wizard'
WIZARD='wizard.mjs'

SOURCES='
https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard.mjs
https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard.mjs
https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard.mjs
https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard.mjs
'

fail() { printf '\n%s\n\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 \
  || fail 'Node.js is required but was not found. Install Node.js 18+ from https://nodejs.org, then run this command again.'
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' \
  || fail "Node.js 18 or newer is required (found $(node --version)). Install it from https://nodejs.org."

mkdir -p "$INSTALL_DIR"
TMP="$INSTALL_DIR/$WIZARD"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 20 "$1" -o "$TMP"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=20 -O "$TMP" "$1"
  else
    fail 'Neither curl nor wget was found on this system.'
  fi
}

printf 'Downloading %s...\n' "$WIZARD"
for SRC in $SOURCES; do
  if download "$SRC" && [ -s "$TMP" ]; then
    printf 'Starting the wizard (saved to %s/%s for future runs).\n\n' "$INSTALL_DIR" "$WIZARD"
    cd "$INSTALL_DIR"
    exec node "$WIZARD" "$@"
  fi
done

fail 'Could not download wizard.mjs from any mirror. Check your connection (a VPN may help) and try again.'
