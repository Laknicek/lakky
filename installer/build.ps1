# Builds a distributable Lakky installer end-to-end.
#
#   1. Bundles the renderer + Bun main process via `bun run build`
#       → output: build/stable-win-x64/Lakky/ (SFX form — not directly runnable)
#   2. Unpacks Lakky-Setup.tar.zst over Lakky/ to materialize the actual
#      runtime layout (real launcher.exe, bun.exe, WebView2Loader.dll, etc).
#      Electrobun's stable build ships the launcher as a self-extractor that
#      expects the tar.zst appended to its own .exe — Inno Setup can't ship
#      that, so we extract here instead.
#   3. Re-runs embed-icon against the newly-extracted launcher so the
#      taskbar icon sticks on the binary that actually ships.
#   4. Re-renders the wizard branding images.
#   5. Invokes the Inno Setup compiler.
#       → output: artifacts/Lakky-Setup-X.Y.Z.exe (X.Y.Z = MyAppVersion in lakky.iss)
#
# Prerequisite (one-time):
#   Install Inno Setup 6.3 or newer from https://jrsoftware.org/isdl.php
#   The compiler `iscc.exe` lands under Program Files\Inno Setup 6\.
#
# Run from the repo root:
#   PowerShell -ExecutionPolicy Bypass -File installer\build.ps1

$ErrorActionPreference = "Stop"

$root = Resolve-Path "$PSScriptRoot\.."
Push-Location $root

try {
    Write-Host ""
    Write-Host "==> 1/5  Building the Lakky bundle (vite + electrobun)" -ForegroundColor Cyan
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "bun run build failed" }

    Write-Host ""
    Write-Host "==> 2/5  Materializing the runtime layout from Lakky-Setup.tar.zst" -ForegroundColor Cyan
    $stableDir = "build\stable-win-x64"
    $tarZst = Join-Path $stableDir "Lakky-Setup.tar.zst"
    $lakkyDir = Join-Path $stableDir "Lakky"
    if (-not (Test-Path $tarZst)) {
        throw "Missing $tarZst. Did `bun run build` succeed with --env=stable?"
    }
    # Wipe the SFX-form Lakky/ so we start from a clean slate.
    if (Test-Path $lakkyDir) { Remove-Item -Recurse -Force $lakkyDir }

    $zstd = "node_modules\electrobun\dist-win-x64\zig-zstd.exe"
    if (-not (Test-Path $zstd)) { throw "Missing $zstd (shipped with electrobun)." }

    $tmpTar = Join-Path $env:TEMP "Lakky-Setup-$([guid]::NewGuid()).tar"
    try {
        & $zstd decompress -i $tarZst -o $tmpTar --no-timing
        if ($LASTEXITCODE -ne 0) { throw "zstd decompress failed" }
        # Use Windows' built-in bsdtar by absolute path so we don't pick up
        # Git-bash's tar (which mangles `E:\` paths into hostnames). bsdtar
        # has shipped with Windows since 1809.
        $winTar = Join-Path $env:SystemRoot "System32\tar.exe"
        if (-not (Test-Path $winTar)) { throw "Missing $winTar (Windows bsdtar)." }
        & $winTar -xf $tmpTar -C $stableDir
        if ($LASTEXITCODE -ne 0) { throw "tar extract failed" }
    } finally {
        if (Test-Path $tmpTar) { Remove-Item -Force $tmpTar }
    }

    Write-Host ""
    Write-Host "==> 3/5  Re-embedding the app icon into the runtime launcher" -ForegroundColor Cyan
    & bun scripts\embed-icon.ts
    if ($LASTEXITCODE -ne 0) { throw "embed-icon failed" }

    Write-Host ""
    Write-Host "==> 4/5  Re-rendering wizard images" -ForegroundColor Cyan
    & bun installer\make-wizard-images.ts
    if ($LASTEXITCODE -ne 0) { throw "make-wizard-images failed" }

    Write-Host ""
    Write-Host "==> 5/5  Compiling installer with Inno Setup" -ForegroundColor Cyan
    $iscc = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) {
        throw "ISCC.exe not found. Install Inno Setup 6.3+ from https://jrsoftware.org/isdl.php"
    }
    & $iscc "installer\lakky.iss"
    if ($LASTEXITCODE -ne 0) { throw "iscc failed" }

    Write-Host ""
    $built = Get-ChildItem "artifacts\Lakky-Setup-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Host "==> Done. Installer at $($built.FullName)" -ForegroundColor Green
} finally {
    Pop-Location
}
