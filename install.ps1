# Chronos-Dev One-Liner Installer for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/minKasent/chronos-dev/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

Write-Host "⏱  Installing chronos-dev (Flight Recorder & Code Time Machine)..." -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js / npm is required. Install Node.js (>=18) from https://nodejs.org" -ForegroundColor Red
    exit 1
}

if ($PSScriptRoot -and (Test-Path "$PSScriptRoot\package.json")) {
    Write-Host "📦 Linking local chronos-dev package globally..." -ForegroundColor Yellow
    Push-Location $PSScriptRoot
    npm link
    Pop-Location
} else {
    Write-Host "📦 Installing chronos-dev globally from GitHub (minKasent/chronos-dev)..." -ForegroundColor Yellow
    npm install -g github:minKasent/chronos-dev
}

Write-Host "`n✅ Installed successfully! You can now use 'chronos' or the fast alias 'ch' anywhere:" -ForegroundColor Green
Write-Host "   ch r <cmd>    -> Run command & snapshot code (e.g. ch r npm test)" -ForegroundColor Gray
Write-Host "   ch d          -> Diff current code against --last-green" -ForegroundColor Gray
Write-Host "   ch back       -> Rewind workspace to --last-green" -ForegroundColor Gray
Write-Host "   ch ui --open  -> Open Web Flight Recorder Dashboard" -ForegroundColor Gray
