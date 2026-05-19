# Builds a distributable Lakky installer end-to-end.
#
#   1. Bundles the renderer + Bun main process via `bun run build`
#       → output: build/win-x64/Lakky/
#   2. Re-renders the wizard branding images.
#   3. Invokes the Inno Setup compiler.
#       → output: artifacts/Lakky-Setup-1.0.0.exe
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
    Write-Host "==> 1/3  Building the Lakky bundle (vite + electrobun)" -ForegroundColor Cyan
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "bun run build failed" }

    Write-Host ""
    Write-Host "==> 2/3  Re-rendering wizard images" -ForegroundColor Cyan
    & bun installer\make-wizard-images.ts
    if ($LASTEXITCODE -ne 0) { throw "make-wizard-images failed" }

    Write-Host ""
    Write-Host "==> 3/3  Compiling installer with Inno Setup" -ForegroundColor Cyan
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
    Write-Host "==> Done. Installer at artifacts\Lakky-Setup-1.0.0.exe" -ForegroundColor Green
} finally {
    Pop-Location
}
