# LAK Player

A fast, modern desktop media player built on **Electrobun + Bun**. It plays just about any audio or video file you throw at it, with a stack of features inspired by the most-loved Spotify mods.

## Features

### Core playback
- Plays nearly any audio or video file the OS webview supports (`mp3`, `flac`, `m4a`, `wav`, `ogg`, `opus`, `mp4`, `mkv`, `webm`, `mov`, `avi`, `wmv`, and more — universal extension allow-list under `src/bun/library.ts`)
- Range-streamed from a local Bun HTTP server, so seek/scrub is instant on huge files
- 10-band parametric equalizer with presets (Flat, Bass Boost, Treble Boost, Vocal, Lo-Fi, Electronic, Classical, Loudness)
- Web Audio API graph: `<audio>`/`<video>` → 10x BiquadFilter → Gain → Analyser → output
- Smooth fade-out on sleep timer

### UI / UX
- Glassmorphic dark UI with animated gradient backdrop
- Welcome / loading screen with floating orbs + animated logo
- Album-art-driven accent color: the ambient glow shifts to match each track's cover
- Vinyl-spin animation on the now-playing art
- Spectrum visualizer (canvas + AnalyserNode) on the Now Playing view
- Hover micro-interactions: card lift, glow follow, button scale
- Synthesized UI sound effects via Web Audio API (click, hover, play, pause, skip, toggle, success, error)
- Soft toast notifications

### Spotify-mod inspired features
- **True shuffle / shuffle toggle** persisted across sessions
- **Repeat off / all / one** (with the classic "1" overlay)
- **Sleep timer** (5/10/15/30/45/60/90/120 min, with gentle 3-second fade-out)
- **Crossfade slider** in settings (UI; gapless fader hook ready)
- **Equalizer presets** (8 built-in + Custom)
- **Most-played** section on Home, driven by per-track play counts
- **Playlists** (create, persist, play)
- **Queue side panel** with click-to-jump
- **Search** across title / artist / album
- **Hotkeys**: Space (play/pause), ←/→ (±5s), Ctrl+←/→ (prev/next), ↑/↓ (volume)
- **Discord Rich Presence** with paused/playing icon, elapsed-time bar, track + album text

### Library folder
- Settings → **Library folder**: pick a drive/folder once
- Every file you import is copied there, organized as `Artist / Album / Title.ext`
- Files already inside the library folder are referenced in place (no duplicate copy)
- Same-named files with different content get an auto-incrementing suffix (`Song (2).mp3`)
- "Open in Explorer" button to jump straight to the folder

### Native integration
- Native open-file / open-folder dialogs (Electrobun's `Utils.openFileDialog`)
- Native notifications via Electrobun's `Utils.showNotification`
- Persistent settings, library, playlists, and play-stats stored as JSON in the app data dir
- **Custom frameless titlebar** with logo + minimize/maximize/close buttons (Windows-style hover, red-on-close)
- **Native window controls** wired through Electrobun RPC: minimize, maximize-toggle, close, fullscreen
- **Windows SMTC integration** via the Media Session API — track info appears in the media flyout, hardware media keys (▶ ⏸ ⏮ ⏭) and headphone buttons control playback
- **Taskbar icon** generated procedurally from `assets/icon.ico` and embedded into the launcher via the `postBuild` script
- **16:9 aspect ratio** initial window (1280×720) that fits cleanly on a 1080p screen

## Quick start

```sh
bun install
bun run start          # production build of the renderer + launch Electrobun
# or
bun run dev:hmr        # Vite HMR + Electrobun watch
```

## Discord Rich Presence

LAK Player uses the Discord application id **`1505585532179054744`** by default. Just open the Discord application's developer portal at <https://discord.com/developers/applications/1505585532179054744/rich-presence/assets> and upload these images under **Rich Presence → Art Assets**:

| Key          | Used as     | Recommended size | Purpose                                            |
| ------------ | ----------- | ---------------- | -------------------------------------------------- |
| `lak_logo`   | Large image | 1024×1024 PNG    | The big tile shown next to the activity            |
| `play`      | Small image | 512×512 PNG      | Overlay shown while a track is playing             |
| `pause`     | Small image | 512×512 PNG      | Overlay shown while playback is paused             |

Asset keys must be lowercase and match exactly. After upload, Discord can take up to ~10 minutes to propagate the assets. Until then the *text* fields (track / artist / album / elapsed-time bar) still appear — the images just won't.

LAK Player talks the Discord IPC protocol directly (it does **not** depend on the `discord-rpc` npm package, which hangs under Bun on Windows). Set `LAK_DISCORD_DEBUG=1` to see every IPC frame in the console — useful if something looks off:

```sh
LAK_DISCORD_DEBUG=1 bun run start
```

You can also run a one-shot diagnostic that connects, posts a test activity, and exits:

```sh
bun scripts/test-discord.ts
```

To use your own Discord application instead, set:

```sh
LAK_DISCORD_CLIENT_ID=<your_client_id> bun run start
```

The Discord desktop client must be running locally for the IPC handshake. The **Discord rich presence** toggle in Settings turns RPC on/off.

## Project layout

```
electrobun.config.ts        # Electrobun app config (id, build options, icon, postBuild)
vite.config.ts              # Vite config (Tailwind + renderer entry)
assets/
  logo.svg                  # In-app LAK logo (SVG)
  icon.ico                  # Windows taskbar / .exe icon (multi-size)
  icon-256.png              # PNG fallback for Linux
scripts/
  make-icon.ts              # Procedurally renders the logo and writes assets/icon.ico
  embed-icon.ts             # Stamps assets/icon.ico into the built launcher.exe
src/
  shared/rpcSchema.ts       # Shared RPC types between main and renderer
  bun/                      # Main process (Bun)
    index.ts                # BrowserWindow, RPC handlers, Discord wiring, window ctrl
    library.ts              # Metadata extraction, folder walk, id<->path map
    mediaServer.ts          # Local Bun.serve range-streaming server
    discord.ts              # discord-rpc client with auto-reconnect (client id baked in)
  mainview/                 # Renderer
    index.html              # Custom titlebar + splash + app mount
    main.ts                 # App entry: state, views, transport, hotkeys, MediaSession
    audio.ts                # AudioEngine with Web Audio EQ + analyser
    visualizer.ts           # Canvas spectrum visualizer (bars + strip modes)
    sfx.ts                  # Synthesized UI SFX
    logo.ts                 # Inline SVG logo for splash, titlebar, sidebar
    style.css               # Tailwind + custom CSS, frameless titlebar styles
```

## Building a distributable

```sh
bun run build
```

Electrobun produces a self-extracting bundle in `build/`. See [Electrobun docs](https://blackboard.sh/electrobun/docs/) for cross-platform packaging.

## Tech stack

- **Electrobun 1.18** — fast desktop runtime with system webview + Bun main process
- **Bun 1.3** — runtime, package manager, HTTP server for media streaming
- **Tailwind CSS 4** — utility CSS layered over a custom theme
- **Vite 6** — renderer bundler
- **music-metadata** — ID3 / Vorbis / FLAC / MP4 tag extraction
- **discord-rpc** — Discord IPC client
- **Web Audio API** — EQ, gain, analyser, and synthesized SFX
- **TypeScript** everywhere
