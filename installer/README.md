# Lakky installer

Custom Windows installer built with [Inno Setup 6.3+](https://jrsoftware.org/isdl.php).

## What it ships

- The full Electrobun bundle (launcher, bun, native deps, app code) — **all self-contained, no runtime downloads**.
- Start Menu shortcut + optional Desktop shortcut + optional Quick Launch.
- Optional file associations for the common audio (`.mp3 .flac .m4a .ogg .opus .wav .aac`) and video (`.mp4 .mkv .webm .mov .avi`) formats — double-clicking a song opens it in Lakky.
- A **Music library folder** picker page (defaults to `Documents\Lakky`) that pre-seeds Lakky's settings — the app starts already knowing where to keep imports.
- Branded welcome / finish pages with the Lakky purple-to-cyan gradient + the real app icon.
- Uninstaller entry in *Add or Remove Programs*.

## One-time setup

1. Install Inno Setup 6.3+: <https://jrsoftware.org/isdl.php>
   It's free and the installer is ~5 MB. The compiler executable lands at
   `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`.

## Build the installer

From the repo root:

```powershell
PowerShell -ExecutionPolicy Bypass -File installer\build.ps1
```

The script does three things:

1. `bun run build` — Vite + Electrobun produce `build\win-x64\Lakky\`.
2. `bun installer\make-wizard-images.ts` — re-renders `wizard-side.png` (164×314) and `wizard-small.png` (55×58) from `assets\icon-source.jpg` using sharp.
3. `ISCC.exe installer\lakky.iss` — compiles the LZMA2-ultra installer.

Output: `artifacts\Lakky-Setup-1.0.0.exe` — a single .exe to distribute.

## Files

| File | Purpose |
| ---- | ------- |
| `lakky.iss` | Inno Setup script (pages, tasks, registry, file associations) |
| `make-wizard-images.ts` | Sharp script that renders the two PNGs the wizard uses |
| `build.ps1` | Orchestration: bun build → wizard images → iscc |
| `wizard-side.png` *(generated)* | 164×314 left-side branding panel |
| `wizard-small.png` *(generated)* | 55×58 top-right page icon |

## Customizing the wizard branding

Edit `assets\icon-source.jpg` (or replace it entirely) and re-run
`bun installer\make-wizard-images.ts`. The gradient backdrop in
`make-wizard-images.ts` can be tuned — search for "gradient(w, h)" and adjust
the RGB lerp endpoints.

## What gets written to disk

| Location | Why |
| -------- | --- |
| `%ProgramFiles%\Lakky\` *(or wherever the user picks)* | The app bundle |
| `%APPDATA%\Lakky\state.json` | First-run config — `libraryFolder` is pre-set from the wizard's Music folder page. Skipped if the file already exists (re-installer scenario). |
| `%APPDATA%\Lakky\art\` | Cover-art cache, created by Lakky on first import |
| `%APPDATA%\Lakky\discord-cover-cache.json` | Discord cover-art URL cache, created on first Discord push |
| Start Menu `\Programs\Lakky\` | Shortcuts |
| `HKCU\Software\Classes\Lakky.AudioFile`, `Lakky.VideoFile` *(if user opts in)* | File associations |

## Uninstall

Uses Inno Setup's built-in uninstaller. Removes:
- The app folder
- Start Menu group + Desktop + Quick Launch shortcuts
- File-association registry entries

It deliberately leaves the user's `%APPDATA%\Lakky\` folder (state.json,
playlists, cover-art cache) alone — those are the user's data. To wipe
everything, delete that folder manually after uninstall.

## Notes on offline-ness

Lakky is fully offline at runtime. The installer is offline too — every file
shipped is in the bundle. The **only** network calls Lakky makes are:

- **Discord cover art lookup** — one HTTPS GET per unique album, cached
  forever to `%APPDATA%\Lakky\discord-cover-cache.json`. Disable via the
  Discord toggle in Settings if you want strict offline.
- **Google Fonts** — the renderer loads "Plus Jakarta Sans" and "Space
  Grotesk" via Google's CDN once per machine. To kill that, replace the
  `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` tags in
  `src/mainview/index.html` + `mini.html` with self-hosted webfont files.

No telemetry, no analytics, no update check.
