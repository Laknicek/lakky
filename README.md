# Lakky Player

<p align="center">
  <img src="assets/icon-source.jpg" alt="Lakky Player Banner" width="180" style="border-radius: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.6);" />
</p>

<p align="center">
  <strong>Next-Generation Desktop Media Player with 2026 Anime Cel-Shaded 3D Visuals & WebAudio DSP Engine</strong>
</p>

<p align="center">
  <a href="https://github.com/Laknicek/lakky/releases"><img src="https://img.shields.io/badge/version-1.0.3-a78bfa.svg?style=for-the-badge&logo=github" alt="Version 1.0.3" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun_1.3-fbf0df.svg?style=for-the-badge&logo=bun&logoColor=black" alt="Bun 1.3" /></a>
  <a href="https://blackboard.sh/electrobun"><img src="https://img.shields.io/badge/framework-Electrobun_1.18-22d3ee.svg?style=for-the-badge" alt="Electrobun" /></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/styling-Tailwind_v4-38bdf8.svg?style=for-the-badge&logo=tailwindcss" alt="Tailwind CSS v4" /></a>
  <a href="https://threejs.org"><img src="https://img.shields.io/badge/3D_Engine-Three.js_WebGL-black.svg?style=for-the-badge&logo=three.js" alt="Three.js" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-emerald.svg?style=for-the-badge" alt="License MIT" /></a>
</p>

---

## What is Lakky?

**Lakky Player** is a modern, lightweight desktop media player built for speed, sound quality, and visual atmosphere. Built on **Electrobun** (native OS webview shell) and **Bun** (high-throughput JavaScript runtime), Lakky delivers instant startup and smooth playback with low memory usage.

Under the hood, Lakky combines real-time **WebAudio DSP effect graphs**, deep **Binary Anti-Malware / Polyglot integrity inspection**, and a GPU-accelerated **2026 Anime Cel-Shaded 3D environment** inspired by modern anime shaders (Genshin, Makoto Shinkai, Studio Ghibli, and Christian Ortiz's `stylized-components`).

Whether you are listening to high-res FLAC files, watching 4K MKV anime, experimenting with 8D spatial sound, or enjoying reactive 3D ocean waves and cherry blossoms in sync with your beats, Lakky is built to be the best everyday desktop media player.

---

## 3D Anime Cel-Shaded Audio-Reactive World

Lakky features a real-time 3D stylized WebGL environment running directly in the background or during Now Playing playback:

```
+-------------------------------------------------------------------------+
| [3D Cel-Shaded Skybox & Sun/Moon Aura]                                  |
|                                                                         |
|            ( ( Floating Sakura Petals & Embers ) )                      |
|                                                                         |
|      /\_/\_      [Stylized Ghibli Trees & Fluffy Foliage]    /\_/\_     |
|     /       \            /|  /|  /|                         /       \   |
|    / Islands \          / | / | / |                        / Islands \  |
| ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ |
| ~~~~~~~~~ [3-Tier Cel-Shaded Gerstner Ocean with Foam Crests] ~~~~~~~~~ |
| ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ |
+-------------------------------------------------------------------------+
```

### Custom GLSL Shaders & Physics
- **Cel-Shaded Ocean & Water**: Multi-layer Gerstner waves with stepped color bands (from deep indigo to shallow turquoise cyan), procedural caustics, and crisp manga specular glints. Bass kicks physically displace wave heights in real time.
- **Fluffy Anime Trees & Foliage**: Normal-mapped dodecahedron clusters creating soft Ghibli-style leaf clumps with wind vertex displacement. Mid frequencies drive tree sway and leaf cadence.
- **Sakura Petal Physics**: Procedural particle simulation with curl-noise flutter, turbulence, and gravity resets. Treble transients make celestial particles and fireflies burst.
- **4 Curated 2026 Scene Presets**:
  1. **Sakura Sunset**: Cherry blossom grove overlooking glowing pink/lavender sunset waters.
  2. **Ocean Shinkai**: Deep Makoto Shinkai midnight ocean beneath starlight and radiant ripples.
  3. **Cyber Lake**: Neon cyan and hot magenta cybernetic waters reflecting modern Tokyo nights.
  4. **Ghibli Forest**: Daylight emerald meadow with crystalline stream and floating particles.

---

## Built-In Binary Anti-Malware & Polyglot Armor

Media players often execute untrusted files downloaded from the web. Lakky includes a built-in **Zero-Trust File Integrity Engine** (`src/bun/security.ts`) that runs on every ingested file before decoding or streaming:

```
  Incoming Media File
          │
          ▼
┌───────────────────────────────────────────────────────────┐
│ 1. Magic Header vs Extension Inspection                   │
│    Detects disguised .exe, .scr, .bat, .ps1, .vbs, .lnk,  │
│    .cpl, .dll, .pif, .elf, .macho renamed to .mp3/.mp4    │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ 2. Polyglot & Steganography Signature Scanner             │
│    Scans ID3v2 padding, MP4 atoms (moov/mdat), and RIFF   │
│    chunks for hidden PE stubs (MZ/PE) or ZIP polyglots   │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ 3. Shannon Entropy & Obfuscation Analysis                 │
│    Detects anomalous packed shellcode in non-media chunks │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ 4. Metadata Sanitizer & XSS Defenses                      │
│    Neutralizes path traversal, null bytes, HTML scripts,  │
│    and dangerous control codes in tags & lyrics           │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
             [Safe Stream & Badge Assigned]
```

- **In-App Security Badges**: Clean tracks display a green `Verified Safe` shield. Files with header mismatches or embedded anomalies display a caution/alert badge with an interactive audit modal.
- **1-Click Library Audit**: Run a full security and integrity check across your entire music collection at any time.

---

## Infinite Format & Codec Support

Lakky supports a vast catalog of audio and video containers without external plugins:

| Category | Supported Extensions & Formats |
| :--- | :--- |
| **Lossless & Hi-Res Audio** | `.flac`, `.wav`, `.wave`, `.aiff`, `.aif`, `.alac`, `.ape` (Monkey's Audio), `.wv` (WavPack), `.dsd`, `.dsf`, `.dff`, `.tak`, `.tta`, `.caf` |
| **Standard & Compressed Audio** | `.mp3`, `.m4a`, `.aac`, `.opus`, `.ogg`, `.oga`, `.wma`, `.mka`, `.mp2`, `.mp1`, `.amr`, `.ac3`, `.dts`, `.eac3`, `.spx`, `.ra`, `.au`, `.snd` |
| **Tracker & Synthesizer Formats** | `.mid`, `.midi`, `.mod`, `.xm`, `.s3m`, `.it` |
| **Video Containers** | `.mp4`, `.m4v`, `.mkv` (Matroska), `.webm`, `.mov`, `.avi`, `.wmv`, `.flv`, `.f4v`, `.mpg`, `.mpeg`, `.m2v`, `.3gp`, `.3g2`, `.ts`, `.mts`, `.m2ts`, `.ogv`, `.vob`, `.rm`, `.rmvb`, `.asf`, `.divx`, `.wtv`, `.dvr-ms` |

### 1-Click Windows Default Player Setup
Set Lakky as your default media player for all 60+ audio and video file formats in Windows with a single button in Settings. Lakky also registers the `lakky://` protocol for opening and playing links.

---

## 8D Spatial Audio & Modular DSP Node Graph

Beyond the standard 10-band equalizer, Lakky features a full visual **Audio Node Graph Editor**:

- **8D Binaural Rotating Soundstage**: Simulates sound moving smoothly around your head with HRTF curve modeling and distance Doppler shifts.
- **Anime Lo-Fi Tape Saturator**: Warms up digital tracks with gentle harmonic saturation, tape wow/flutter, and subtle vinyl dust.
- **Crystal Vocal Enhancer**: Multi-band exciter tuned for clarity in anime OSTs, J-Pop vocals, and dialogue.
- **Dynamic Bass Exciter**: Psychoacoustic sub-harmonic generator for deep punch without distortion.
- **Concert Hall Reverb**: Algorithmic reverb engine with procedural impulse response decay convolution.
- **Compressor, Filters & Parametric EQ**: Studio-grade dynamic range compressor, lowpass, highpass, bandpass, notch, and peaking filters.

---

## Seamless In-App Auto-Updater

- **Automatic Background Checks**: Checks GitHub releases against your current version.
- **Stable & Canary Release Channels**: Switch between stable production releases and early canary builds.
- **In-App Progress & Telemetry**: Live download bar with transfer speed (MB/s), estimated time remaining (ETA), and bytes received.
- **SHA-256 Verification**: Computes the SHA-256 hash of the downloaded installer to confirm integrity before running.
- **One-Click Restart**: Installs silently (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`) and relaunches the app smoothly.

---

## 2026 Cel-Shaded Anime Themes

Choose from 9 custom color themes built with Tailwind v4 and CSS variables:

- **Sakura Sunset**: Pastel pink, cherry blossom rose, warm amber, and lilac mist.
- **Cyber NeoTokyo**: Electric cyan, hot magenta, deep obsidian, and neon purple.
- **Ghibli Emerald**: Lush meadow green, forest emerald, sky blue, and cream gold.
- **Ocean Shinkai**: Deep Makoto Shinkai indigo, azure waves, and starry cyan.
- **Midnight Shogun**: Dark ink, crimson glow, gold leaf, and smoked slate.
- **Midnight**: Deep violet, cyan electric highlights.
- **Aurora**: Cyan and teal gradient glow.
- **Solar**: Warm orange and crimson sunrise.
- **Rose**: Hot pink and magenta neon.
- **Dynamic Art Matching**: Automatically extracts the dominant accent color from current album artwork.

---

## Synced Karaoke Lyrics, Mobile Remote & Discord RPC

- **Synced Karaoke Lyrics**: Millisecond-accurate word/line highlighting with automatic LRCLIB matching and offline disk cache.
- **Mobile Web Remote PWA**: Control playback, seek, change volume, and view album art from your phone or tablet on your local Wi-Fi with QR code pairing.
- **Discord Rich Presence**: Native raw IPC pipe integration displaying your currently playing track, elapsed time, and high-res artwork.
- **A-B Loop Repeat**: Loop any segment of a song with single-key triggers (`B`).
- **Lakky Echoes**: Fullscreen year-in-review visual experience with stats, top tracks, and genre breakdowns.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `Ctrl + Right` / `Ctrl + Left` | Next / Previous Track |
| `Right` / `Left` | Seek Forward / Backward (5s) |
| `Up` / `Down` | Volume Up / Down (5%) |
| `M` | Toggle Mute |
| `S` | Toggle Shuffle |
| `R` | Cycle Repeat Mode (Off / All / One) |
| `B` | Set A-B Loop Points / Clear Loop |
| `F` / `F11` | Toggle Fullscreen |
| `Ctrl + K` / `Ctrl + F` | Focus Library Search |
| `1` - `8` | Switch Main Views (Home, Library, Now Playing, EQ, Playlists, Stats, Nodes, Settings) |
| `Esc` | Close Modals / Exit Fullscreen |

---

## Building from Source

### Prerequisites
- [Bun](https://bun.sh) (v1.3.0 or higher)
- Windows 10/11, macOS, or Linux

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Laknicek/lakky.git
cd lakky

# Install dependencies
bun install

# Run Vite dev server with Hot Module Replacement (HMR)
bun run dev:hmr

# Build production executable
bun run build
```

The output binaries and installer scripts are generated in `build/` and `installer/`.

---

## Architecture Overview

```
lakky/
├── src/
│   ├── bun/                    # Backend Process (Bun Runtime)
│   │   ├── index.ts            # Main process entrypoint & window management
│   │   ├── security.ts         # Binary integrity & anti-malware scanner
│   │   ├── systemIntegration.ts# Windows default player & file associations
│   │   ├── library.ts          # Media scanner, metadata parsing & art cache
│   │   ├── updater.ts          # Auto-updater with SHA-256 verification
│   │   ├── mediaServer.ts      # Local zero-copy range streaming server
│   │   ├── discord.ts          # Raw IPC pipe Discord Rich Presence
│   │   ├── webRemote.ts        # Mobile LAN web remote HTTP server
│   │   └── lyrics.ts           # Synced lyrics fetcher & parser
│   ├── mainview/               # Frontend UI Viewport
│   │   ├── main.ts             # Primary UI controller, router & player state
│   │   ├── stylized3d.ts       # Three.js 3D Anime Cel-Shaded Scene Engine
│   │   ├── visualizer.ts       # 2D canvas FFT spectrum & waveform visualizer
│   │   ├── audio.ts            # WebAudio AudioEngine with crossfade & pre-amp
│   │   ├── nodes.ts            # Modular DSP audio effect graph compiler
│   │   ├── nodeEditor.ts       # Interactive node graph drag-and-drop editor
│   │   ├── nodeTemplates.ts    # Curated DSP presets (8D, Lo-Fi, Reverb)
│   │   ├── echoes.ts           # Year-in-review visual timeline
│   │   ├── sfx.ts              # Synthesized WebAudio UI soundscapes
│   │   └── style.css           # 2026 Anime Cel-Shaded themes & Tailwind v4
│   └── shared/
│       └── rpcSchema.ts        # Type-safe RPC contracts between Bun and Webview
├── electrobun.config.ts        # Desktop window & build configuration
├── package.json
└── tsconfig.json
```

---

## License

Released under the [MIT License](LICENSE). Built with Electrobun, Bun, Three.js, and Tailwind CSS.
