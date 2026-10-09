#!/usr/bin/env bash
# One-command installer for the hardened Zeus panel.
# Creates a zeus-wizard folder in the current directory, downloads wizard.mjs into it
# from this repository's mirrors, and runs it. Nothing needs to be installed first: if
# Node.js 18+ is missing, a private copy of the Node runtime is downloaded into the same
# folder (system Node is never touched, and the folder can simply be deleted again).
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh)
#   bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh) --token-link
#   bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh) --update
# Environment switches:
#   ZEUS_SKIP_AUTO_RUNTIME=1    never download a runtime; require Node.js 18+ on PATH
#   ZEUS_NODE_VERSION=v24.11.0  pin a different Node.js runtime build
#   ZEUS_NODE_BIN=/path/to/node use this node binary instead of looking one up
# Works on Linux, macOS, WSL and Git Bash.
set -eu

INSTALL_DIR='zeus-wizard'
WIZARD='wizard.mjs'
NODE_VERSION="${ZEUS_NODE_VERSION:-v24.11.0}"
RUNTIME_DIR="$INSTALL_DIR/runtime"
PKG=''; EXTRACT=''; NODE_BIN=''

fail() { printf '\n%s\n\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || have wget || fail 'Neither curl nor wget was found on this system.'

# Every file is fetched from several independent providers, in order, so one filtered
# or failing route never blocks the install.
SOURCES='
https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs
https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs
https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs
https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs
https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/wizard/wizard.mjs
https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs
'

node_is_good() {
  [ -n "${1:-}" ] && "$1" -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' >/dev/null 2>&1
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -b1-64
  elif have shasum; then shasum -a 256 "$1" | cut -b1-64
  else printf ''
  fi
}

fetch() { # fetch <url> <file>
  if have curl; then curl -fsSL --connect-timeout 20 "$1" -o "$2"
  else wget -q --timeout=20 -O "$2" "$1"
  fi
}

detect_target() {
  OS=$(uname -s 2>/dev/null || echo unknown)
  RAWARCH=$(uname -m 2>/dev/null || echo unknown)
  case "$RAWARCH" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    armv7l) ARCH=armv7l ;;
    *) ARCH="$RAWARCH" ;;
  esac
  case "$OS" in
    Linux)
      LIBC=''
      if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] || ldd --version 2>&1 | grep -qi musl; then
        if [ "$ARCH" = x64 ]; then LIBC='-musl'; fi
      fi
      PKG="node-$NODE_VERSION-linux-$ARCH$LIBC.tar.gz"
      EXTRACT='tar'
      NODE_BIN="$RUNTIME_DIR/node-$NODE_VERSION-linux-$ARCH$LIBC/bin/node"
      ;;
    Darwin)
      PKG="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
      EXTRACT='tar'
      NODE_BIN="$RUNTIME_DIR/node-$NODE_VERSION-darwin-$ARCH/bin/node"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      PKG="node-$NODE_VERSION-win-x64.zip"
      EXTRACT='zip'
      NODE_BIN="$RUNTIME_DIR/node-$NODE_VERSION-win-x64/node.exe"
      ;;
    *)
      fail "Unsupported system: $OS $RAWARCH. Install Node.js 18+ and run: node $WIZARD" ;;
  esac
}

runtime_mirrors() {
  case "$PKG" in
    *musl*) printf '%s\n' "https://unofficial-builds.nodejs.org/download/release/$NODE_VERSION" ;;
  esac
  printf '%s\n' \
    "https://nodejs.org/dist/$NODE_VERSION" \
    "https://cdn.npmmirror.com/binaries/node/$NODE_VERSION" \
    "https://registry.npmmirror.com/-/binary/node/$NODE_VERSION" \
    "https://mirror.nju.edu.cn/nodejs-release/$NODE_VERSION" \
    "https://mirrors.huaweicloud.com/nodejs/$NODE_VERSION"
}

provision_runtime() {
  detect_target
  mkdir -p "$RUNTIME_DIR"
  if [ -x "$NODE_BIN" ] && node_is_good "$NODE_BIN"; then
    rm -f "$RUNTIME_DIR"/*.tar.gz "$RUNTIME_DIR"/*.zip "$RUNTIME_DIR/SHASUMS256.txt" 2>/dev/null || true
    say "Reusing the runtime already stored in $RUNTIME_DIR."
    return 0
  fi
  say "Node.js is fetched into $RUNTIME_DIR as $PKG"
  say '(about 30 MB, one time only, verified by checksum; nothing is installed system-wide)'
  ARCHIVE="$RUNTIME_DIR/$PKG"
  for BASE in $(runtime_mirrors); do
    say "  trying $BASE"
    fetch "$BASE/SHASUMS256.txt" "$RUNTIME_DIR/SHASUMS256.txt" || continue
    WANT=$(awk -v f="$PKG" '$2 == f { print $1 }' "$RUNTIME_DIR/SHASUMS256.txt" | head -n 1)
    [ -n "$WANT" ] || { say '  this mirror does not carry that build'; continue; }
    fetch "$BASE/$PKG" "$ARCHIVE" || continue
    [ -s "$ARCHIVE" ] || continue
    GOT=$(sha256_of "$ARCHIVE")
    if [ -z "$GOT" ]; then
      say '  no sha256 tool found - accepting this download unverified'
    elif [ "$GOT" != "$WANT" ]; then
      say "  checksum mismatch ($GOT), trying the next mirror"
      rm -f "$ARCHIVE"
      continue
    fi
    if [ "$EXTRACT" = tar ]; then
      tar -xzf "$ARCHIVE" -C "$RUNTIME_DIR" || { rm -f "$ARCHIVE"; continue; }
    else
      if have unzip; then unzip -q -o "$ARCHIVE" -d "$RUNTIME_DIR" || { rm -f "$ARCHIVE"; continue; }
      else tar -xf "$ARCHIVE" -C "$RUNTIME_DIR" || { rm -f "$ARCHIVE"; continue; }
      fi
    fi
    rm -f "$ARCHIVE" "$RUNTIME_DIR/SHASUMS256.txt"
    [ -f "$NODE_BIN" ] && chmod +x "$NODE_BIN" 2>/dev/null || true
    if node_is_good "$NODE_BIN"; then
      say "Runtime ready: $NODE_BIN"
      return 0
    fi
    say '  extracted, but that runtime did not start - trying the next mirror'
  done
  return 1
}

mkdir -p "$INSTALL_DIR"
# absolute paths: the wizard is started from inside the install folder
INSTALL_DIR="$PWD/$INSTALL_DIR"
RUNTIME_DIR="$INSTALL_DIR/runtime"
TMP="$INSTALL_DIR/$WIZARD"
NODE_BIN=""

# ---- runtime: explicit override, system Node, cached private runtime, then download
NODE=''
if [ -n "${ZEUS_NODE_BIN:-}" ] && node_is_good "$ZEUS_NODE_BIN"; then
  NODE="$ZEUS_NODE_BIN"
  say "Using Node.js from ZEUS_NODE_BIN."
elif have node && node_is_good node; then
  NODE=node
  say "Using Node.js $(node --version) from your system."
elif [ "${ZEUS_SKIP_AUTO_RUNTIME:-0}" = "1" ]; then
  fail 'Node.js 18+ is required and ZEUS_SKIP_AUTO_RUNTIME=1 was set. Install Node.js 18+ from https://nodejs.org and run this command again.'
else
  say 'Node.js 18+ was not found on this system - fetching a private copy for it.'
  provision_runtime || fail 'Could not download a Node.js runtime from any mirror.
Options:
  1. Install Node.js 18+ from https://nodejs.org and re-run this command.
  2. Put a node binary in '"$RUNTIME_DIR"' (or set ZEUS_NODE_BIN) and re-run.
  3. Clone this repository and run: node wizard/wizard.mjs'
  NODE="$NODE_BIN"
fi

# ---- wizard script
say "Downloading $WIZARD..."
for SRC in $SOURCES; do
  if fetch "$SRC" "$TMP" && [ -s "$TMP" ]; then
    say "Starting the wizard (script kept in $INSTALL_DIR/$WIZARD for later runs)."
    printf '\n'
    cd "$INSTALL_DIR"
    exec "$NODE" "$WIZARD" "$@"
  fi
done

fail 'Could not download wizard.mjs from any mirror. Check your connection (a VPN may help) and try again.'
