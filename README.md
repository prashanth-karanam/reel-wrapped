# 🎬 Reel Wrapped (Web UI & Story Engine)

<div align="center">

![License](https://img.shields.io/badge/license-MIT-purple.svg)
![Architecture](https://img.shields.io/badge/architecture-100%25%20Local--First-emerald.svg)
![Privacy](https://img.shields.io/badge/privacy-Zero--Cloud-pink.svg)
![Live Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue.svg)

**The complete, high-craft mobile web application for Instagram DM Reel analytics, inbox leaderboards, friend dossiers, and viral 9:16 Instagram Story card exports.**

[**🚀 View Live Web Demo**](https://prashanth-karanam.github.io/reel-wrapped/)

---

</div>

## ✨ Features

- 🏆 **Inbox Velocity & Leaderboard:**
  - Ranked inbox friends with tier medals, streak badges, and sent-vs-received ratio split bars.
  - Interactive filter chips: *All Friends*, *🔥 Longest Streaks (>30d)*, *🌙 Night Owls (>75%)*, and *⚖️ 50/50 Balanced*.
  - Instant live search by friend name, handle, or favorite hashtag.

- 📊 **Deep Friend Dossier & Personalization:**
  - **Dynamic Relationship Archetypes:** *Unhinged 3 AM Curators*, *Symmetrical Aesthetic Archivists*, *Sporadic Meme Bombers*, and *Lurking Speed-Demons*.
  - **Symmetry Donut Chart:** Dynamic SVG ring visualizing exact sent-vs-received balance.
  - **Response Reflex Latency:** Millisecond/second measurement of average reaction velocity.
  - **Emoji Reaction Chemistry:** Ranked reaction matrix (`💀`, `😭`, `🔥`) with interactive counters.
  - **Hashtag DNA Cloud:** Micro-niche topic tags (`#brainrot`, `#shitpost`, `#archdigest`, `#indierock`).
  - **Top Viral Soundtracks:** Recurring music tracks with simulated playback equalizer waves.
  - **3 AM Night Owl Quotient:** Hourly histogram charting late-night doomscroll spikes.

- 📱 **Viral 9:16 Instagram Story Card Generator:**
  - Authentic 9:16 aspect ratio canvas ready for direct story exports.
  - Live Theme Switcher: *Sunset Glow*, *Midnight AMOLED*, *Cyber Neon*, and *Royal Gold*.
  - Dynamic badges: Top 0.8% Global Tier, Savage Streak, Night Owl Score, and Top Niche.
  - One-click *Share to Instagram Story* intent simulation (`com.instagram.share.ADD_TO_STORY`) and lossless SVG export.

- 🔒 **Zero-Cloud Local Vault:**
  - **Air-Gapped Guarantee:** User's device acts as its own server. Zero telemetry or credentials ever hit remote servers.
  - Ephemeral RAM password handling with instant memory zeroization.
  - Biometric Hardware KeyStore switch with animated status toggling.
  - Local SQLite database inspector with JSON export and cache purge.

---

## 🎨 UI Architecture

- **Styling:** Tailwind CSS via CDN with customized design tokens.
- **Typography:** *Plus Jakarta Sans* + *JetBrains Mono*.
- **Iconography:** Pure self-contained inline SVG paths (no missing font ligatures, zero external dependencies).
- **Navigation:** Persistent native bottom-docked navigation tabs (`Rank`, `Dossier`, `Export`, `Vault`).
- **Responsiveness:** Fluid container designed for iOS & Android mobile viewports and desktop previews.

---

## 🚀 Running Locally

Simply open `index.html` in any web browser, or serve it with Python:

```bash
# Clone the repository
git clone https://github.com/prashanth-karanam/reel-wrapped.git
cd reel-wrapped

# Run a local HTTP server
python -m http.server 8000
```

Navigate to `http://localhost:8000` in your browser.

---

## 📄 License

MIT © [Prashanth Karanam](https://github.com/prashanth-karanam)
