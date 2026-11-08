#!/usr/bin/env bash
# ==============================================================================
# Reel Wrapped '25 — 1-Line macOS / Linux Localhost & Desktop Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.sh | bash
# ==============================================================================
set -e

echo "=========================================================="
echo " 🎬 REEL WRAPPED '25 • 100% LOCALHOST & DESKTOP LAUNCHER"
echo "=========================================================="

TARGET_DIR="${TMPDIR:-/tmp}/reel-wrapped-local"
rm -rf "$TARGET_DIR"

echo "⚡ Cloning prashanth-karanam/reel-wrapped..."
git clone --depth 1 https://github.com/prashanth-karanam/reel-wrapped.git "$TARGET_DIR"
cd "$TARGET_DIR"

if command -v npm >/dev/null 2>&1; then
  echo "📦 Node.js detected! Launching local server on http://localhost:3000..."
  npm install --no-audit --no-fund
  (sleep 2 && (open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null || true)) &
  npm run dev
elif command -v cargo >/dev/null 2>&1; then
  echo "🦀 Rust detected! Launching native Rust engine on http://127.0.0.1:8765..."
  cargo run --manifest-path rust-engine/Cargo.toml --release
else
  echo "🐍 Launching Python bridge on http://127.0.0.1:8765..."
  python3 app.py
fi
