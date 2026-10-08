#!/usr/bin/env bash
# One-command installer for the hardened Zeus panel.
# Downloads wizard.mjs from this repository's mirrors and runs it with Node.js.
# Usage:
#   bash <(curl -Ls https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/install.sh)
#   bash <(curl -Ls https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/install.sh) --token-link
# Requires Node.js 18+ (https://nodejs.org). Works on Linux, macOS, and Git Bash.
set -eu

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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/zeus-wizard.XXXXXX")" || fail 'mktemp failed.'
trap 'rm -rf "$WORK"' EXIT
TMP="$WORK/wizard.mjs"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 20 "$1" -o "$TMP"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=20 -O "$TMP" "$1"
  else
    fail 'Neither curl nor wget was found on this system.'
  fi
}

for SRC in $SOURCES; do
  if download "$SRC" && [ -s "$TMP" ]; then
    set +e
    node "$TMP" "$@"
    exit $?
  fi
done

fail 'Could not download wizard.mjs from any mirror. Check your connection (a VPN may help) and try again.'
