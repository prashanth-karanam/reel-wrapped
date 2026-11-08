# 🎬 Reel Wrapped '25 — 100% Local Instagram DM Analytics & Wrapped Companion

[![Live Web App](https://img.shields.io/badge/Live_App-GitHub_Pages-FF007A?style=for-the-badge&logo=github)](https://prashanth-karanam.github.io/reel-wrapped/)
[![Engine](https://img.shields.io/badge/Engine-Rust_%2B_WebAssembly-DEA584?style=for-the-badge&logo=rust)](./rust-engine)
[![Android APK](https://img.shields.io/badge/Android-Download_APK-3DDC84?style=for-the-badge&logo=android)](https://github.com/prashanth-karanam/reel-wrapped/releases)

**Reel Wrapped '25** is a privacy-first, **100% local** Instagram DM Reel analytics, multi-account Wrapped card generator, and in-app 9:16 Reel spectator powered by **Rust + WebAssembly**.

---

## ⚡ 1-Line Quick Launch (Localhost / Desktop / Mobile)

### 🪟 Windows PowerShell (1-Line Localhost & Native Engine)
```powershell
irm https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.ps1 | iex
```

### 🍎 macOS / Linux (1-Line Localhost & Native Engine)
```bash
curl -fsSL https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.sh | bash
```

### 🖥️ Electron Desktop App (1-Line Launch)
```bash
git clone https://github.com/prashanth-karanam/reel-wrapped && cd reel-wrapped && npm i && npm run electron
```

### 📲 Android APK & Mobile PWA
- **Download Standalone APK**: Grab `ReelWrapped-v2.4-Android.apk` from [**GitHub Releases**](https://github.com/prashanth-karanam/reel-wrapped/releases).
- **Instant iOS / Android PWA**: Open [**prashanth-karanam.github.io/reel-wrapped**](https://prashanth-karanam.github.io/reel-wrapped/) and tap **📲 Install App** (`Add to Home Screen`).

---

## ✨ Key Features

1. **👥 Start-of-App Multi-User Login & Account Switcher**:
   - Store and switch between multiple Instagram accounts locally in `IndexedDB` / `localStorage`.
   - Connect via live session (`Username + Password` on localhost or `sessionid` cookie), or import official Instagram `message_1.json` exports (with automatic UTF-8 Mojibake emoji decoding).
2. **🎬 In-App 9:16 Reel Spectator (Zero External Redirects)**:
   - Watch shared DM reels directly inside the built-in 9:16 vertical player without opening third-party tabs or mutating read receipts.
3. **🦀 Rust + WebAssembly Telemetry Engine**:
   - Sub-millisecond streak calculation (`compute_streak`), sent/received ratio analysis (`compute_ratio`), and 3 AM Night Owl histograms.
4. **📸 1080×1920 High-DPI Story Card Exporter**:
   - 6 custom themes (*Sunset, Midnight, Cyber, Gold, Dopamine Supermarket Receipt, Brainrot Nutrition Facts*) rendered natively via HTML5 Canvas with Web Share API integration.

---

## 🛡️ Privacy & Security Architecture
- **100% Local Processing**: All DM parsing and analytics run locally on your machine or browser (`IndexedDB`).
- **Zero Cloud Storage**: Credentials and session tokens are never stored in any external database.

## 📄 License
MIT License — Copyright (c) 2025 Prashanth Karanam.
