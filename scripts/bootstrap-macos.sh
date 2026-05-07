#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a fresh macOS dev VM for A0 Launcher.
# Intended for ephemeral machines where you want a repeatable "clone -> run/build -> test" flow.
#
# What it does:
# - Verifies Xcode Command Line Tools are installed (required for many build tools)
# - Installs Homebrew if missing
# - Installs Node.js 20 via Homebrew
# - Runs `npm ci`
# - Builds an unsigned mac app (SKIP_SIGNING=1) or runs dev mode
#
# Usage (from repo root):
#   ./scripts/bootstrap-macos.sh dev
#   ./scripts/bootstrap-macos.sh build
#
# Notes:
# - This script may prompt for sudo/password when installing Homebrew or packages.
# - For fastest "just test the app" on ephemeral Macs, prefer downloading macOS
#   artifacts from your fork's GitHub Actions (see README).

MODE="${1:-}"
if [[ "$MODE" != "dev" && "$MODE" != "build" ]]; then
  echo "Usage: $0 dev|build" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script must run on macOS (Darwin)." >&2
  exit 1
fi

if [[ ! -f "package.json" || ! -d "shell" ]]; then
  echo "ERROR: Run this from the repo root (package.json + shell/ expected)." >&2
  exit 1
fi

echo "[bootstrap] Checking Xcode Command Line Tools..."
if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: Xcode Command Line Tools not installed." >&2
  echo "Run: xcode-select --install" >&2
  echo "Then re-run this script." >&2
  exit 1
fi

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi

  echo "[bootstrap] Installing Homebrew (non-interactive)..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Shellenv for common locations (Apple Silicon + Intel)
  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: brew not found after install. Open a new terminal and try again." >&2
    exit 1
  fi
}

install_node20() {
  echo "[bootstrap] Ensuring Node.js 20 is installed..."
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v || true)"
    if [[ "$v" =~ ^v20\. ]]; then
      echo "[bootstrap] Node already installed: $v"
      return 0
    fi
  fi

  brew update
  brew install node@20

  # Ensure node@20 is on PATH for this shell session
  if [[ -d "$(brew --prefix node@20)/bin" ]]; then
    export PATH="$(brew --prefix node@20)/bin:$PATH"
  fi

  echo "[bootstrap] Node version: $(node -v)"
  echo "[bootstrap] npm version: $(npm -v)"
}

ensure_brew
install_node20

echo "[bootstrap] Installing dependencies (npm ci)..."
npm ci

if [[ "$MODE" == "dev" ]]; then
  echo "[bootstrap] Starting dev mode..."
  npm start
else
  echo "[bootstrap] Building unsigned mac artifacts (SKIP_SIGNING=1)..."
  SKIP_SIGNING=1 npm run make:mac
  echo "[bootstrap] Build complete. Check ./out/ for artifacts."
fi
