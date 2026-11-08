# ==============================================================================
# Reel Wrapped '25 — 1-Line Windows PowerShell Localhost & Desktop Installer
# Usage: irm https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.ps1 | iex
# ==============================================================================

$ErrorActionPreference = "Stop"
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host " 🎬 REEL WRAPPED '25 • 100% LOCALHOST & DESKTOP LAUNCHER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Magenta

$TargetDir = Join-Path $env:TEMP "reel-wrapped-local"
if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
}

Write-Host "⚡ Cloning prashanth-karanam/reel-wrapped..." -ForegroundColor Yellow
git clone --depth 1 https://github.com/prashanth-karanam/reel-wrapped.git $TargetDir
Set-Location $TargetDir

if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "🦀 Rust toolchain detected! Launching high-speed native Rust engine on http://127.0.0.1:8765..." -ForegroundColor Green
    cargo run --manifest-path rust-engine/Cargo.toml --release
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "📦 Node.js detected! Installing & launching local server on http://localhost:3000..." -ForegroundColor Green
    npm install --no-audit --no-fund
    Start-Process "http://localhost:3000"
    npm run dev
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "🐍 Python detected! Launching local toolkit bridge on http://127.0.0.1:8765..." -ForegroundColor Green
    python -m pip install instagrapi --quiet
    python app.py
} else {
    Write-Host "🌐 Opening standalone local HTML + WASM bundle..." -ForegroundColor Green
    Start-Process (Join-Path $TargetDir "index.html")
}
